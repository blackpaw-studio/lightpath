package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

const placeholderHTML = `<!doctype html><meta charset="utf-8"><title>Lightpath</title>
<body style="font:16px system-ui;background:#05070d;color:#cfe;padding:2rem">
<h1>Lightpath agent is running</h1>
<p>The web UI has not been built into this binary. Run <code>make ui</code> and rebuild.</p>`

// Static serves fsys read-only (GET/HEAD). Directories are never listed,
// dotfiles are hidden, and a placeholder page stands in for a missing
// index.html at the root. A nil fsys serves only the placeholder.
func Static(fsys fs.FS) http.Handler {
	var files http.Handler
	if fsys != nil {
		files = http.FileServerFS(fsys)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "."
		}
		if hasDotElement(name) {
			http.NotFound(w, r)
			return
		}
		if fsys == nil {
			servePlaceholder(w, r, name)
			return
		}
		info, err := fs.Stat(fsys, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if info.IsDir() {
			if _, err := fs.Stat(fsys, path.Join(name, "index.html")); err != nil {
				servePlaceholder(w, r, name)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
}

func servePlaceholder(w http.ResponseWriter, r *http.Request, name string) {
	if name != "." {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(placeholderHTML))
}

func hasDotElement(name string) bool {
	for _, el := range strings.Split(name, "/") {
		if strings.HasPrefix(el, ".") && el != "." {
			return true
		}
	}
	return false
}
