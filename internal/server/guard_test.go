package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testPort = 47800

func req(host, origin string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	return r
}

func TestCheckUpgrade(t *testing.T) {
	tests := []struct {
		name         string
		host, origin string
		wantErr      bool
	}{
		{"loopback ip origin+host", "127.0.0.1:47800", "http://127.0.0.1:47800", false},
		{"localhost origin+host", "localhost:47800", "http://localhost:47800", false},
		{"hosted origin, ip host", "127.0.0.1:47800", "https://lightpath.blackpaw.studio", false},
		{"hosted origin, localhost host", "localhost:47800", "https://lightpath.blackpaw.studio", false},
		{"cross-mapped loopback origin", "127.0.0.1:47800", "http://localhost:47800", false},
		{"evil origin", "127.0.0.1:47800", "http://evil.com", true},
		{"suffix-spoofed hosted origin", "127.0.0.1:47800", "https://lightpath.blackpaw.studio.evil.com", true},
		{"prefix-spoofed hosted origin", "127.0.0.1:47800", "https://evil.lightpath.blackpaw.studio", true},
		{"hosted origin wrong scheme", "127.0.0.1:47800", "http://lightpath.blackpaw.studio", true},
		{"hosted origin with port", "127.0.0.1:47800", "https://lightpath.blackpaw.studio:443", true},
		{"hosted origin trailing slash", "127.0.0.1:47800", "https://lightpath.blackpaw.studio/", true},
		{"null origin", "127.0.0.1:47800", "null", true},
		{"missing origin", "127.0.0.1:47800", "", true},
		{"rebinding host", "evil.com:47800", "http://127.0.0.1:47800", true},
		{"rebinding host with hosted origin", "evil.com:47800", "https://lightpath.blackpaw.studio", true},
		{"wrong host port", "127.0.0.1:1234", "http://127.0.0.1:47800", true},
		{"wrong origin port", "127.0.0.1:47800", "http://127.0.0.1:1234", true},
		{"host without port", "127.0.0.1", "http://127.0.0.1:47800", true},
		{"ipv6 loopback host", "[::1]:47800", "http://[::1]:47800", true},
		{"ipv6 loopback origin", "127.0.0.1:47800", "http://[::1]:47800", true},
		{"uppercase host", "LOCALHOST:47800", "http://localhost:47800", true},
		{"empty host", "", "http://127.0.0.1:47800", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckUpgrade(req(tc.host, tc.origin), testPort)
			if (err != nil) != tc.wantErr {
				t.Fatalf("CheckUpgrade(host=%q origin=%q) err=%v, wantErr=%v", tc.host, tc.origin, err, tc.wantErr)
			}
		})
	}
}

func TestCheckOriginRejectsDuplicateHeaders(t *testing.T) {
	r := req("127.0.0.1:47800", "http://127.0.0.1:47800")
	r.Header.Add("Origin", "http://evil.com")
	if err := CheckOrigin(r, testPort); err == nil {
		t.Fatal("expected duplicate Origin headers to be rejected")
	}
}

func TestGuardHostBlocksEveryRoute(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := GuardHost(testPort, next)
	for _, tc := range []struct {
		host string
		want int
	}{
		{"127.0.0.1:47800", http.StatusTeapot},
		{"localhost:47800", http.StatusTeapot},
		{"evil.com:47800", http.StatusForbidden},
		{"127.0.0.1:1", http.StatusForbidden},
	} {
		for _, path := range []string{"/", "/ws", "/assets/app.js"} {
			r := httptest.NewRequest(http.MethodGet, path, nil)
			r.Host = tc.host
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Errorf("host=%q path=%q: got %d want %d", tc.host, path, w.Code, tc.want)
			}
		}
	}
}
