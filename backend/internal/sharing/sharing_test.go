package sharing

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

const origin = "https://sharing.example.test"
const password = "fictional password 123"

type actor struct {
	id, csrf string
	cookie   *http.Cookie
}
type fixture struct {
	t           *testing.T
	dir         string
	db          *sql.DB
	h           http.Handler
	s           *Service
	a, b, admin actor
	storage     *fixtureStorage
}

// Only Storage is a fixture for #7/#8. Auth, HTTP and SQLite are real.
type fixtureStorage struct {
	files  map[string][]byte
	opened []string
}

func (s *fixtureStorage) Stage(context.Context, string, io.Reader, int64) error {
	return errors.New("unsupported")
}
func (s *fixtureStorage) Publish(context.Context, string, string) error {
	return errors.New("unsupported")
}
func (s *fixtureStorage) Remove(context.Context, string) error { return errors.New("unsupported") }

type readCloser struct{ *bytes.Reader }

func (readCloser) Close() error { return nil }
func (s *fixtureStorage) Open(_ context.Context, key string) (io.ReadSeekCloser, error) {
	s.opened = append(s.opened, key)
	b, ok := s.files[key]
	if !ok {
		return nil, errors.New("missing")
	}
	return readCloser{bytes.NewReader(b)}, nil
}
func setup(t *testing.T) *fixture {
	f := &fixture{t: t, dir: t.TempDir(), storage: &fixtureStorage{files: map[string][]byte{}}}
	f.open()
	t.Cleanup(func() { f.db.Close() })
	for n, target := range []*actor{&f.admin, &f.a, &f.b} {
		role := "teacher"
		if n == 0 {
			role = "admin"
		}
		u, e := users.Create(context.Background(), f.db, fmt.Sprintf("person%d@example.test", n), password, role, n == 0)
		if e != nil {
			t.Fatal(e)
		}
		target.id = u.ID
		f.exec(`UPDATE users SET must_change_password=0 WHERE id=?`, u.ID)
		w := f.req("POST", "/api/v1/auth/login", fmt.Sprintf(`{"email":"person%d@example.test","password":%q}`, n, password), actor{}, nil)
		expect(t, w, 200)
		var v struct {
			CSRF string `json:"csrfToken"`
		}
		if e = json.Unmarshal(w.Body.Bytes(), &v); e != nil {
			t.Fatal(e)
		}
		target.csrf = v.CSRF
		target.cookie = w.Result().Cookies()[0]
	}
	return f
}
func (f *fixture) open() {
	var e error
	f.db, e = platform.OpenDatabase(context.Background(), f.dir)
	if e != nil {
		f.t.Fatal(e)
	}
	a, e := auth.New(f.db, origin, false)
	if e != nil {
		f.t.Fatal(e)
	}
	catalog, e := songs.New(f.db, a, a, f.dir)
	if e != nil {
		f.t.Fatal(e)
	}
	f.s, e = New(f.db, a, a, f.storage, f.dir)
	if e != nil {
		f.t.Fatal(e)
	}
	f.h = platform.NewService(platform.Config{}, f.db, slog.New(slog.NewTextHandler(io.Discard, nil)), a.Register, catalog.Register, f.s.Register).Server.Handler
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, e := f.db.Exec(q, args...); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) req(method, path, body string, a actor, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, origin+path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", origin)
	r.Header.Set("X-CSRF-Token", a.csrf)
	if a.cookie != nil {
		r.AddCookie(a.cookie)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}
func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("got %d want %d: %s", w.Code, status, w.Body.String())
	}
}
func (f *fixture) song(owner actor, ready bool) (string, string, string) {
	id, tr, asset := users.ID(), users.ID(), users.ID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	f.exec(`INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,notes,created_at,updated_at) VALUES(?,?,'Песня',84,4,4,'Заметка',?,?)`, id, owner.id, now, now)
	f.exec(`INSERT INTO tracks(id,song_id,position,name) VALUES(?,?,0,'Сопрано')`, tr, id)
	if ready {
		f.exec(`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,state,playback_path,peaks_path,duration_ms,mime,sample_rate,channels,created_at,updated_at) VALUES(?,?,'private/original',12,?,'ready',?,?,6000,'audio/mp4',48000,1,?,?)`, asset, tr, []byte("fictional hash"), asset+"/media", asset+"/peaks", now, now)
		f.exec(`UPDATE tracks SET active_asset_id=? WHERE id=?`, asset, tr)
		f.exec(`UPDATE songs SET publication='published' WHERE id=?`, id)
		f.storage.files[asset+"/media"] = []byte("0123456789")
		f.storage.files[asset+"/peaks"] = []byte(`{"startMs":0,"stepMs":100,"durationMs":6000,"points":[]}`)
	}
	return id, tr, asset
}
func (f *fixture) create(a actor, kind, id string) (secret, string) {
	f.t.Helper()
	field := "ownerId"
	if kind == "song" {
		field = "songId"
	}
	key := users.ID()
	w := f.req("POST", "/api/v1/shares", fmt.Sprintf(`{"kind":%q,%q:%q}`, kind, field, id), a, map[string]string{"Idempotency-Key": key})
	expect(f.t, w, 201)
	var result secret
	if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		f.t.Fatal(e)
	}
	if len(result.Token) != 43 || w.Header().Get("Location") != "/api/v1/shares/"+result.Share.ID {
		f.t.Fatal("invalid secret response")
	}
	return result, key
}
func publicPath(v secret) string { return "/api/v1/public/shares/" + v.Token }
func mediaPath(v secret, song, track string) string {
	return publicPath(v) + "/songs/" + song + "/tracks/" + track + "/media"
}
func TestScopesRevocationRotationAndMedia(t *testing.T) {
	f := setup(t)
	a, ta, _ := f.song(f.a, true)
	b, tb, _ := f.song(f.b, true)
	draft, td, _ := f.song(f.a, false)
	song, key := f.create(f.a, "song", a)
	list, _ := f.create(f.a, "list", f.a.id)
	other, _ := f.create(f.b, "song", b)
	for _, v := range []secret{song, list, other} {
		w := f.req("GET", publicPath(v), "", actor{}, nil)
		expect(t, w, 200)
		for _, private := range []string{"ownerId", "pendingJobId", "source_path", "password", "private/original", "updatedAt", "publication", "version"} {
			if strings.Contains(w.Body.String(), private) {
				t.Fatalf("leak %s", private)
			}
		}
	}
	// Admin cookie cannot extend a public song/list grant.
	for _, v := range []secret{song, list} {
		for _, pair := range [][2]string{{b, tb}, {draft, td}, {a, tb}} {
			for _, method := range []string{"GET", "HEAD"} {
				expect(t, f.req(method, mediaPath(v, pair[0], pair[1]), "", f.admin, map[string]string{"Range": "bytes=0-1"}), 404)
			}
		}
	}
	expect(t, f.req("GET", publicPath(secret{Token: strings.Repeat("A", 43)}), "", f.admin, nil), 404)
	expect(t, f.req("GET", publicPath(secret{Token: "not-a-token"}), "", actor{}, nil), 404)
	var received []byte
	for _, v := range []secret{song, list} {
		path := mediaPath(v, a, ta)
		w := f.req("GET", path, "", actor{}, nil)
		expect(t, w, 200)
		received = append([]byte(nil), w.Body.Bytes()...)
		if string(received) != "0123456789" || w.Header().Get("Content-Type") != "audio/mp4" || w.Header().Get("Accept-Ranges") != "bytes" || w.Header().Get("Content-Length") != "10" || w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("ETag") == "" {
			t.Fatal("bad playback")
		}
		head := f.req("HEAD", path, "", actor{}, nil)
		expect(t, head, 200)
		if head.Body.Len() != 0 || head.Header().Get("Content-Length") != "10" {
			t.Fatal("HEAD")
		}
		w = f.req("GET", path, "", actor{}, map[string]string{"Range": "bytes=2-5"})
		expect(t, w, 206)
		if w.Body.String() != "2345" || w.Header().Get("Content-Range") != "bytes 2-5/10" {
			t.Fatal("range")
		}
		w = f.req("GET", path, "", actor{}, map[string]string{"Range": "bytes=20-"})
		expect(t, w, 416)
		if w.Header().Get("Content-Range") != "bytes */10" || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("invalid range")
		}
		w = f.req("GET", strings.TrimSuffix(path, "media")+"peaks", "", actor{}, nil)
		expect(t, w, 200)
		if w.Header().Get("Content-Type") != "application/json" {
			t.Fatal("peaks mime")
		}
	}
	for _, key := range f.storage.opened {
		if strings.Contains(key, "original") {
			t.Fatal("opened original")
		}
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		w := f.req(method, publicPath(song), "{}", actor{}, nil)
		if w.Code < 400 {
			t.Fatal("public write")
		}
	}
	expect(t, f.req("PUT", "/api/v1/songs/"+a+"?token="+song.Token, "{}", actor{}, nil), 401)
	expect(t, f.req("DELETE", "/api/v1/shares/"+song.Share.ID, "", f.b, nil), 404)
	expect(t, f.req("POST", "/api/v1/shares/"+song.Share.ID+"/rotate", "", f.a, map[string]string{"X-CSRF-Token": "wrong"}), 403)
	f.db.Close()
	f.open()
	body := fmt.Sprintf(`{"kind":"song","songId":%q}`, a)
	w := f.req("POST", "/api/v1/shares", body, f.a, map[string]string{"Idempotency-Key": key})
	expect(t, w, 201)
	var replay secret
	_ = json.Unmarshal(w.Body.Bytes(), &replay)
	if replay.Token != song.Token {
		t.Fatal("replay changed token")
	}
	w = f.req("POST", "/api/v1/shares/"+song.Share.ID+"/rotate", "", f.admin, nil)
	expect(t, w, 200)
	var rotated secret
	_ = json.Unmarshal(w.Body.Bytes(), &rotated)
	if rotated.Token == song.Token {
		t.Fatal("rotation reused token")
	}
	for _, method := range []string{"GET", "HEAD"} {
		expect(t, f.req(method, mediaPath(song, a, ta), "", f.admin, map[string]string{"Range": "bytes=0-1"}), 404)
	}
	expect(t, f.req("GET", publicPath(song), "", actor{}, nil), 404)
	expect(t, f.req("GET", publicPath(rotated), "", actor{}, nil), 200)
	expect(t, f.req("GET", publicPath(list), "", actor{}, nil), 200)
	expect(t, f.req("POST", "/api/v1/shares", body, f.a, map[string]string{"Idempotency-Key": key}), 409)
	expect(t, f.req("DELETE", "/api/v1/shares/"+rotated.Share.ID, "", f.a, nil), 204)
	expect(t, f.req("GET", publicPath(rotated), "", actor{}, nil), 404)
	// Revocation stops new reads, but cannot erase bytes already held by a browser.
	if string(received) != "0123456789" {
		t.Fatal("previously received bytes changed")
	}
	expect(t, f.req("GET", publicPath(other), "", actor{}, nil), 200)
	expect(t, f.req("POST", "/api/v1/shares/"+rotated.Share.ID+"/rotate", "", f.a, nil), 200)
}

