package engine

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Bootstrap struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	InstanceID string `json:"instanceId"`
	URL        string `json:"url"`
	Token      string `json:"token"`
	Created    bool   `json:"created"`
}

func proof(token, instance, nonce string) string {
	m := hmac.New(sha256.New, []byte(token))
	m.Write([]byte(instance + "\x00" + nonce))
	return hex.EncodeToString(m.Sum(nil))
}
func metaPath(dir string) string { return filepath.Join(dir, "runtime.dpapi") }
func storeMeta(dir string, b Bootstrap) error {
	plain, _ := json.Marshal(b)
	data, err := protect(plain, false)
	if err != nil {
		return err
	}
	return os.WriteFile(metaPath(dir), data, 0600)
}
func readMeta(dir string) (Bootstrap, error) {
	var b Bootstrap
	data, err := os.ReadFile(metaPath(dir))
	if err != nil || len(data) > 32768 {
		return b, errors.New("runtime metadata unavailable")
	}
	plain, err := protect(data, true)
	if err != nil {
		return b, err
	}
	err = json.Unmarshal(plain, &b)
	if err != nil || b.Name != "daming-gateway" || b.Version != "1" || len(b.Token) != 64 || len(b.InstanceID) != 64 || !strings.HasPrefix(b.URL, "http://127.0.0.1:") {
		return Bootstrap{}, errors.New("invalid runtime identity")
	}
	return b, nil
}
func checkRuntime(b Bootstrap) bool {
	parsed, err := url.Parse(b.URL)
	if err != nil || parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 {
		return false
	}

	nonce := ID()
	client := http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect") }}
	resp, err := client.Get(b.URL + "/internal/challenge?nonce=" + nonce)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var x struct {
		InstanceID string `json:"instanceId"`
		Proof      string `json:"proof"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&x) != nil || x.InstanceID != b.InstanceID || !hmac.Equal([]byte(x.Proof), []byte(proof(b.Token, b.InstanceID, nonce))) {
		return false
	}
	req, _ := http.NewRequest("GET", b.URL+"/internal/health", nil)
	req.Header.Set("Authorization", "Bearer "+b.Token)
	r, err := client.Do(req)
	if err != nil {
		return false
	}
	defer r.Body.Close()
	var h struct {
		Name, Version string
		BuildID       string `json:"buildId"`
		InstanceID    string `json:"instanceId"`
		Revision      string `json:"upstreamRevision"`
	}
	return r.StatusCode == 200 && json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&h) == nil && h.Name == "daming-gateway" && h.Version == "1" && h.BuildID == BuildID && h.InstanceID == b.InstanceID && h.Revision == Revision
}
func Ensure(dir string) (Bootstrap, error) {
	if err := EnsureDir(dir); err != nil {
		return Bootstrap{}, err
	}
	var lock *Lock
	var err error
	until := time.Now().Add(10 * time.Second)
	for time.Now().Before(until) {
		lock, err = AcquireLock(filepath.Join(dir, "startup.lock"))
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return Bootstrap{}, errors.New("gateway startup busy")
	}
	defer lock.Close()
	if b, err := readMeta(dir); err == nil && currentImage(dir) && checkRuntime(b) {
		b.Created = false
		return b, nil
	}
	probe, err := AcquireLock(filepath.Join(dir, "engine.lock"))
	if err != nil {
		return Bootstrap{}, errors.New("existing runtime could not be authenticated")
	}
	probe.Close()
	exe, err := os.Executable()
	if err != nil {
		return Bootstrap{}, err
	}
	log, err := os.OpenFile(filepath.Join(dir, "engine.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return Bootstrap{}, err
	}
	defer log.Close()
	cmd := exec.Command(exe, "serve", "--data-dir", dir)
	cmd.Stdin = nil
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000208}
	if err = cmd.Start(); err != nil {
		return Bootstrap{}, errors.New("engine launch failed")
	}
	until = time.Now().Add(10 * time.Second)
	for time.Now().Before(until) {
		if b, err := readMeta(dir); err == nil && currentImage(dir) && checkRuntime(b) {
			cmd.Process.Release()
			b.Created = true
			return b, nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	cmd.Process.Kill()
	cmd.Wait()
	return Bootstrap{}, errors.New("engine readiness deadline")
}
func Serve(dir string) error {
	if err := EnsureDir(dir); err != nil {
		return err
	}
	lock, err := AcquireLock(filepath.Join(dir, "engine.lock"))
	if err != nil {
		return err
	}
	defer lock.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	token := ID()
	e := New(token, func() (string, error) { return LoadKey(dir) })
	exeImage, _ := os.Executable()
	if err := os.WriteFile(filepath.Join(dir, "image.path"), []byte(exeImage), 0600); err != nil {
		return err
	}
	b := Bootstrap{"daming-gateway", "1", e.InstanceID, "http://" + listener.Addr().String(), token, false}
	if err = storeMeta(dir, b); err != nil {
		return err
	}
	server := http.Server{Handler: e, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 10 * time.Second, MaxHeaderBytes: 8192}
	return server.Serve(listener)
}

func currentImage(dir string) bool {
	b, err := os.ReadFile(filepath.Join(dir, "image.path"))
	if err != nil || len(b) > 32768 {
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	a, err := os.Stat(exe)
	if err != nil {
		return false
	}
	other, err := os.Stat(string(b))
	return err == nil && os.SameFile(a, other)
}
