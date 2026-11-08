// Package target validates user-supplied trace targets and builds the
// traceroute command line. Targets are never passed through a shell.
package target

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

const (
	maxHostLen  = 253
	maxLabelLen = 63
)

var baseArgs = []string{"-n", "-q", "3", "-w", "2", "-m", "30"}

// Validate accepts an IPv4/IPv6 literal (no zone) or an RFC 1123 hostname
// (ASCII only, one optional trailing dot).
func Validate(s string) error {
	if s == "" {
		return errors.New("target is empty")
	}
	if strings.Contains(s, "%") {
		return errors.New("zone identifiers are not allowed")
	}
	if _, err := netip.ParseAddr(s); err == nil {
		return nil
	}
	return validateHostname(s)
}

func validateHostname(s string) error {
	host := strings.TrimSuffix(s, ".")
	if host == "" || len(host) > maxHostLen {
		return fmt.Errorf("hostname must be 1-%d characters", maxHostLen)
	}
	for _, label := range strings.Split(host, ".") {
		if err := validateLabel(label); err != nil {
			return err
		}
	}
	return nil
}

func validateLabel(l string) error {
	if l == "" || len(l) > maxLabelLen {
		return fmt.Errorf("hostname labels must be 1-%d characters", maxLabelLen)
	}
	if l[0] == '-' || l[len(l)-1] == '-' {
		return errors.New("hostname labels must not start or end with '-'")
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		ok := c == '-' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
		if !ok {
			return fmt.Errorf("invalid character %q in hostname", c)
		}
	}
	return nil
}

// CommandFor returns the executable and argv for tracing an already-validated
// target. macOS uses traceroute6 for IPv6 literals; Linux's traceroute
// auto-detects the family.
func CommandFor(target, goos string) (string, []string) {
	name := "traceroute"
	if goos == "darwin" {
		if a, err := netip.ParseAddr(target); err == nil && a.Is6() && !a.Is4In6() {
			name = "traceroute6"
		}
	}
	args := append(append(make([]string, 0, len(baseArgs)+1), baseArgs...), target)
	return name, args
}
