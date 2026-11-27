package engine

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/yetone/magpie/internal/stream"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const BuildID = "embedded-v3"

const Revision = "1615e5a149acbaed6e9395ddb9775f96d95e4728"
const UpstreamURL = "https://api.deepseek.com/chat/completions"

type Prepare struct {
	RequestID       string `json:"requestId"`
	Protocol        string `json:"protocol"`
	Model           string `json:"model"`
	Input           string `json:"input"`
	MaxOutputTokens int    `json:"maxOutputTokens"`
}
type Prepared struct {
	PreparedID      string `json:"preparedId"`
	Digest          string `json:"digest"`
	RequestID       string `json:"requestId"`
	Model           string `json:"model"`
	Protocol        string `json:"protocol"`
	KeyRef          string `json:"keyRef"`
	MaxOutputTokens int    `json:"maxOutputTokens"`
	UpstreamURL     string `json:"upstreamUrl"`
	BodyBytes       string `json:"bodyBytes"`
}
type Permit struct {
	PreparedID       string `json:"preparedId"`
	Digest           string `json:"digest"`
	RequestID        string `json:"requestId"`
	OperationID      string `json:"operationId"`
	ExpiresMs        int64  `json:"expiresMs"`
	MaximumCashMinor int    `json:"maximumCashMinor"`
	PermitID         string `json:"permitId"`
}
type Result struct {
	Status            string        `json:"status"`
	RequestID         string        `json:"requestId"`
	Text              string        `json:"text"`
	Usage             *stream.Usage `json:"usage,omitempty"`
	ProviderRequestID string        `json:"providerRequestId,omitempty"`
	Reason            string        `json:"reason,omitempty"`
	OutboundAttempts  int           `json:"outboundAttempts"`
}
type entry struct {
	p          Prepared
	until      time.Time
	keyBinding [32]byte
}
type Engine struct {
	token, InstanceID string
	key               func() (string, error)
	mu                sync.Mutex
	prepared          map[string]entry
	used              map[string]bool
	active            map[string]context.CancelFunc
	client            *http.Client
	destination       string
}

