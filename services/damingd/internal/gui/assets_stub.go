//go:build daminglite

package gui

import "embed"

// assets is empty in the daminglite build. Daming consumes only the JSON API
// (see apps/server/src/magpie-host.ts) and never the bundled web UI, so the
// -daminglite build drops the ~10 MB of frontend assets from the binary.
var assets embed.FS
