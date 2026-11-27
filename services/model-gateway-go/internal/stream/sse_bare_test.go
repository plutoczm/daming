package stream

import (
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

// agBareError is the line Antigravity ended zRain's gemini-4-argon-high
// stream with, after its 200 and a few thinking events (Discord
// #feedback, v0.1.3039/v0.1.3041, Windows): no "data:" before it, and
// nothing after it but the end of the body.
const agBareError = `{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}`

// agThinking is Code Assist's thinking events before it, as Antigravity
// streams them (CRLF, each in its {response} wrapper); the reporter's own
// were not sent, only described.
const agThinking = "data: {\"response\": {\"candidates\": [{\"content\": {\"role\": \"model\",\"parts\": [{\"text\": \"**Weighing the request**\\n\\n\",\"thought\": true}]}}],\"usageMetadata\": {\"promptTokenCount\": 5210,\"totalTokenCount\": 5210},\"modelVersion\": \"gemini-4-argon\"},\"traceId\": \"9d1c0e2f\"}\r\n\r\n" +
	"data: {\"response\": {\"candidates\": [{\"content\": {\"role\": \"model\",\"parts\": [{\"text\": \"I'll look at the files first.\",\"thought\": true}]}}],\"usageMetadata\": {\"promptTokenCount\": 5210,\"totalTokenCount\": 5230},\"modelVersion\": \"gemini-4-argon\"},\"traceId\": \"9d1c0e2f\"}\r\n\r\n"

// the bare error ended as it came: with a line end, a CRLF, or none
var agBareEnds = map[string]string{
	"LF":   agThinking + agBareError + "\n",
	"CRLF": agThinking + agBareError + "\r\n",
	"EOF":  agThinking + agBareError,
}

func readEvents(t *testing.T, r io.Reader) []string {
	t.Helper()
	var got []string
	if err := ReadSSE(r, func(_, data string) error {
		got = append(got, data)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

// The bare error is the stream's last event, as if it had come as data,
// however the body is split; an event of the stream's own is untouched.
func TestBareErrorLineIsAnEvent(t *testing.T) {
	for name, body := range agBareEnds {
		for _, split := range []bool{false, true} {
			var r io.Reader = strings.NewReader(body)
			if split {
				r = iotest.OneByteReader(r)
			}
			got := readEvents(t, r)
			if len(got) != 3 || got[2] != agBareError || !strings.Contains(got[1], "look at the files") {
				t.Errorf("%s (one byte at a time %v): %q", name, split, got)
			}
		}
	}

	// Google's own pretty-printed error, a list of one (its JSON array
	// stream), OpenAI's and Anthropic's shapes, right after a data line
	// with no blank line between
	for _, tc := range []struct{ bare, want string }{
		{"{\n  \"error\": {\n    \"code\": 400,\n    \"message\": \"Request contains an invalid argument.\",\n    \"status\": \"INVALID_ARGUMENT\"\n  }\n}\n", agBareError},
		{"[{\n  \"error\": {\n    \"code\": 429,\n    \"message\": \"Resource has been exhausted (e.g. check quota).\",\n    \"status\": \"RESOURCE_EXHAUSTED\"\n  }\n}\n]\n", `{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}`},
		{`{"error":{"message":"bad","type":"invalid_request_error","code":null}}` + "\n", `{"error":{"message":"bad","type":"invalid_request_error","code":null}}`},
		{`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` + "\n", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`},
	} {
		got := readEvents(t, iotest.OneByteReader(strings.NewReader("data: {\"a\":1}\n"+tc.bare)))
		if len(got) != 2 || got[0] != `{"a":1}` || got[1] != tc.want {
			t.Errorf("%q: %q", tc.bare, got)
		}
	}

	// what isn't an error goes as it came, and SSE skips it as before
	for _, other := range []string{
		`{"candidates":[]}`,
		`{"error":null}`,
		`[{"error":{"code":1}},{"error":{"code":2}}]`,
		`{"error": {"code": 400,`,
		`not json`,
	} {
		body := "data: {\"a\":1}\n\n" + other + "\ndata: {\"b\":2}\n\n"
		out, _ := io.ReadAll(bareErrors(iotest.OneByteReader(strings.NewReader(body))))
		if string(out) != body {
			t.Errorf("%q changed: %q", other, out)
		}
	}

	// a stream with no bare line goes byte for byte
	for _, body := range []string{agThinking, "data: x\r\n\r\n: ping\r\nevent: e\r\ndata: y"} {
		out, _ := io.ReadAll(bareErrors(iotest.OneByteReader(strings.NewReader(body))))
		if string(out) != body {
			t.Errorf("a stream changed: %q", out)
		}
	}
}

// A line under way goes on before it ends: only one that may be a bare
// JSON value waits for its end, so a relayed stream isn't held back.
func TestBareErrorsHoldsNothingElse(t *testing.T) {
	pr, pw := io.Pipe()
	r := bareErrors(pr)
	go pw.Write([]byte("data: {\"text\":\"hel"))
	buf := make([]byte, 64)
	n, err := r.Read(buf)
	if err != nil || string(buf[:n]) != "data: {\"text\":\"hel" {
		t.Fatalf("a data line's start was held: %q %v", buf[:n], err)
	}
	pw.Close()
}
