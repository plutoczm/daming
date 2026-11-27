package engine

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestOnePaidAttemptAndExpiryAtLastEntry(t *testing.T) {
	for _, delay := range []bool{false, true} {
		t.Run(map[bool]string{false: "once", true: "expiry"}[delay], func(t *testing.T) {
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte("data: {\"id\":\"r\",\"model\":\"deepseek-flash\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
			}))
			defer upstream.Close()
			e := New("local", func() (string, error) {
				if delay {
					time.Sleep(70 * time.Millisecond)
				}
				return "fake-only", nil
			})
			e.destination = upstream.URL
			p, err := e.prepare(Prepare{"r", "responses", "deepseek-flash", "Reply OK", 128})
			if err != nil {
				t.Fatal(err)
			}
			expires := time.Now().Add(time.Minute).UnixMilli()
			if delay {
				expires = time.Now().Add(30 * time.Millisecond).UnixMilli()
			}
			permit := Permit{p.PreparedID, p.Digest, "r", "op", expires, 500, "permit"}
			result := e.execute(context.Background(), permit)
			if delay {
				if calls.Load() != 0 || result.Status != "not_executed" {
					t.Fatalf("expired call executed: %d %s", calls.Load(), result.Status)
				}
			} else {
				if result.Status != "completed" || result.Text != "OK" {
					t.Fatalf("unexpected result: %+v", result)
				}
				e.execute(context.Background(), permit)
				if calls.Load() != 1 {
					t.Fatal("duplicate paid request")
				}
			}
		})
	}
}
func TestTruncatedAndConflictingStreamIsNotComplete(t *testing.T) {
	for _, suffix := range []string{"", "data: [DONE]\n\ndata: [DONE]\n\n", "data: {\"id\":\"foreign\",\"choices\":[]}\n\ndata: [DONE]\n\n"} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\n" + suffix))
		}))
		e := New("local", func() (string, error) { return "fake-only", nil })
		e.destination = server.URL
		p, _ := e.prepare(Prepare{"r", "messages", "deepseek-flash", "Reply OK", 128})
		result := e.execute(context.Background(), Permit{p.PreparedID, p.Digest, "r", "op", time.Now().Add(time.Minute).UnixMilli(), 500, "permit"})
		server.Close()
		if result.Status == "completed" {
			b, _ := json.Marshal(result)
			t.Fatalf("invalid lifecycle accepted: %s", b)
		}
	}
}

func TestMalformedUTF8AndNegativeUsage(t *testing.T) {
	bodies := []string{"data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"" + string([]byte{255}) + "\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
		"data: {\"id\":\"r\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":-1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n"}
	for _, body := range bodies {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
		e := New("local", func() (string, error) { return "fake-only", nil })
		e.destination = server.URL
		p, _ := e.prepare(Prepare{"r", "responses", "deepseek-flash", "Reply OK", 128})
		result := e.execute(context.Background(), Permit{p.PreparedID, p.Digest, "r", "op", time.Now().Add(time.Minute).UnixMilli(), 500, "permit"})
		server.Close()
		if result.Status == "completed" {
			t.Fatal("malformed provider evidence accepted")
		}
	}
}

func TestPermitDeadlineIncludesConnectionSetup(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.Write([]byte("data: [DONE]\n\n")) }))
	defer server.Close()
	e := New("local", func() (string, error) { return "fake-only", nil })
	e.destination = server.URL
	e.client.Transport = &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		select {
		case <-time.After(100 * time.Millisecond):
			return (&net.Dialer{}).DialContext(ctx, network, address)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	prepared, _ := e.prepare(Prepare{"r", "responses", "deepseek-flash", "OK", 128})
	e.execute(context.Background(), Permit{prepared.PreparedID, prepared.Digest, "r", "op", time.Now().Add(30 * time.Millisecond).UnixMilli(), 500, "permit"})
	if calls.Load() != 0 {
		t.Fatal("paid POST sent after permit expired in connection setup")
	}
}

func TestCredentialRotationInvalidatesPreparedRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	key := "first-fake-account"
	e := New("local", func() (string, error) { return key, nil })
	e.destination = server.URL
	p, _ := e.prepare(Prepare{"r", "responses", "deepseek-flash", "OK", 128})
	key = "second-fake-account"
	out := e.execute(context.Background(), Permit{p.PreparedID, p.Digest, "r", "op", time.Now().Add(time.Minute).UnixMilli(), 500, "permit"})
	if calls.Load() != 0 || out.Status != "not_executed" {
		t.Fatal("changed credential used an old approval")
	}
}
