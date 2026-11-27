package provider

import (
	"errors"
	"os"
)

// DamingCodexLoginReadOnly is an owned Host mode, never enabled for ordinary
// Magpie clients. It may use an existing login but must leave renewal to Codex.
func DamingCodexLoginReadOnly() bool { return os.Getenv("DAMING_CODEX_READONLY_AUTH") == "1" }

var errDamingCodexLoginReadOnly = errors.New("Daming leaves the personal Codex sign-in read-only; renew it in Codex")
