package auth_test

import (
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/sharing"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

// Opt-in browser integration: real SQLite, password verification, cookies and
// CSRF through Vite's proxy. All accounts/data belong to this disposable fixture.
func TestFrontendBrowser(t *testing.T) {
	if os.Getenv("CHORAL_BROWSER_TEST") != "true" {
		t.Skip("set CHORAL_BROWSER_TEST=true; requires Node dependencies and Chrome")
	}
	dir := t.TempDir()
	db, err := platform.OpenDatabase(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = users.Create(context.Background(), db, strings.Repeat("a", 64)+"@"+strings.Repeat("b", 63)+".test", "fictional password 123", "admin", true)
	if err != nil {
		t.Fatal(err)
	}
	teacher, err := users.Create(context.Background(), db, "teacher@example.test", "fictional password 123", "teacher", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET must_change_password=0 WHERE id=?`, teacher.ID); err != nil {
		t.Fatal(err)
	}
	// Synthetic published metadata fixtures, no original/media files or production data.
	songID, trackID, assetID := users.ID(), users.ID(), users.ID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	queries := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,notes,publication,created_at,updated_at) VALUES(?,?,'Тестовая песня',84,4,4,'Тестовая заметка','published',?,?)`, []any{songID, teacher.ID, now, now}},
		{`INSERT INTO tracks(id,song_id,position,name) VALUES(?,?,0,'Сопрано')`, []any{trackID, songID}},
		{`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,state,playback_path,peaks_path,duration_ms,mime,sample_rate,channels,created_at,updated_at) VALUES(?,?,'fixture',12,?,'ready','fixture/media','fixture/peaks',6000,'audio/mp4',48000,1,?,?)`, []any{assetID, trackID, []byte("fictional hash"), now, now}},
		{`UPDATE tracks SET active_asset_id=? WHERE id=?`, []any{assetID, trackID}},
	}
	for _, q := range queries {
		if _, err := db.Exec(q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, kind := range []string{"song", "list"} {
		raw := strings.Repeat("A", 43)
		var song any = songID
		if kind == "list" {
			raw = strings.Repeat("B", 42) + "A"
			song = nil
		}
		hash := sha256.Sum256([]byte(raw))
		if _, err := db.Exec(`INSERT INTO shares(id,kind,owner_id,song_id,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, users.ID(), kind, teacher.ID, song, hash[:], now, now); err != nil {
			t.Fatal(err)
		}
	}
	s, err := auth.New(db, "http://127.0.0.1:5179", true)
	if err != nil {
		t.Fatal(err)
	}
	public, err := sharing.New(db, s, s, nil, dir)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	public.Register(mux)
	// Test-only control endpoint; never registered by cmd/server.
	mux.HandleFunc("POST /__test/block", func(w http.ResponseWriter, r *http.Request) {
		_, err := db.ExecContext(r.Context(), `UPDATE users SET blocked_at='2026-01-01T00:00:00Z' WHERE id=?`, teacher.ID)
		if err != nil {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	})
	// Long, unbroken server values exercise wrapping rather than short demo text.
	mux.HandleFunc("POST /__test/long-metadata", func(w http.ResponseWriter, r *http.Request) {
		if _, err := db.ExecContext(r.Context(), `UPDATE songs SET title=?, notes=? WHERE id=?`, strings.Repeat("Я", 160), strings.Repeat("Ж", 1000), songID); err != nil {
			w.WriteHeader(500)
			return
		}
		if _, err := db.ExecContext(r.Context(), `UPDATE tracks SET name=? WHERE id=?`, strings.Repeat("Щ", 80), trackID); err != nil {
			w.WriteHeader(500)
			return
		}
		w.WriteHeader(204)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "../../../tests/auth-browser.mjs")
	cmd.Env = append(os.Environ(), "CHORAL_TEST_API="+server.URL)
	// The browser uses only the fictional credentials already in auth tests.
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("browser integration: %v\n%s", err, output)
	} else {
		t.Log(string(output))
	}
}
