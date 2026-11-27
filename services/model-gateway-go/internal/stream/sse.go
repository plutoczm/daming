package stream

import (
	"bufio"
	"io"
	"strings"
)

// readSSE walks a server-sent event stream, calling fn with each event's
// name and data. Data lines of one event are joined with newlines.
func ReadSSE(r io.Reader, fn func(event, data string) error) error {
	return readSSEAlive(r, fn, nil)
}

// readSSEAlive is readSSE that also calls alive, when not nil, after each
// event and each comment: every sign that the stream is alive, a
// keepalive (": keepalive") as much as an answer. An error the upstream
// wrote as a JSON line of its own is read as the data event it means
// (bareErrors).
func readSSEAlive(r io.Reader, fn func(event, data string) error, alive func()) error {
	if _, ok := r.(*bareErrorReader); !ok {
		r = bareErrors(r)
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), 32<<20)
	var event string
	var data []string
	flush := func() error {
		if len(data) == 0 {
			event = ""
			return nil
		}
		err := fn(event, strings.Join(data, "\n"))
		event, data = "", nil
		if err == nil && alive != nil {
			alive()
		}
		return err
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				return err
			}
		case strings.HasPrefix(line, ":"):
			if alive != nil {
				alive()
			}
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[6:])
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(line[5:], " "))
		}
	}
	if err := flush(); err != nil {
		return err
	}
	return sc.Err()
}
