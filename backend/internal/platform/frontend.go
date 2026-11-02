package platform

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var immutableAsset = regexp.MustCompile(`^/assets/[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$`)

func ValidateFrontend(dir string) error {
	info, err := os.Stat(filepath.Join(dir, "index.html"))
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("frontend index must be a file")
	}
	return nil
}

// Only the build directory is public; data and API misses never use SPA fallback.
func frontend(dir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		clean := path.Clean("/" + r.URL.Path)
		for _, part := range strings.Split(clean, "/") {
			if strings.HasPrefix(part, ".") {
				http.NotFound(w, r)
				return
			}
		}
		// Resolve current for each request, once: a running server follows atomic
		// release switches, while an in-flight request keeps its chosen index.
		root, err := filepath.EvalSymlinks(dir)
		if err != nil {
			http.Error(w, "frontend unavailable", http.StatusServiceUnavailable)
			return
		}
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(clean)))
		if err == nil && info.Mode().IsRegular() {
			if clean == "/index.html" {
				serveIndex(w, r, root)
				return
			}
			w.Header().Set("Cache-Control", "no-cache")
			if immutableAsset.MatchString(clean) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.FileServer(http.Dir(root)).ServeHTTP(w, r)
			return
		}
		if (clean == "/assets" || strings.HasPrefix(clean, "/assets/")) || path.Ext(clean) != "" {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, root)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, root string) {
	data, err := os.ReadFile(filepath.Join(root, "index.html"))
	if err != nil {
		http.Error(w, "frontend unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", fmt.Sprintf(`"%x"`, sha256.Sum256(data)))
	// A content ETag prevents false 304s for two releases built in one second.
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(data))
}
