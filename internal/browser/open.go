// Package browser opens a URL in the user's default browser. The URL is
// passed as a single argv element; no shell is involved.
package browser

import (
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
)

type runner func(name string, args ...string) error

// Open launches the default browser on rawURL (http or https only).
func Open(rawURL string) error { return open(runtime.GOOS, rawURL, startDetached) }

func open(goos, rawURL string, run runner) error {
	if err := checkURL(rawURL); err != nil {
		return err
	}
	switch goos {
	case "darwin":
		return run("open", rawURL)
	case "linux":
		return run("xdg-open", rawURL)
	}
	return fmt.Errorf("browser: opening a browser is not supported on %s", goos)
}

// checkURL keeps option-like or non-web strings (e.g. "-a App", file:) from
// ever reaching the opener.
func checkURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("browser: refusing to open %q: want an absolute http(s) URL", raw)
	}
	return nil
}

func startDetached(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("browser: start %s: %w", name, err)
	}
	go func() { _ = cmd.Wait() }() // reap
	return nil
}
