package platform

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/migrations"
)

func TestDatabaseLifecycle(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	db, err := OpenDatabase(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"PRAGMA foreign_keys", "PRAGMA busy_timeout"} {
		var n int
		if err := db.QueryRow(query).Scan(&n); err != nil || n == 0 {
			t.Fatalf("%s: %d %v", query, n, err)
		}
	}
	var mode string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("WAL: %s %v", mode, err)
	}
	if _, err := db.Exec(`INSERT INTO users VALUES ('u','user@example.test','hash','teacher',NULL,1,'now','now')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sessions VALUES ('s','missing',x'01',x'02','later',NULL,'now','now')`); err == nil {
		t.Fatal("foreign key accepted")
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(`UPDATE users SET role='admin' WHERE id='u'`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = OpenDatabase(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var role string
	if err = db.QueryRow("SELECT role FROM users WHERE id='u'").Scan(&role); err != nil || role != "teacher" {
		t.Fatalf("persistence/rollback: %s %v", role, err)
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 5 {
		t.Fatalf("migration repeated: %d %v", count, err)
	}
	// Force a new connection to verify connection-level pragmas survive reconnect.
	db.SetMaxIdleConns(0)
	var fk int
	if err = db.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("reconnected FK: %d %v", fk, err)
	}
	db.SetMaxIdleConns(1)
	if _, err = db.Exec("UPDATE schema_migrations SET checksum='changed'"); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, db); err == nil {
		t.Fatal("modified migration accepted")
	}
}
func TestUnavailableDatabase(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if err := os.WriteFile(path, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if db, err := OpenDatabase(context.Background(), path); err == nil {
		db.Close()
		t.Fatal("invalid directory accepted")
	}
	if err := os.WriteFile(filepath.Join(dir, "choral.sqlite"), []byte("not sqlite"), 0600); err != nil {
		t.Fatal(err)
	}
	if db, err := OpenDatabase(context.Background(), dir); err == nil {
		db.Close()
		t.Fatal("corrupt database accepted")
	}
}
func TestHealthAndSafeLogging(t *testing.T) {
	db, err := OpenDatabase(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var logs bytes.Buffer
	s := NewService(Config{}, db, slog.New(slog.NewJSONHandler(&logs, nil)))
	check := func(path string, want int) {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Cookie", "secret-cookie")
		w := httptest.NewRecorder()
		s.Server.Handler.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s: %d", path, w.Code)
		}
		if w.Header().Get("X-Request-Id") == "" {
			t.Fatal("missing request id")
		}
	}
	check("/livez", 200)
	check("/readyz", 200)
	check("/api/v1/public/shares/secret-token?key=secret-query", 404)
	s.stopping.Store(true)
	check("/readyz", 503)
	s.stopping.Store(false)
	db.Close()
	check("/readyz", 503)
	check("/livez", 200)
	if strings.Contains(logs.String(), "secret") {
		t.Fatal("secret in logs")
	}
}
func TestGracefulShutdownDrainsRequest(t *testing.T) {
	db, err := OpenDatabase(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	s := NewService(Config{ShutdownTimeout: 2 * time.Second}, db, slog.New(slog.NewTextHandler(io.Discard, nil)))
	entered, release := make(chan struct{}), make(chan struct{})
	s.Server.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; w.Write([]byte("finished")) })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx, listener) }()
	response := make(chan string, 1)
	go func() {
		client := http.Client{Timeout: 3 * time.Second}
		r, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			response <- err.Error()
			return
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		response <- string(b)
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		t.Fatalf("shutdown did not drain: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if got := <-response; got != "finished" {
		t.Fatal(got)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown stalled")
	}
}
func TestConfigRejectsInvalidValues(t *testing.T) {
	for _, entry := range []struct{ key, value string }{{"CHORAL_ADDR", "bad"}, {"CHORAL_DATA_DIR", ""}, {"CHORAL_SHUTDOWN_TIMEOUT", "0s"}, {"CHORAL_SHUTDOWN_TIMEOUT", "2m"}} {
		t.Run(entry.key+entry.value, func(t *testing.T) {
			t.Setenv(entry.key, entry.value)
			if _, err := LoadConfig(); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
}

func TestFailedMigrationRollsBack(t *testing.T) {
	db, err := OpenDatabase(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	err = applyMigration(context.Background(), db, "test.sql", []byte("CREATE TABLE partial (id TEXT); INSERT INTO nonexistent VALUES (1);"))
	if err == nil {
		t.Fatal("broken migration succeeded")
	}
	var count int
	if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='partial'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial schema: %d %v", count, err)
	}
	if err = db.QueryRow("SELECT count(*) FROM schema_migrations WHERE name='test.sql'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial version: %d %v", count, err)
	}
}

func TestReadyAssetRequiresMetadata(t *testing.T) {
	db, err := OpenDatabase(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, query := range []string{
		`INSERT INTO users VALUES ('u','user@example.test','hash','teacher',NULL,1,'now','now')`,
		`INSERT INTO songs (id,owner_id,title,bpm,beats_per_bar,beat_unit,created_at,updated_at) VALUES ('s','u','Song',120,4,4,'now','now')`,
		`INSERT INTO tracks (id,song_id,position,name) VALUES ('t','s',0,'Track')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	columns := []string{"playback_path", "peaks_path", "duration_ms", "mime", "sample_rate", "channels"}
	for i, column := range columns {
		t.Run(column, func(t *testing.T) {
			t.Cleanup(func() {
				if _, err := db.Exec(`DELETE FROM assets WHERE id='a'`); err != nil {
					t.Fatal(err)
				}
			})
			values := []any{"playback.m4a", "peaks.json", 1000, "audio/mp4", 48000, 1}
			values[i] = nil
			insert := `INSERT INTO assets (id,track_id,source_path,source_bytes,source_sha256,state,created_at,updated_at,playback_path,peaks_path,duration_ms,mime,sample_rate,channels) VALUES ('a','t','source',1,x'01',?,'now','now',?,?,?,?,?,?)`
			if _, err := db.Exec(insert, append([]any{"ready"}, values...)...); err == nil {
				t.Fatal("ready asset accepted NULL " + column)
			}
			if _, err := db.Exec(insert, append([]any{"processing"}, values...)...); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`UPDATE assets SET state='ready' WHERE id='a'`); err == nil {
				t.Fatal("transition to ready accepted NULL " + column)
			}
			if _, err := db.Exec(`UPDATE assets SET state='ready', playback_path='playback.m4a', peaks_path='peaks.json', duration_ms=1000, mime='audio/mp4', sample_rate=48000, channels=1 WHERE id='a'`); err != nil {
				t.Fatalf("valid ready transition rejected: %v", err)
			}
		})
	}
	if _, err := db.Exec(`INSERT INTO assets (id,track_id,source_path,playback_path,peaks_path,source_bytes,source_sha256,duration_ms,mime,sample_rate,channels,state,created_at,updated_at) VALUES ('valid','t','source','playback.m4a','peaks.json',1,x'01',1000,'audio/mp4',48000,1,'ready','now','now')`); err != nil {
		t.Fatalf("valid ready insert rejected: %v", err)
	}
}

func TestAuthMigrationUpgradesFoundation(t *testing.T) {
	ctx := context.Background()
	db, err := OpenDatabase(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Reconstruct the accepted #3 schema in this disposable database.
	for _, q := range []string{`DROP TABLE login_attempts`, `DROP INDEX sessions_user`, `DELETE FROM schema_migrations WHERE name='0002_auth.sql'`, `INSERT INTO users VALUES ('old','existing@example.test','existing-hash','teacher',NULL,1,'now','now')`} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err = Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var hash string
	if err = db.QueryRow(`SELECT password_hash FROM users WHERE id='old'`).Scan(&hash); err != nil || hash != "existing-hash" {
		t.Fatal("auth migration changed existing users")
	}
	if _, err = db.Exec(`INSERT INTO login_attempts VALUES (x'01',1,0,0)`); err != nil {
		t.Fatal(err)
	}
}

func TestSongsMigrationPreservesExistingMedia(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "upgrade.sqlite")+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	// Apply only accepted #3/#4 migrations before populating their existing schema.
	if _, err = db.Exec(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_initial.sql", "0002_auth.sql"} {
		body, e := migrations.Files.ReadFile(name)
		if e != nil {
			t.Fatal(e)
		}
		if e = applyMigration(ctx, db, name, body); e != nil {
			t.Fatal(e)
		}
	}
	for _, q := range []string{
		`INSERT INTO users VALUES ('u','existing@example.test','fictional-hash','teacher',NULL,0,'now','now')`,
		`INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,created_at,updated_at) VALUES('s','u','Existing',84,4,4,'now','now')`,
		`INSERT INTO tracks(id,song_id,position,name) VALUES('t','s',0,'Existing track')`,
		`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,state,created_at,updated_at) VALUES('a','t','internal/original',1,x'01','processing','now','now')`,
		`INSERT INTO assets VALUES ('ready','t','source','playback','peaks',1,x'02',1000,'audio/mp4',48000,1,'ready','now','now')`,
		`UPDATE tracks SET pending_asset_id='a',active_asset_id='ready' WHERE id='t'`,
		`INSERT INTO jobs(id,asset_id,state,created_at,updated_at) VALUES('j','a','processing','now','now')`,
	} {
		if _, err = db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if err = Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	if err = Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	var asset, track, job string
	if err = db.QueryRow(`SELECT t.pending_asset_id,a.track_id,j.asset_id FROM tracks t JOIN assets a ON a.id=t.pending_asset_id JOIN jobs j ON j.asset_id=a.id WHERE t.id='t' AND t.deleted_at IS NULL AND t.active_asset_id='ready'`).Scan(&asset, &track, &job); err != nil || asset != "a" || track != "t" || job != "a" {
		t.Fatalf("migration broke media links: %v", err)
	}
	rows, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("migration broke foreign keys")
	}
}