func ID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("secure entropy unavailable")
	}
	return hex.EncodeToString(b)
}
func New(token string, key func() (string, error)) *Engine {
	return &Engine{token: token, InstanceID: ID(), key: key, prepared: map[string]entry{}, used: map[string]bool{}, active: map[string]context.CancelFunc{}, destination: UpstreamURL, client: &http.Client{Timeout: 90 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true, ForceAttemptHTTP2: false}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect forbidden") }}}
}
func write(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
func read(w http.ResponseWriter, r *http.Request, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32768))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing body")
	}
	return nil
}
func (e *Engine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" && r.URL.Path == "/internal/challenge" {
		nonce := r.URL.Query().Get("nonce")
		if len(nonce) != 64 {
			write(w, 400, map[string]string{"error": "invalid nonce"})
			return
		}
		write(w, 200, map[string]string{"instanceId": e.InstanceID, "proof": proof(e.token, e.InstanceID, nonce)})
		return
	}

	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+e.token)) != 1 || e.token == "" {
		write(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/internal/health":
		k, err := e.key()
		write(w, 200, map[string]any{"name": "daming-gateway", "version": "1", "instanceId": e.InstanceID, "upstreamRevision": Revision, "configured": err == nil && k != "", "buildId": BuildID})
	case r.Method == "POST" && r.URL.Path == "/internal/prepare":
		var p Prepare
		if read(w, r, &p) != nil {
			write(w, 400, map[string]string{"error": "invalid request"})
			return
		}
		out, err := e.prepare(p)
		if err != nil {
			write(w, 400, map[string]string{"error": "invalid preparation"})
			return
		}
		write(w, 200, out)
	case r.Method == "POST" && r.URL.Path == "/internal/execute":
		var p Permit
		if read(w, r, &p) != nil {
			write(w, 400, map[string]string{"error": "invalid permit"})
			return
		}
		if r.Header.Get("Accept") == "application/x-ndjson" {
			w.Header().Set("Content-Type", "application/x-ndjson")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			send := func(event string, data any) error {
				err := json.NewEncoder(w).Encode(map[string]any{"event": event, "requestId": p.RequestID, "data": data})
				if err == nil {
					w.(http.Flusher).Flush()
				}
				return err
			}
			result := e.executeStream(r.Context(), p, func(v map[string]any) error { return send("protocol", v) })
			send("result", result)
		} else {
			write(w, 200, e.execute(r.Context(), p))
		}
	case r.Method == "POST" && r.URL.Path == "/internal/cancel":
		var p struct {
			RequestID string `json:"requestId"`
		}
		if read(w, r, &p) != nil || !validID(p.RequestID) {
			write(w, 400, map[string]string{"error": "invalid cancellation"})
			return
		}
		e.mu.Lock()
		for id, x := range e.prepared {
			if x.p.RequestID == p.RequestID {
				delete(e.prepared, id)
			}
		}
		if c := e.active[p.RequestID]; c != nil {
			c()
		}
		e.mu.Unlock()
		write(w, 200, map[string]bool{"cancelled": true})
	default:
		write(w, 404, map[string]string{"error": "not found"})
	}
}
func validID(s string) bool {
	if len(s) == 0 || len(s) > 256 {
		return false
	}
	for _, r := range s {
		if r < 33 || r > 126 {
			return false
		}
	}
	return true
}
func (e *Engine) prepare(p Prepare) (Prepared, error) {
	if !validID(p.RequestID) || (p.Protocol != "responses" && p.Protocol != "messages") || p.Model != "deepseek-flash" || p.MaxOutputTokens != 128 || len(p.Input) == 0 || len(p.Input) > 1024 {
		return Prepared{}, errors.New("limits")
	}
	body, _ := json.Marshal(map[string]any{"model": p.Model, "messages": []map[string]string{{"role": "user", "content": p.Input}}, "max_tokens": 128, "stream": true, "stream_options": map[string]bool{"include_usage": true}, "thinking": map[string]string{"type": "disabled"}})
	out := Prepared{ID(), "", p.RequestID, p.Model, p.Protocol, "deepseek-default", 128, UpstreamURL, string(body)}
	key, _ := e.key()
	keyBinding := sha256.Sum256([]byte(key))
	bind, _ := json.Marshal(out)
	sum := sha256.Sum256(append(bind, keyBinding[:]...))
	out.Digest = hex.EncodeToString(sum[:])
	e.mu.Lock()
	defer e.mu.Unlock()
	for id, x := range e.prepared {
		if time.Now().After(x.until) {
			delete(e.prepared, id)
		}
	}
	if len(e.prepared) >= 128 || len(e.used) >= 4096 {
		return Prepared{}, errors.New("capacity")
	}
	if e.used["request:"+p.RequestID] {
		return Prepared{}, errors.New("request used")
	}
	e.prepared[out.PreparedID] = entry{out, time.Now().Add(5 * time.Minute), keyBinding}
	return out, nil
}
func (e *Engine) execute(parent context.Context, p Permit) Result {
	return e.executeStream(parent, p, nil)
}
func (e *Engine) executeStream(parent context.Context, p Permit, emit func(map[string]any) error) Result {
	out := Result{Status: "not_executed", RequestID: p.RequestID, Reason: "invalid or consumed permit"}
	e.mu.Lock()
	x, ok := e.prepared[p.PreparedID]
	now := time.Now()
	if !ok || x.p.Digest != p.Digest || x.p.RequestID != p.RequestID || !validID(p.OperationID) || !validID(p.PermitID) || p.MaximumCashMinor != 500 || p.ExpiresMs <= now.UnixMilli() || p.ExpiresMs > now.Add(5*time.Minute).UnixMilli() || now.After(x.until) || e.used["permit:"+p.PermitID] || e.used["operation:"+p.OperationID] || e.used["request:"+p.RequestID] || len(e.used) >= 4096 {
		e.mu.Unlock()
		return out
	}
	delete(e.prepared, p.PreparedID)
	e.used["permit:"+p.PermitID] = true
	e.used["operation:"+p.OperationID] = true
	e.used["request:"+p.RequestID] = true
	deadline := time.UnixMilli(p.ExpiresMs)
	if max := time.Now().Add(90 * time.Second); max.Before(deadline) {
		deadline = max
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	e.active[p.RequestID] = cancel
	e.mu.Unlock()
	defer func() { cancel(); e.mu.Lock(); delete(e.active, p.RequestID); e.mu.Unlock() }()
	key, err := e.key()
	if err != nil || key == "" {
		out.Reason = "provider not configured"
		return out
	}
	if sha256.Sum256([]byte(key)) != x.keyBinding {
		out.Reason = "provider credential changed; new preparation required"
		return out
	}
	req, err := http.NewRequestWithContext(ctx, "POST", e.destination, bytes.NewBufferString(x.p.BodyBytes))
	if err != nil {
		return out
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+key)
	// Sole paid send: no retry, fallback, proxy environment, or redirect.
	if time.Now().UnixMilli() >= p.ExpiresMs || ctx.Err() != nil {
		out.Reason = "permit expired or cancelled before send"
		return out
	}
	out.Status = "unknown"
	out.Reason = "upstream outcome incomplete"
	out.OutboundAttempts = 1
	resp, err := e.client.Do(req)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return out
	}
	limited := &io.LimitedReader{R: resp.Body, N: 1 << 20}
	encoder := stream.NewTextEncoder(x.p.Protocol, p.RequestID, x.p.Model, emit)
	if err := encoder.Start(); err != nil {
		return out
	}
	done, finished := false, false
	stopReason := ""
	var text strings.Builder
	err = stream.ReadSSE(limited, func(_ string, data string) error {
		if !utf8.ValidString(data) {
			return errors.New("invalid UTF8")
		}
		if data == "[DONE]" {
			if done {
				return errors.New("duplicate end")
			}
			done = true
			return nil
		}
		if done {
			return errors.New("data after end")
		}
		var ch struct {
			ID      string          `json:"id"`
			Model   string          `json:"model"`
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				Index int `json:"index"`
				Delta struct {
					Content   string          `json:"content"`
					Reasoning string          `json:"reasoning_content"`
					ToolCalls json.RawMessage `json:"tool_calls"`
				} `json:"delta"`
				Finish string `json:"finish_reason"`
			} `json:"choices"`
			Usage *stream.ChatUsage `json:"usage"`
		}
		if json.Unmarshal([]byte(data), &ch) != nil || len(ch.Error) > 0 && string(ch.Error) != "null" {
			return errors.New("invalid upstream event")
		}
		if ch.Model != "" && ch.Model != "deepseek-flash" && !strings.EqualFold(ch.Model, "DeepSeek-V4.1-Flash-1017") {
			return errors.New("unexpected model")
		}
		if len(ch.ID) > 256 {
			return errors.New("invalid id")
		}
		if ch.ID != "" {
			if out.ProviderRequestID != "" && out.ProviderRequestID != ch.ID {
				return errors.New("response identity changed")
			}
			out.ProviderRequestID = ch.ID
		}
		for _, c := range ch.Choices {
			if c.Index != 0 || len(c.Delta.ToolCalls) > 0 && string(c.Delta.ToolCalls) != "null" && string(c.Delta.ToolCalls) != "[]" || c.Delta.Reasoning != "" {
				return errors.New("unexpected capability")
			}
			if finished && c.Delta.Content != "" {
				return errors.New("content after finish")
			}
			text.WriteString(c.Delta.Content)
			if c.Delta.Content != "" {
				if err := encoder.Delta(c.Delta.Content); err != nil {
					return err
				}
			}
			if text.Len() > 65536 {
				return errors.New("output limit")
			}
			if c.Finish != "" {
				if c.Finish != "stop" && c.Finish != "length" {
					return errors.New("unexpected stop")
				}
				finished = true
				stopReason = c.Finish
			}
		}
		if ch.Usage != nil {
			if ch.Usage.PromptTokens < 0 || ch.Usage.PromptTokens > 1048576 || ch.Usage.CompletionTokens < 0 || ch.Usage.PromptCacheHitTokens < 0 || ch.Usage.CachedTokens < 0 || ch.Usage.CacheReadInputTokens < 0 || ch.Usage.CacheCreationInputTokens < 0 {
				return errors.New("invalid raw usage")
			}
			u := ch.Usage.Usage()
			if u.Input < 0 || u.Output < 0 || u.Output > 128 || u.CacheRead < 0 || u.CacheRead > 1048576 || u.CacheWrite < 0 || u.CacheWrite > 1048576 || u.Input+u.CacheRead+u.CacheWrite > 1048576 || u.Reasoning < 0 || u.Reasoning > 128 {
				return errors.New("invalid usage")
			}
			out.Usage = &u
		}
		return nil
	})
	out.Text = text.String()
	if err == nil && limited.N > 0 && done && finished {
		out.Status = "completed"
		out.Reason = ""
	}
	if err := encoder.End(out.Usage, stopReason, out.Status == "completed"); err != nil {
		out.Status = "unknown"
		out.Reason = "client stream interrupted"
	}
	return out
}
