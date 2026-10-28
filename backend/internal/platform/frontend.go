package platform

import (
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

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
	files := http.FileServer(http.Dir(dir))
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
		info, err := os.Stat(filepath.Join(dir, filepath.FromSlash(clean)))
		if err == nil && info.Mode().IsRegular() {
			files.ServeHTTP(w, r)
			return
		}
		if (clean == "/assets" || strings.HasPrefix(clean, "/assets/")) || path.Ext(clean) != "" {
			http.NotFound(w, r)
			return
		}
		// ServeFile sees the original URL, including its query, but uses a fixed file.
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}
