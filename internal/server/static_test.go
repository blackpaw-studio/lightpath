package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func get(h http.Handler, method, path string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestStaticServesEmbeddedFiles(t *testing.T) {
	h := Static(fstest.MapFS{
		"index.html":    {Data: []byte("<h1>ui</h1>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
		".gitkeep":      {Data: nil},
	})
	if w := get(h, "GET", "/"); w.Code != 200 || !strings.Contains(w.Body.String(), "<h1>ui</h1>") {
		t.Fatalf("index: %d %q", w.Code, w.Body.String())
	}
	if w := get(h, "GET", "/assets/app.js"); w.Code != 200 {
		t.Fatalf("asset: %d", w.Code)
	}
	if w := get(h, "GET", "/missing.js"); w.Code != 404 {
		t.Fatalf("missing: %d", w.Code)
	}
	if w := get(h, "GET", "/.gitkeep"); w.Code != 404 {
		t.Fatalf("dotfile: %d", w.Code)
	}
	if w := get(h, "GET", "/assets/"); w.Code != 404 {
		t.Fatalf("directory without index must not list: %d", w.Code)
	}
	if w := get(h, "POST", "/"); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("post: %d", w.Code)
	}
}

func TestStaticPlaceholderWhenUINotBuilt(t *testing.T) {
	for name, fsys := range map[string]fstest.MapFS{"empty": {}, "only gitkeep": {".gitkeep": {}}} {
		w := get(Static(fsys), "GET", "/")
		if w.Code != 200 || !strings.Contains(w.Body.String(), "make ui") {
			t.Errorf("%s: placeholder missing: %d %q", name, w.Code, w.Body.String())
		}
	}
	if w := get(Static(nil), "GET", "/"); w.Code != 200 {
		t.Errorf("nil fs: %d", w.Code)
	}
}
