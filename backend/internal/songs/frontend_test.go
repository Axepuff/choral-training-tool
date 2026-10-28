package songs_test

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/processing"
	"github.com/Axepuff/choral-training-tool/backend/internal/sharing"
	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/storage"
	"github.com/Axepuff/choral-training-tool/backend/internal/uploads"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

// Real HTTP/SQLite/files/FFmpeg/browser integration, entirely disposable data.
func TestSongsFrontendBrowser(t *testing.T) {
	if os.Getenv("CHORAL_BROWSER_TEST") != "true" {
		t.Skip("set CHORAL_BROWSER_TEST=true; Node and Chrome required")
	}
	// A one-shot real probe timeout, armed by the browser after its first upload.
	realProbe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Fatal(err)
	}
	probeDir := t.TempDir()
	marker := filepath.Join(probeDir, "timeout-once")
	wrapper := "#!/bin/sh\nif [ -f " + strconv.Quote(marker) + " ]; then\nrm -- " + strconv.Quote(marker) + "\nexec sleep 20\nfi\nexec " + strconv.Quote(realProbe) + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(probeDir, "ffprobe"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", probeDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("CHORAL_TEST_PROBE_MARKER", marker)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	origin := "http://" + listener.Addr().String()
	t.Cleanup(func() { _ = listener.Close() })
	dir := t.TempDir()
	db, err := platform.OpenDatabase(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, role := range []string{"admin", "teacher"} {
		u, e := users.Create(ctx, db, role+"@example.test", "fictional password 123", role, role == "admin")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(`UPDATE users SET must_change_password=0 WHERE id=?`, u.ID); e != nil {
			t.Fatal(e)
		}
	}
	outsider, err := users.Create(ctx, db, "outsider@example.test", "fictional password 123", "teacher", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE users SET must_change_password=0 WHERE id=?`, outsider.ID); err != nil {
		t.Fatal(err)
	}

	identity, err := auth.New(db, origin, true)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := songs.New(db, identity, identity, dir)
	if err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	upload, err := uploads.New(db, identity, store, dir)
	if err != nil {
		t.Fatal(err)
	}
	share, err := sharing.New(db, identity, identity, store, dir)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := processing.New(ctx, db, store)
	if err != nil {
		t.Fatal(err)
	}
	workerCtx, stopWorker := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); worker.Run(workerCtx) }()
	defer func() { stopWorker(); <-done }()
	mux := http.NewServeMux()
	identity.Register(mux)
	metadata.Register(mux)
	upload.Register(mux)
	share.Register(mux)
	staticDir := filepath.Join("..", "..", "..", "dist", "e2e-runtime")
	if err := platform.ValidateFrontend(staticDir); err != nil {
		t.Fatal(err)
	}
	service := platform.NewService(platform.Config{StaticDir: staticDir}, db,
		slog.New(slog.NewTextHandler(io.Discard, nil)), func(root *http.ServeMux) {
			root.Handle("/api/v1/", mux)
			root.Handle("/__test/", mux)
		})
	server := httptest.NewUnstartedServer(service.Server.Handler)
	if err := server.Listener.Close(); err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.Start()
	defer server.Close()
	cmd := exec.CommandContext(ctx, "node", "../../../tests/songs-browser.mjs")
	cmd.Env = append(os.Environ(), "CHORAL_TEST_API="+server.URL, "CHORAL_TEST_WEB="+origin)
	if output, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("browser integration: %v\n%s", e, output)
	} else {
		t.Log(string(output))
	}
}