func TestSnapshotAndReadiness(t *testing.T) {
	f := setup(t)
	first, tr, asset := f.song(f.a, true)
	second, _, _ := f.song(f.a, true)
	f.exec(`UPDATE songs SET updated_at='2090-01-01T00:00:00Z' WHERE id=?`, first)
	list, _ := f.create(f.a, "list", f.a.id)
	single, _ := f.create(f.a, "song", first)
	type result struct {
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
		Next *string `json:"nextCursor"`
	}
	var page result
	w := f.req("GET", publicPath(list)+"?limit=1", "", actor{}, nil)
	expect(t, w, 200)
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Songs) != 1 || page.Songs[0].ID != first || page.Next == nil {
		t.Fatal("first page")
	}
	cursor := *page.Next
	third, _, _ := f.song(f.a, true)
	_ = third
	// Snapshot order/membership persists while fields/readiness remain live.
	f.exec(`UPDATE songs SET updated_at='2099-01-01T00:00:00Z' WHERE id=?`, second)
	w = f.req("GET", publicPath(list)+"?cursor="+url.QueryEscape(cursor), "", actor{}, nil)
	expect(t, w, 200)
	if json.Unmarshal(w.Body.Bytes(), &page) != nil || len(page.Songs) != 1 || page.Songs[0].ID != second || page.Next != nil {
		t.Fatal("snapshot changed")
	}
	other, _ := f.create(f.a, "list", f.a.id)
	expect(t, f.req("GET", publicPath(other)+"?cursor="+url.QueryEscape(cursor), "", actor{}, nil), 400)
	expect(t, f.req("GET", publicPath(list)+"?cursor=bad", "", actor{}, nil), 400)
	for _, state := range []string{"processing", "failed", "retired"} {
		f.exec(`UPDATE assets SET state=? WHERE id=?`, state, asset)
		expect(t, f.req("GET", publicPath(single), "", f.admin, nil), 404)
		expect(t, f.req("HEAD", mediaPath(list, first, tr), "", actor{}, nil), 404)
	}
	f.exec(`UPDATE assets SET state='ready' WHERE id=?`, asset)
	f.exec(`UPDATE songs SET publication='draft' WHERE id=?`, first)
	expect(t, f.req("GET", publicPath(single), "", actor{}, nil), 404)
	expect(t, f.req("GET", mediaPath(list, first, tr), "", actor{}, nil), 404)
	f.exec(`UPDATE songs SET publication='published' WHERE id=?`, first)
	f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
	expect(t, f.req("GET", publicPath(list)+"?cursor="+url.QueryEscape(cursor), "", actor{}, nil), 410)
	f.s.now = time.Now
	expect(t, f.req("DELETE", "/api/v1/shares/"+list.Share.ID, "", f.a, nil), 204)
	expect(t, f.req("GET", publicPath(list)+"?cursor="+url.QueryEscape(cursor), "", actor{}, nil), 404)
}

