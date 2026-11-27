package gateway

// Daming task-scoped temporary keys require both a strict model/account
// allowlist and at most one upstream send. This limit is attached to the
// authenticated request context, not a client-provided header or model name.
// Other Magpie clients retain their normal retry/fallback behavior.
import (
	"context"
	"crypto/tls"
	"net/http"
	"sync/atomic"

	"github.com/yetone/magpie/internal/access"
)

type singleUpstreamCounter struct {
	candidates atomic.Int32
	outgoing   atomic.Int32
}
type singleUpstreamContextKey struct{}

func singleUpstreamScoped(ctx context.Context) bool {
	_, ok := ctx.Value(singleUpstreamContextKey{}).(*singleUpstreamCounter)
	return ok
}

// A scoped send has one fresh HTTP/1 connection, no redirect, and no
// transport-specific replay, WebSocket upgrade or protocol fallback.
func singleUpstreamHTTP(req *http.Request) (*http.Response, error) {
	transport := vendorTransport(upstreamHeaderWait)
	transport.DisableKeepAlives = true
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
	transport.Proxy = nil
	client := &http.Client{
		Transport:     rpmTransport{transport},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req.GetBody = nil
	return client.Do(req)
}

func singleUpstreamGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if access.Caller(r.Context()).SingleUpstream {
			r = r.WithContext(context.WithValue(r.Context(), singleUpstreamContextKey{}, &singleUpstreamCounter{}))
		}
		next.ServeHTTP(w, r)
	})
}
func singleUpstreamCandidate(ctx context.Context) bool {
	if counter, ok := ctx.Value(singleUpstreamContextKey{}).(*singleUpstreamCounter); ok {
		return counter.candidates.Add(1) == 1
	}
	return true
}
func singleUpstreamOutgoing(ctx context.Context) bool {
	if counter, ok := ctx.Value(singleUpstreamContextKey{}).(*singleUpstreamCounter); ok {
		return counter.outgoing.Add(1) == 1
	}
	return true
}
