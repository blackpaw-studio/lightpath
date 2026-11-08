package enrich

import (
	"net/netip"
	"testing"
)

func TestIsLocal(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"10.0.0.1", true},
		{"172.16.5.4", true},
		{"172.32.0.1", false},
		{"192.168.1.1", true},
		{"169.254.10.1", true},
		{"100.64.0.1", true},
		{"100.127.255.254", true},
		{"100.128.0.1", false},
		{"100.63.255.255", false},
		{"8.8.8.8", false},
		{"fe80::1", true},
		{"fc00::1", true},
		{"fd12:3456::1", true},
		{"2001:4860:4860::8888", false},
		{"::ffff:10.1.2.3", true}, // v4-mapped must classify as v4
		{"::ffff:8.8.8.8", false},
	}
	for _, c := range cases {
		if got := IsLocal(netip.MustParseAddr(c.ip)); got != c.want {
			t.Errorf("IsLocal(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
}
