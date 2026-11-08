package enrich

import "net/netip"

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// IsLocal reports whether addr is private (RFC 1918, fc00::/7), link-local
// (169.254/16, fe80::/10) or carrier-grade NAT (100.64.0.0/10). Such hops have
// no public ASN or geolocation of their own.
func IsLocal(addr netip.Addr) bool {
	addr = addr.Unmap()
	return addr.IsPrivate() || addr.IsLinkLocalUnicast() || cgnat.Contains(addr)
}
