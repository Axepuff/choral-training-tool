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
