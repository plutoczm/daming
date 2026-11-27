// Command damingd is Daming's trimmed replacement for magpie's full CLI
// umbrella. It exposes only what Daming drives: the gateway plus the
// web/admin API surface, started exactly like `magpie serve --web`.
//
// Daming spawns: <exe> serve --web=127.0.0.1:<adminPort> with MAGPIE_ADDR and
// MAGPIE_WEB_KEY set (see apps/server/src/magpie-host.ts). This binary keeps
// that contract while dropping the rest of the cli command surface.
package main

import (
	"fmt"
	"os"
	"strings"

	"github.com/yetone/magpie/internal/gui"

	// Register only the plugins Daming's three domains need (providers/
	// accounts, agent access, model routing + gateway). Deliberately drop
	// library/market, tools, search, warmups and otel: Daming does not use
	// them and they drag whole subsystems (library/agent installers) in.
	_ "github.com/yetone/magpie/plugins/budget"
	_ "github.com/yetone/magpie/plugins/gateway"
	_ "github.com/yetone/magpie/plugins/groups"
	_ "github.com/yetone/magpie/plugins/middleware"
	_ "github.com/yetone/magpie/plugins/redact"
	_ "github.com/yetone/magpie/plugins/rotation"
	_ "github.com/yetone/magpie/plugins/routing"
	_ "github.com/yetone/magpie/plugins/sessions"
	_ "github.com/yetone/magpie/plugins/usage"
)

var version = "dev"

func main() {
	addr, err := parseWeb(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "damingd:", err)
		os.Exit(2)
	}
	w, err := gui.StartWeb(addr, version)
	if err != nil {
		fmt.Fprintln(os.Stderr, "damingd: start web:", err)
		os.Exit(1)
	}
	fmt.Printf("damingd: serving web on http://%s\n", addr)
	if err := w.Wait(); err != nil {
		fmt.Fprintln(os.Stderr, "damingd:", err)
		os.Exit(1)
	}
}

// parseWeb accepts the Daming invocation `serve --web[=host:port]` as well as
// a bare `--web[=host:port]`. Falls back to DAMINGD_WEB, then a loopback
// default. Anything else in argv is ignored (damingd has no other commands).
func parseWeb(args []string) (string, error) {
	const def = "127.0.0.1:3430"
	for _, a := range args {
		if a == "serve" {
			continue
		}
		if a == "--web" {
			return def, nil
		}
		if strings.HasPrefix(a, "--web=") {
			if v := strings.TrimSpace(strings.TrimPrefix(a, "--web=")); v != "" {
				return v, nil
			}
			return def, nil
		}
	}
	if v := strings.TrimSpace(os.Getenv("DAMINGD_WEB")); v != "" {
		return v, nil
	}
	return def, nil
}