func TestManagementReplayAndFailures(t *testing.T) {
	f := setup(t)
	id, tr, asset := f.song(f.a, true)
	draft, empty, _ := f.song(f.a, false)
	body := fmt.Sprintf(`{"kind":"song","songId":%q}`, id)
	for _, input := range []string{`{}`, `null`, `{"kind":"list","ownerId":null}`, `{"kind":"list","ownerId":"wrong"}`, fmt.Sprintf(`{"kind":"song","songId":%q,"ownerId":%q}`, id, f.a.id), fmt.Sprintf(`{"kind":"song","SongId":%q}`, id), body + `{}`} {
		expect(t, f.req("POST", "/api/v1/shares", input, f.a, map[string]string{"Idempotency-Key": users.ID()}), 422)
	}
	expect(t, f.req("POST", "/api/v1/shares", body, actor{}, nil), 401)
	expect(t, f.req("POST", "/api/v1/shares", body, f.a, nil), 422)
	expect(t, f.req("POST", "/api/v1/shares", body, f.b, map[string]string{"Idempotency-Key": users.ID()}), 404)
	expect(t, f.req("POST", "/api/v1/shares", fmt.Sprintf(`{"kind":"list","ownerId":%q}`, f.b.id), f.a, map[string]string{"Idempotency-Key": users.ID()}), 404)
	v, key := f.create(f.a, "song", id)
	list, _ := f.create(f.admin, "list", f.a.id)
	w := f.req("GET", "/api/v1/shares", "", f.a, nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), v.Token) || strings.Contains(w.Body.String(), "token") {
		t.Fatal("share listing disclosed secret")
	}
	expect(t, f.req("GET", "/api/v1/shares?ownerId="+f.a.id, "", f.b, nil), 403)
	expect(t, f.req("GET", "/api/v1/shares?ownerId="+f.a.id, "", f.admin, nil), 200)
	headers := map[string]string{"Idempotency-Key": key}
	expect(t, f.req("POST", "/api/v1/shares", fmt.Sprintf(`{"kind":"song","songId":%q}`, draft), f.a, headers), 409)
	// Persist only hash / encrypted replay; no plaintext bearer token in SQLite fields.
	var storedHash, ciphertext []byte
	if e := f.db.QueryRow(`SELECT token_hash FROM shares WHERE id=?`, v.Share.ID).Scan(&storedHash); e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(storedHash, hash(v.Token)) {
		t.Fatal("token hash")
	}
	if e := f.db.QueryRow(`SELECT response_ciphertext FROM idempotency_records WHERE actor=? AND key=?`, f.a.id, key).Scan(&ciphertext); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(ciphertext, []byte(v.Token)) {
		t.Fatal("plaintext replay")
	}
	// Failed persistence rolls back both the share and the secret replay.
	var before int
	_ = f.db.QueryRow(`SELECT count(*) FROM shares`).Scan(&before)
	f.exec(`CREATE TRIGGER reject_share_replay BEFORE INSERT ON idempotency_records WHEN NEW.url='/api/v1/shares' BEGIN SELECT RAISE(ABORT,'fixture failure'); END`)
	expect(t, f.req("POST", "/api/v1/shares", body, f.a, map[string]string{"Idempotency-Key": users.ID()}), 503)
	var after int
	_ = f.db.QueryRow(`SELECT count(*) FROM shares`).Scan(&after)
	if before != after {
		t.Fatal("partial creation")
	}
	f.exec(`DROP TRIGGER reject_share_replay`)
	// Private media: owner/admin may read a ready draft; other teacher cannot.
	private := "/api/v1/songs/" + id + "/tracks/" + tr + "/media"
	expect(t, f.req("GET", private, "", actor{}, nil), 401)
	expect(t, f.req("GET", private, "", f.b, nil), 200)
	f.exec(`UPDATE songs SET publication='draft' WHERE id=?`, id)
	expect(t, f.req("GET", private, "", f.b, nil), 404)
	for _, a := range []actor{f.a, f.admin} {
		expect(t, f.req("HEAD", private, "", a, nil), 200)
	}
	expect(t, f.req("GET", "/api/v1/songs/"+draft+"/tracks/"+empty+"/media", "", f.a, nil), 409)
	// Storage failure is an error, never an empty success or original-file fallback.
	delete(f.storage.files, asset+"/media")
	expect(t, f.req("GET", private, "", f.a, nil), 503)
	f.storage.files[asset+"/media"] = []byte("0123456789")
	f.exec(`UPDATE songs SET publication='published' WHERE id=?`, id)
	// Pending/failed replacement cannot replace the previously committed ready asset.
	pending := users.ID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	f.exec(`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,state,created_at,updated_at) VALUES(?,?,'private/pending',12,?,'processing',?,?)`, pending, tr, []byte("fixture hash"), now, now)
	f.exec(`UPDATE tracks SET pending_asset_id=? WHERE id=?`, pending, tr)
	expect(t, f.req("GET", mediaPath(list, id, tr), "", actor{}, nil), 200)
	f.exec(`UPDATE assets SET state='failed' WHERE id=?`, pending)
	expect(t, f.req("GET", mediaPath(v, id, tr), "", actor{}, nil), 200)
	// A forged active reference cannot borrow another track's asset.
	_, foreignTrack, foreignAsset := f.song(f.b, true)
	_ = foreignTrack
	f.exec(`UPDATE tracks SET active_asset_id=? WHERE id=?`, foreignAsset, tr)
	expect(t, f.req("GET", publicPath(v), "", f.admin, nil), 404)
	expect(t, f.req("GET", mediaPath(list, id, tr), "", f.admin, nil), 404)
	f.exec(`UPDATE tracks SET active_asset_id=? WHERE id=?`, asset, tr)
	// Session revocation gates management even with a valid CSRF value.
	f.exec(`UPDATE sessions SET revoked_at=? WHERE user_id=?`, now, f.a.id)
	expect(t, f.req("DELETE", "/api/v1/shares/"+v.Share.ID, "", f.a, nil), 401)
	expect(t, f.req("GET", mediaPath(v, id, tr), "", actor{}, nil), 200)
	expect(t, f.req("DELETE", "/api/v1/shares/"+v.Share.ID, "", f.admin, nil), 204)
	expect(t, f.req("GET", mediaPath(v, id, tr), "", actor{}, nil), 404)
	expect(t, f.req("GET", publicPath(list), "", actor{}, nil), 200)
}

