// Package server serves the embedded UI and the /ws trace session. All
// requests pass a Host allowlist (DNS-rebinding defence); /ws additionally
// requires an allowlisted Origin. Matching is exact-string, never prefix or
// suffix.
package server

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
)

// hostedOrigin is the only non-loopback page allowed to drive the agent.
const hostedOrigin = "https://lightpath.blackpaw.studio"

var errForbidden = errors.New("forbidden")

func allowedHosts(port int) []string {
	p := strconv.Itoa(port)
	return []string{"127.0.0.1:" + p, "localhost:" + p}
}

func allowedOrigins(port int) []string {
	p := strconv.Itoa(port)
	return []string{"http://127.0.0.1:" + p, "http://localhost:" + p, hostedOrigin}
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// CheckHost rejects any request whose Host header is not an exact loopback
// host:port for this agent.
func CheckHost(r *http.Request, port int) error {
	if !contains(allowedHosts(port), r.Host) {
		return fmt.Errorf("host %q not allowed: %w", r.Host, errForbidden)
	}
	return nil
}

// CheckOrigin requires exactly one Origin header that exactly matches the
// allowlist. A missing Origin is rejected.
func CheckOrigin(r *http.Request, port int) error {
	origins := r.Header.Values("Origin")
	if len(origins) != 1 {
		return fmt.Errorf("expected exactly one Origin header, got %d: %w", len(origins), errForbidden)
	}
	if !contains(allowedOrigins(port), origins[0]) {
		return fmt.Errorf("origin %q not allowed: %w", origins[0], errForbidden)
	}
	return nil
}

// CheckUpgrade is the full WebSocket upgrade gate: Host and Origin.
func CheckUpgrade(r *http.Request, port int) error {
	if err := CheckHost(r, port); err != nil {
		return err
	}
	return CheckOrigin(r, port)
}

// GuardHost wraps next so every route enforces CheckHost.
func GuardHost(port int, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := CheckHost(r, port); err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
