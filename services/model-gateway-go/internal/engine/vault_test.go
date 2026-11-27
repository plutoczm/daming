package engine

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestVaultProtectsSecretAndRejectsForeignDirectory(t *testing.T) {
	d := filepath.Join(t.TempDir(), "owned")
	if err := EnsureDir(d); err != nil {
		t.Fatal(err)
	}
	key := "test-only-secret-canary"
	if err := SaveKey(d, key); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(d, "deepseek.dpapi"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(key)) {
		t.Fatal("plaintext key persisted")
	}
	got, err := LoadKey(d)
	if err != nil || got != key {
		t.Fatal("DPAPI roundtrip failed", err)
	}
	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "user-file"), []byte("keep"), 0600)
	if EnsureDir(other) == nil {
		t.Fatal("foreign directory adopted")
	}
}
func TestExclusiveRuntimeLock(t *testing.T) {
	d := t.TempDir()
	a, err := AcquireLock(filepath.Join(d, "lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if b, err := AcquireLock(filepath.Join(d, "lock")); err == nil {
		b.Close()
		t.Fatal("second writer admitted")
	}
}

func TestVaultSaveUnderRedirectedLocalAppData(t *testing.T) {
	base := filepath.Join(os.Getenv("LOCALAPPDATA"), "Daming")
	if os.Getenv("LOCALAPPDATA") == "" {
		t.Skip("Windows local data unavailable")
	}
	d, err := os.MkdirTemp(base, ".vault-regression-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(d)
	physical, err := filepath.EvalSymlinks(d)
	if err != nil {
		t.Fatal(err)
	}
	t.Log("physical path differs:", physical != d)
	if err := SaveKey(d, "synthetic-key-not-a-real-provider-secret"); err != nil {
		t.Fatal("save in local app data alias failed:", err)
	}
	got, err := LoadKey(d)
	if err != nil || got != "synthetic-key-not-a-real-provider-secret" {
		t.Fatal("local app data roundtrip failed")
	}
}
