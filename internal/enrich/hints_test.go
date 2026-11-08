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
