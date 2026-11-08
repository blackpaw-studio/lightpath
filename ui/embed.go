// Package ui embeds the built web UI. dist/ is committed with a .gitkeep so
// the Go module compiles without running the UI build.
package ui

import "embed"

//go:embed all:dist
var Dist embed.FS
