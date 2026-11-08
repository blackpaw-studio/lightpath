package enrich

import "strings"

//go:generate go run ../../tools/genhints -out hints_table.go

// Hint is a location inferred from a hostname.
type Hint struct {
	Lat, Lon float64
	City     string
}

// stopTokens are hostname tokens that are also IATA codes (or look like
// location codes) but overwhelmingly mean something else in router names.
var stopTokens = setOf(
	"gig", "ten", "hun", "pop", "lag", "nat", "agg", "bbr", "brd", "bgp", "lan", "wan",
	"vpn", "dns", "ntp", "mgt", "ext", "int", "dsl", "cpe", "web", "srv", "dyn", "net",
	"com", "org", "edu", "gov", "mil", "any", "eth", "tun", "vlan", "core", "edge",
	"cust", "rtr", "lsr", "ear", "ccr", "csr", "cr", "br", "ar", "er", "pe", "ce",
	"ae", "ge", "xe", "et", "fe", "te", "hu", "po", "lo", "so", "gi", "gw", "fw", "sw",
	"bb", "ip", "ipv", "tel", "mpr", "ibr", "dc", "pod", "tor", "sfp", "mx", "qfx",
)

func setOf(items ...string) map[string]struct{} {
	m := make(map[string]struct{}, len(items))
	for _, s := range items {
		m[s] = struct{}{}
	}
	return m
}

// secondLevelLabels are common second-level labels under a two-letter ccTLD
// ("example.co.uk"), so the registrable domain is three labels there.
var secondLevelLabels = setOf("co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "go")

// HintFor infers a location from a reverse-DNS name. It checks labels
// right-to-left (nearest the registrable domain first) and matches either a
// curated 6-character carrier city code or a whole-token IATA airport code. A
// single label in front of the registrable domain is too ambiguous for IATA
// codes ("lax.example.com") and only carrier codes may match there.
func HintFor(host string) (Hint, bool) {
	host = strings.ToLower(strings.Trim(strings.TrimSpace(host), "."))
	if host == "" {
		return Hint{}, false
	}
	labels := candidateLabels(strings.Split(host, "."))
	allowIATA := len(labels) >= 2
	for i := len(labels) - 1; i >= 0; i-- {
		for _, tok := range tokens(labels[i]) {
			if h, ok := carrierHints[tok]; ok {
				return h, true
			}
			if !allowIATA || len(tok) != 3 {
				continue
			}
			if _, stop := stopTokens[tok]; stop {
				continue
			}
			if h, ok := iataHints[tok]; ok {
				return h, true
			}
		}
	}
	return Hint{}, false
}

// candidateLabels drops the registrable domain (and anything to its right).
func candidateLabels(labels []string) []string {
	drop := 2
	if n := len(labels); n >= 3 && len(labels[n-1]) == 2 {
		if _, ok := secondLevelLabels[labels[n-2]]; ok {
			drop = 3
		}
	}
	if len(labels) <= drop {
		return nil
	}
	return labels[:len(labels)-drop]
}

// tokens splits a label on '-' / '_' and strips trailing digits from each part
// ("chcgil09" → "chcgil", "ae-1" → "ae").
func tokens(label string) []string {
	parts := strings.FieldsFunc(label, func(r rune) bool { return r == '-' || r == '_' })
	out := parts[:0]
	for _, p := range parts {
		if p = strings.TrimRight(p, "0123456789"); p != "" {
			out = append(out, p)
		}
	}
	return out
}
