package target

import (
	"reflect"
	"strings"
	"testing"
)

func TestValidate(t *testing.T) {
	label63 := strings.Repeat("a", 63)
	host253 := strings.Join([]string{label63, label63, label63, strings.Repeat("b", 61)}, ".") // 63*3+61+3 = 253
	tests := []struct {
		name   string
		in     string
		wantOK bool
	}{
		{"ipv4", "8.8.8.8", true},
		{"ipv6", "2001:4860:4860::8888", true},
		{"ipv6 loopback", "::1", true},
		{"ipv6 zone", "fe80::1%eth0", false},
		{"ipv6 numeric zone", "fe80::1%1", false},
		{"ipv4-mapped", "::ffff:1.2.3.4", true},
		{"hostname", "example.com", true},
		{"single label", "localhost", true},
		{"trailing dot", "example.com.", true},
		{"digits and hyphen", "a-1.b2-c.example", true},
		{"mixed case", "Example.COM", true},
		{"max length 253", host253, true},
		{"254 chars", host253 + "c", false},
		{"label 63", label63 + ".com", true},
		{"label 64", label63 + "a.com", false},
		{"empty", "", false},
		{"lone dot", ".", false},
		{"leading dash", "-foo", false},
		{"leading dash flag", "-w1", false},
		{"leading dash label", "a.-b.com", false},
		{"trailing dash label", "a-.com", false},
		{"double trailing dot", "example.com..", false},
		{"empty label", "a..com", false},
		{"leading dot", ".example.com", false},
		{"space", "a b", false},
		{"surrounding space", " example.com", false},
		{"newline", "example.com\n", false},
		{"semicolon", ";rm", false},
		{"command subst", "$(x)", false},
		{"backtick", "`id`", false},
		{"pipe", "a|b", false},
		{"ampersand", "a&b", false},
		{"slash", "a/b", false},
		{"underscore", "a_b.com", false},
		{"unicode", "exämple.com", false},
		{"unicode digit", "example.com٣", false},
		{"NUL", "a\x00b", false},
		{"ipv4 with port", "1.2.3.4:80", false},
		{"bracketed ipv6", "[::1]", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Validate(tt.in)
			if (err == nil) != tt.wantOK {
				t.Fatalf("Validate(%q) err=%v, wantOK=%v", tt.in, err, tt.wantOK)
			}
		})
	}
}

func TestCommandFor(t *testing.T) {
	base := []string{"-n", "-q", "3", "-w", "2", "-m", "30"}
	with := func(t string) []string { return append(append([]string{}, base...), t) }
	tests := []struct {
		name     string
		target   string
		goos     string
		wantName string
		wantArgs []string
	}{
		{"darwin v4", "8.8.8.8", "darwin", "traceroute", with("8.8.8.8")},
		{"darwin v6", "2001:db8::1", "darwin", "traceroute6", with("2001:db8::1")},
		{"darwin hostname", "example.com", "darwin", "traceroute", with("example.com")},
		{"linux v4", "8.8.8.8", "linux", "traceroute", with("8.8.8.8")},
		{"linux v6", "2001:db8::1", "linux", "traceroute", with("2001:db8::1")},
		{"linux hostname", "example.com", "linux", "traceroute", with("example.com")},
		{"other goos v6", "::1", "freebsd", "traceroute", with("::1")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			name, args := CommandFor(tt.target, tt.goos)
			if name != tt.wantName || !reflect.DeepEqual(args, tt.wantArgs) {
				t.Fatalf("got %s %v, want %s %v", name, args, tt.wantName, tt.wantArgs)
			}
		})
	}
}

func TestCommandForReturnsFreshArgs(t *testing.T) {
	_, a := CommandFor("1.1.1.1", "linux")
	a[0] = "mutated"
	_, b := CommandFor("1.1.1.1", "linux")
	if b[0] != "-n" {
		t.Fatalf("args shared between calls: %v", b)
	}
}
