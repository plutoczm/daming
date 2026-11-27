//go:build !daminglite

package gui

import "embed"

// assets is the embedded web UI (index.html, app.js, css, i18n, icons) served
// to the desktop window and to the browser at the admin port.
//
//go:embed assets
var assets embed.FS
