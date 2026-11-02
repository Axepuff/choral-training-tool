package platform

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFrontendRoutes(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "assets"), 0700)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte(`<script src="/assets/app.js"></script>`), 0600)
	os.WriteFile(filepath.Join(dir, "assets/app.js"), []byte(`console.log('real asset')`), 0600)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("private"), 0600)
	db, err := OpenDatabase(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := NewService(Config{StaticDir: dir}, db, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tc := range []struct {
		url, method, want string
		status            int
	}{
		{"/?song=token", "GET", "/assets/app.js", 200},
		{"/listen/song?list=token", "GET", "/assets/app.js", 200},
		{"/assets/app.js?v=1", "GET", "real asset", 200},
		{"/listen/song", "HEAD", "", 200},
		{"/assets/missing.js", "GET", "404", 404},
		{"/api/missing", "GET", "not_found", 404},
		{"/api", "GET", "not_found", 404},
		{"/.env", "GET", "404", 404},
		{"/choral.sqlite", "GET", "404", 404},
		{"/", "POST", "", 405},
		{"/readyz", "GET", "ready", 200},
	} {
		r := httptest.NewRecorder()
		svc.Server.Handler.ServeHTTP(r, httptest.NewRequest(tc.method, tc.url, nil))
		if r.Code != tc.status || !strings.Contains(r.Body.String(), tc.want) {
			t.Errorf("%s %s: %d %s", tc.method, tc.url, r.Code, r.Body.String())
		}
		if tc.method == "HEAD" && r.Body.Len() != 0 {
			t.Fatal("HEAD returned body")
		}
	}
	if ValidateFrontend(t.TempDir()) == nil {
		t.Fatal("missing build accepted")
	}
}

func TestFrontendCacheAndAtomicSwitch(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"one", "two"} {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Join(dir, "assets"), 0700); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, "index.html"), []byte(name), 0600)
		os.WriteFile(filepath.Join(dir, "assets", "app-12345678.js"), []byte("immutable"), 0600)
		os.WriteFile(filepath.Join(dir, "assets", "aac.worker-12345678.js"), []byte("worker"), 0600)
	}
	current := filepath.Join(root, "current")
	os.Symlink("one", current)
	handler := frontend(current)
	get := func(url, etag string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", url, nil)
		if etag != "" {
			r.Header.Set("If-None-Match", etag)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	one := get("/listen/deep", "")
	if one.Body.String() != "one" || one.Header().Get("Cache-Control") != "no-cache" || one.Header().Get("ETag") == "" {
		t.Fatalf("index/cache: %v %s", one.Header(), one.Body.String())
	}
	if w := get("/", one.Header().Get("ETag")); w.Code != 304 {
		t.Fatalf("unchanged index: %d", w.Code)
	}
	os.Symlink("two", filepath.Join(root, "next"))
	os.Rename(filepath.Join(root, "next"), current)
	if w := get("/", one.Header().Get("ETag")); w.Code != 200 || w.Body.String() != "two" {
		t.Fatalf("release switch returned stale index: %d %s", w.Code, w.Body.String())
	}
	if w := get("/index.html", ""); w.Body.String() != "two" || w.Header().Get("Cache-Control") != "no-cache" {
		t.Fatal("direct index bypassed revalidation")
	}
	if w := get("/assets/app-12345678.js", ""); w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatal("hashed asset missing immutable cache")
	}
	if w := get("/assets/aac.worker-12345678.js", ""); w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatal("Vite worker asset missing immutable cache")
	}
	if w := get("/assets/missing-12345678.js", ""); w.Code != 404 || strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatal("missing asset was cached as immutable")
	}
}
