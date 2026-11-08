package enrich

import "testing"

func TestHintFor(t *testing.T) {
	cases := []struct {
		host string
		city string // "" = no match
	}{
		{"ae-1.r21.chcgil09.us.bb.gin.ntt.net", "Chicago"},
		{"AE-1.R21.CHCGIL09.US.BB.GIN.NTT.NET", "Chicago"},
		{"be2.fra.as.example.net", "Frankfurt am Main"},
		{"xe-0-0-1.cr1.lax10.us.example.net", "Los Angeles"},
		{"ae-5-5.ebr2.frnkge08.level3.net", "Frankfurt"},
		{"core1.example.com", ""},
		{"lax.example.com", ""},         // lone label next to the domain: too generic
		{"gig-0-1.cr1.example.net", ""}, // gigabit port, not Rio's GIG
		{"ae-1.r21.example.co.uk", ""},  // nothing but interface/device tokens
		{"fra.example.co.uk", ""},       // two-level public suffix: still a lone label
		{"edge.fra.example.co.uk", "Frankfurt am Main"},
		{"ten-0-0.core.example.net", ""}, // stoplisted generic word
		{"example.com", ""},
		{"", ""},
		{"chcgil09.example.net", "Chicago"}, // carrier codes are specific enough alone
		{"be2.nyc.example.net", "New York"},  // metro codes the spec names
		{"ae-3.cr2.ash1.example.net", "Ashburn"},
		{"xe-1-0.lon2.example.net", "London"},
		{"be10.par3.example.net", "Paris"},
		{"ae1.chi1.example.net", "Chicago"},
	}
	for _, c := range cases {
		h, ok := HintFor(c.host)
		if c.city == "" {
			if ok {
				t.Errorf("HintFor(%q) = %+v, want no match", c.host, h)
			}
			continue
		}
		if !ok || h.City != c.city {
			t.Errorf("HintFor(%q) = %+v ok=%v, want %s", c.host, h, ok, c.city)
		}
	}
}

func TestHintForCoordinates(t *testing.T) {
	h, ok := HintFor("ae-1.r21.chcgil09.us.bb.gin.ntt.net")
	if !ok || h.Lat < 41 || h.Lat > 42.5 || h.Lon > -87 || h.Lon < -88.5 {
		t.Errorf("Chicago hint = %+v", h)
	}
}

func TestTablesAreNonTrivial(t *testing.T) {
	if len(iataHints) < 500 {
		t.Errorf("iata table has %d entries", len(iataHints))
	}
	if len(carrierHints) < 30 {
		t.Errorf("carrier table has %d entries", len(carrierHints))
	}
	for code := range carrierHints {
		if len(code) != 6 {
			t.Errorf("carrier code %q is not 6 chars", code)
		}
	}
}

// Realistic access/router hostnames whose tokens happen to be IATA codes
// (PPP → Proserpine, ISP → Islip, ACC → Accra, …) must not produce hints.
func TestHintForIgnoresRouterVocabulary(t *testing.T) {
	hosts := []string{
		"ppp-203-0-113-9.dyn.example.net",
		"203-0-113-9.ppp.isp.example.net",
		"dyn-1-2-3-4.res.isp.example.com",
		"cpe-1-2-3-4.cab.example.com",
		"host-1-2.cable.res.example.net",
		"acc1-ge-0-0.agr2.cor1.example.net",
		"bb1.core.edge.example.net",
		"lns02.bar.example.net",
		"msr1.agr.example.net",
		"bras-1.nas.ont.example.net",
		"vlan10.sub.bus.example.net",
		"mob-1-2-3-4.gsm.example.net",
		"ras1.brs.example.net",
		"asr9k.esr1.pni.ixp.example.net",
		"svc-1.sys.pub.example.net",
		"man1.per2.reg.example.net",
		"ded-1-2-3-4.vps.cld.example.net",
		"usr-1-2-3-4.sat.example.net",
		"stg1.tst.example.net",
	}
	for _, h := range hosts {
		if hint, ok := HintFor(h); ok {
			t.Errorf("HintFor(%q) = %+v, want no match", h, hint)
		}
	}
}
