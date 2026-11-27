package engine

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthenticationAndUnconfiguredHealth(t *testing.T) {
	h := New("secret", func() (string, error) { return "", nil })
	r := httptest.NewRequest("GET", "/internal/health", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("want unauthorized, got %d", w.Code)
	}
	r.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"configured":false`) {
		t.Fatalf("health: %d %s", w.Code, w.Body.String())
	}
}
func TestInvalidPreparation(t *testing.T) {
	h := New("s", func() (string, error) { return "", nil })
	r := httptest.NewRequest(http.MethodPost, "/internal/prepare", strings.NewReader(`{"requestId":"r","protocol":"responses","model":"other","input":"hi","maxOutputTokens":128}`))
	r.Header.Set("Authorization", "Bearer s")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("invalid config must reject: %d", w.Code)
	}
}
