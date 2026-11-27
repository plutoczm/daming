package engine

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientProtocolStreamsBeforeUpstreamCompletes(t *testing.T) {
	for _, protocol := range []string{"responses", "messages"} {
		t.Run(protocol, func(t *testing.T) {
			release := make(chan struct{}, 1)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.Write([]byte("data: {\"id\":\"provider-r\",\"model\":\"deepseek-flash\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":null}]}\n\n"))
				w.(http.Flusher).Flush()
				select {
				case <-release:
				case <-r.Context().Done():
					return
				}
				w.Write([]byte("data: {\"id\":\"provider-r\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n"))
			}))
			defer func() {
				select {
				case release <- struct{}{}:
				default:
				}
				upstream.Close()
			}()
			e := New("test-runtime", func() (string, error) { return "fake-only", nil })
			e.destination = upstream.URL
			p, _ := e.prepare(Prepare{"r", protocol, "deepseek-flash", "OK", 128})
			permit := Permit{p.PreparedID, p.Digest, "r", "op", time.Now().Add(time.Minute).UnixMilli(), 500, "permit"}
			server := httptest.NewServer(e)
			defer server.Close()
			body, _ := json.Marshal(permit)
			request, _ := http.NewRequest("POST", server.URL+"/internal/execute", bytes.NewReader(body))
			request.Header.Set("Authorization", "Bearer test-runtime")
			request.Header.Set("Accept", "application/x-ndjson")
			client := http.Client{Timeout: 700 * time.Millisecond}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal("no incremental headers before upstream completion", err)
			}
			defer response.Body.Close()
			scan := bufio.NewScanner(response.Body)
			if !scan.Scan() {
				t.Fatal("no first frame", scan.Err())
			}
			var first map[string]any
			if json.Unmarshal(scan.Bytes(), &first) != nil || first["event"] != "protocol" {
				t.Fatalf("not protocol stream: %s", scan.Bytes())
			}
			// release without a second close in deferred cleanup
			release <- struct{}{}
			var last string
			var terminal bool
			for scan.Scan() {
				var frame map[string]any
				json.Unmarshal(scan.Bytes(), &frame)
				if frame["event"] == "protocol" {
					data := frame["data"].(map[string]any)
					last, _ = data["type"].(string)
					if last == "response.completed" || last == "message_stop" {
						terminal = true
					}
				}
				if frame["event"] == "result" && frame["data"].(map[string]any)["status"] != "completed" {
					t.Fatal("bad final result")
				}
			}
			if scan.Err() != nil && scan.Err() != io.EOF {
				t.Fatal(scan.Err())
			}
			if !terminal {
				t.Fatal("missing client terminal", last)
			}
		})
	}
}