func TestListRotationAndSongDeletionThroughAPI(t *testing.T) {
	f := setup(t)
	id, tr, _ := f.song(f.a, true)
	a, key := f.create(f.a, "list", f.a.id)
	b, _ := f.create(f.a, "list", f.a.id)
	song, _ := f.create(f.a, "song", id)
	expect(t, f.req("DELETE", "/api/v1/shares/"+a.Share.ID, "", f.admin, nil), 204)
	expect(t, f.req("HEAD", mediaPath(a, id, tr), "", actor{}, nil), 404)
	expect(t, f.req("GET", publicPath(b), "", actor{}, nil), 200)
	expect(t, f.req("POST", "/api/v1/shares", fmt.Sprintf(`{"kind":"list","ownerId":%q}`, f.a.id), f.a, map[string]string{"Idempotency-Key": key}), 409)
	w := f.req("POST", "/api/v1/shares/"+a.Share.ID+"/rotate", "", f.a, nil)
	expect(t, w, 200)
	var rotated secret
	_ = json.Unmarshal(w.Body.Bytes(), &rotated)
	if rotated.Token == a.Token || rotated.Share.Disabled != nil {
		t.Fatal("reactivation reused token")
	}
	expect(t, f.req("GET", publicPath(a), "", f.admin, nil), 404)
	expect(t, f.req("GET", mediaPath(rotated, id, tr), "", actor{}, nil), 200)
	// A published song can be withdrawn through the actual songs API.
	body := fmt.Sprintf(`{"title":"Песня","bpm":84,"beatsPerBar":4,"beatUnit":4,"notes":"","publication":"draft","tracks":[{"id":%q,"name":"Сопрано","position":0,"gain":1}]}`, tr)
	expect(t, f.req("PUT", "/api/v1/songs/"+id, body, f.a, map[string]string{"If-Match": `"1"`}), 200)
	expect(t, f.req("GET", publicPath(song), "", f.admin, nil), 404)
	w = f.req("GET", publicPath(b), "", actor{}, nil)
	expect(t, w, 200)
	if !strings.Contains(w.Body.String(), `"songs":[]`) {
		t.Fatal("draft leaked in list")
	}
	expect(t, f.req("DELETE", "/api/v1/songs/"+id, "", f.a, map[string]string{"If-Match": `"2"`}), 204)
	expect(t, f.req("POST", "/api/v1/shares/"+song.Share.ID+"/rotate", "", f.admin, nil), 404)
	expect(t, f.req("GET", publicPath(song), "", actor{}, nil), 404)
	expect(t, f.req("GET", publicPath(rotated), "", actor{}, nil), 200)
}
