package enrich

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// TXTResolver resolves TXT records; *net.Resolver satisfies it.
type TXTResolver interface {
	LookupTXT(ctx context.Context, name string) ([]string, error)
}

// ASInfo is an autonomous system number and its description.
type ASInfo struct {
	ASN int
	Org string
}

// cacheCap bounds every per-component cache; when full it is reset.
const cacheCap = 4096

// Cymru maps IPs to ASNs through Team Cymru's DNS service. Results are cached
// by /24 (v4) or /64 (v6) prefix and by ASN for the lifetime of the value.
type Cymru struct {
	res     TXTResolver
	clock   Clock
	timeout time.Duration

	mu       sync.Mutex
	prefixes map[string]int // prefix key -> ASN (0 = known to have no origin)
	orgs     map[int]string
}

// NewCymru returns a Cymru lookup using res and clock.
func NewCymru(res TXTResolver, clock Clock) *Cymru {
	return &Cymru{
		res: res, clock: clock, timeout: DefaultTimeout,
		prefixes: map[string]int{}, orgs: map[int]string{},
	}
}

// Lookup returns the origin AS of addr. Local addresses, NXDOMAIN, timeouts
// and resolver errors all report ok=false. A failed AS-description lookup
// still returns the ASN with an empty Org (and is retried next time).
func (c *Cymru) Lookup(ctx context.Context, addr netip.Addr) (ASInfo, bool) {
	addr = addr.Unmap()
	if !addr.IsValid() || IsLocal(addr) || !addr.IsGlobalUnicast() {
		return ASInfo{}, false
	}
	ctx, cancel := withTimeout(ctx, c.clock, c.timeout)
	defer cancel()

	asn, ok := c.origin(ctx, addr)
	if !ok || asn == 0 {
		return ASInfo{}, false
	}
	return ASInfo{ASN: asn, Org: c.org(ctx, asn)}, true
}

func (c *Cymru) origin(ctx context.Context, addr netip.Addr) (int, bool) {
	key := prefixKey(addr)
	c.mu.Lock()
	asn, hit := c.prefixes[key]
	c.mu.Unlock()
	if hit {
		return asn, true
	}
	txt, err := c.res.LookupTXT(ctx, originName(addr))
	switch {
	case err == nil:
		asn, _ = parseOrigin(txt)
	case isNotFound(err):
		asn = 0
	default:
		return 0, false
	}
	c.mu.Lock()
	if len(c.prefixes) >= cacheCap {
		c.prefixes = map[string]int{}
	}
	c.prefixes[key] = asn
	c.mu.Unlock()
	return asn, true
}

func (c *Cymru) org(ctx context.Context, asn int) string {
	c.mu.Lock()
	org, hit := c.orgs[asn]
	c.mu.Unlock()
	if hit {
		return org
	}
	txt, err := c.res.LookupTXT(ctx, "AS"+strconv.Itoa(asn)+".asn.cymru.com")
	if err != nil {
		return ""
	}
	org, ok := parseASName(txt)
	if !ok {
		return ""
	}
	c.mu.Lock()
	if len(c.orgs) >= cacheCap {
		c.orgs = map[int]string{}
	}
	c.orgs[asn] = org
	c.mu.Unlock()
	return org
}

func isNotFound(err error) bool {
	var dnsErr *net.DNSError
	return errors.As(err, &dnsErr) && dnsErr.IsNotFound
}

func prefixKey(addr netip.Addr) string {
	bits := 24
	if addr.Is6() {
		bits = 64
	}
	p, _ := addr.Prefix(bits)
	return p.String()
}

// originName builds the Team Cymru origin query name for addr.
func originName(addr netip.Addr) string {
	addr = addr.Unmap()
	if addr.Is4() {
		b := addr.As4()
		return strconv.Itoa(int(b[3])) + "." + strconv.Itoa(int(b[2])) + "." +
			strconv.Itoa(int(b[1])) + "." + strconv.Itoa(int(b[0])) + ".origin.asn.cymru.com"
	}
	const hexDigits = "0123456789abcdef"
	b := addr.As16()
	var sb strings.Builder
	for i := len(b) - 1; i >= 0; i-- {
		sb.WriteByte(hexDigits[b[i]&0x0f])
		sb.WriteByte('.')
		sb.WriteByte(hexDigits[b[i]>>4])
		sb.WriteByte('.')
	}
	sb.WriteString("origin6.asn.cymru.com")
	return sb.String()
}

func splitTXT(rec string) []string {
	parts := strings.Split(strings.Trim(strings.TrimSpace(rec), `"`), "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

// parseOrigin extracts the lowest ASN from origin TXT records
// ("ASN [ASN...] | prefix | CC | registry | date").
func parseOrigin(txt []string) (int, bool) {
	best, found := 0, false
	for _, rec := range txt {
		parts := splitTXT(rec)
		if len(parts) < 2 {
			continue
		}
		for _, f := range strings.Fields(parts[0]) {
			n, err := strconv.Atoi(f)
			if err != nil || n <= 0 {
				continue
			}
			if !found || n < best {
				best, found = n, true
			}
		}
	}
	return best, found
}

// parseASName extracts the description from an AS TXT record
// ("ASN | CC | registry | date | description").
func parseASName(txt []string) (string, bool) {
	for _, rec := range txt {
		parts := splitTXT(rec)
		if len(parts) >= 5 && parts[4] != "" {
			return capField(parts[4]), true
		}
	}
	return "", false
}
