package songs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

const origin = "https://songs.example.test"
const password = "fictional password 123"

type actor struct {
	cookie   *http.Cookie
	csrf, id string
}
type fixture struct {
	t           *testing.T
	db          *sql.DB
	dir         string
	s           *Service
	h           http.Handler
	a, b, admin actor
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, dir: t.TempDir()}
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
		// Account provisioning is outside songs; real login still verifies Argon2id.
		if _, e = f.db.Exec(`UPDATE users SET must_change_password=0 WHERE id=?`, u.ID); e != nil {
			t.Fatal(e)
		}
		w := f.req("POST", "/api/v1/auth/login", fmt.Sprintf(`{"email":"person%d@example.test","password":%q}`, n, password), actor{}, nil)
		expect(t, w, 200)
		var v struct {
			CSRF string `json:"csrfToken"`
		}
		if e = json.Unmarshal(w.Body.Bytes(), &v); e != nil {
			t.Fatal(e)
		}
		target.cookie = w.Result().Cookies()[0]
		target.csrf = v.CSRF
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
	f.s, e = New(f.db, a, a, f.dir)
	if e != nil {
		f.t.Fatal(e)
	}
	f.h = platform.NewService(platform.Config{}, f.db, slog.New(slog.NewTextHandler(io.Discard, nil)), a.Register, f.s.Register).Server.Handler
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
func body(title string) string {
	return fmt.Sprintf(`{"title":%q,"bpm":84,"beatsPerBar":4,"beatUnit":4,"notes":"","publication":"draft","tracks":[{"name":"Сопрано","position":0,"gain":1},{"name":"Альт","position":1,"gain":0.5}]}`, title)
}
func song(t *testing.T, w *httptest.ResponseRecorder) Song {
	t.Helper()
	var s Song
	if e := json.Unmarshal(w.Body.Bytes(), &s); e != nil {
		t.Fatal(e)
	}
	return s
}
func (f *fixture) create(title string, a actor) Song {
	f.t.Helper()
	w := f.req("POST", "/api/v1/songs", body(title), a, map[string]string{"Idempotency-Key": users.ID()})
	expect(f.t, w, 201)
	v := song(f.t, w)
	if w.Header().Get("ETag") != etag(v) || w.Header().Get("Location") != "/api/v1/songs/"+v.ID {
		f.t.Fatal("missing create headers")
	}
	return v
}
func edit(v Song) string {
	in := map[string]any{"title": v.Title, "bpm": v.BPM, "beatsPerBar": v.Beats, "beatUnit": v.Unit, "notes": v.Notes, "publication": v.Publication}
	tracks := []map[string]any{}
	for _, t := range v.Tracks {
		tracks = append(tracks, map[string]any{"id": t.ID, "name": t.Name, "position": t.Position, "gain": t.Gain})
	}
	in["tracks"] = tracks
	b, _ := json.Marshal(in)
	return string(b)
}
func (f *fixture) put(v Song, a actor) *httptest.ResponseRecorder {
	return f.req("PUT", "/api/v1/songs/"+v.ID, edit(v), a, map[string]string{"If-Match": etag(v)})
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, e := f.db.Exec(q, args...); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) count(q string, args ...any) int {
	f.t.Helper()
	var n int
	if e := f.db.QueryRow(q, args...).Scan(&n); e != nil {
		f.t.Fatal(e)
	}
	return n
}
func TestCRUDRestartConflictOwnership(t *testing.T) {
	f := setup(t)
	v := f.create("  Песня 🎵  ", f.a)
	path := "/api/v1/songs/" + v.ID
	if v.Title != "Песня 🎵" || v.Ready || v.Duration != nil || v.Tracks[0].Status != "empty" {
		t.Fatal("draft response")
	}
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		expect(t, f.req(method, path, edit(v), f.b, map[string]string{"If-Match": etag(v)}), 404)
		expect(t, f.req(method, path, edit(v), actor{}, nil), 401)
	}
	expect(t, f.req("POST", "/api/v1/songs", body("x"), f.a, map[string]string{"X-CSRF-Token": "bad"}), 403)
	expect(t, f.req("PUT", path, edit(v), f.a, nil), 428)
	other := f.create("Другой владелец", f.b)
	bad := v
	bad.Tracks = append([]Track(nil), v.Tracks...)
	bad.Tracks[0].ID = other.Tracks[0].ID
	expect(t, f.put(bad, f.a), 422)
	w := f.req("GET", path, "", f.a, nil)
	expect(t, w, 200)
	if song(t, w).Version != 1 {
		t.Fatal("failed edit changed version")
	}
	v.Notes = "Сохранённые заметки 🎶"
	v.Title = "Новое имя"
	v.Tracks[0], v.Tracks[1] = v.Tracks[1], v.Tracks[0]
	for n := range v.Tracks {
		v.Tracks[n].Position = n
	}
	v.Tracks[0].Name = "Новый альт"
	w = f.put(v, f.a)
	expect(t, w, 200)
	next := song(t, w)
	if next.Version != 2 || next.Tracks[0].ID != v.Tracks[0].ID {
		t.Fatal("lost ordering/identity")
	}
	expect(t, f.put(v, f.a), 409)
	f.db.Close()
	f.open()
	w = f.req("GET", path, "", f.a, nil)
	expect(t, w, 200)
	saved := song(t, w)
	if saved.Notes != v.Notes || saved.Title != v.Title || saved.Tracks[0].Name != "Новый альт" {
		t.Fatal("restart lost metadata")
	}
	saved.Title = "Правка администратора"
	w = f.put(saved, f.admin)
	expect(t, w, 200)
	saved = song(t, w)
	expect(t, f.req("DELETE", path, "", f.a, map[string]string{"If-Match": etag(next)}), 409)
	expect(t, f.req("DELETE", path, "", f.admin, map[string]string{"If-Match": etag(saved)}), 204)
	expect(t, f.req("GET", path, "", f.admin, nil), 404)
	if f.count(`SELECT count(*) FROM tracks WHERE song_id=? AND deleted_at IS NULL`, v.ID) != 0 {
		t.Fatal("live deleted tracks")
	}
}
func TestValidationUnicodeAndRollback(t *testing.T) {
	f := setup(t)
	base := body("valid")
	cases := []string{`null`, `{}`, base + ` {}`, strings.Replace(base, `"title":"valid"`, `"title":null`, 1), strings.Replace(base, `"title":"valid"`, `"title":"\ud800"`, 1), strings.Replace(base, `"title":"valid"`, "\"title\":\"\xff\"", 1)}
	for _, pair := range [][2]string{{`"valid"`, `"   "`}, {`"valid"`, fmt.Sprintf("%q", strings.Repeat("🎵", 161))}, {`"bpm":84`, `"bpm":19`}, {`"bpm":84`, `"bpm":301`}, {`"bpm":84`, `"bpm":84.1`}, {`"bpm":84`, `"bpm":"84"`}, {`"beatsPerBar":4`, `"beatsPerBar":0`}, {`"beatsPerBar":4`, `"beatsPerBar":33`}, {`"beatUnit":4`, `"beatUnit":3`}, {`"notes":""`, `"notes":null`}, {`"notes":""`, `"notes":` + fmt.Sprintf("%q", strings.Repeat("🎵", 1001))}, {`"name":"Сопрано"`, `"name":"　 "`}, {`"name":"Сопрано"`, `"name":` + fmt.Sprintf("%q", strings.Repeat("я", 81))}, {`"position":1`, `"position":0`}, {`"position":1`, `"position":2`}, {`"gain":1`, `"gain":1.1`}, {`"gain":1`, `"gain":-1`}, {`"gain":1`, `"gain":null`}, {`"publication":"draft"`, `"publication":"published"`}, {`"title":"valid"`, `"title":"valid","ownerId":"forged"`}} {
		cases = append(cases, strings.Replace(base, pair[0], pair[1], 1))
	}
	for n, b := range cases {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			expect(t, f.req("POST", "/api/v1/songs", b, f.a, map[string]string{"Idempotency-Key": users.ID()}), 422)
		})
	}
	for _, n := range []int{0, 33} {
		var in map[string]any
		json.Unmarshal([]byte(base), &in)
		tracks := []any{}
		for j := 0; j < n; j++ {
			tracks = append(tracks, map[string]any{"name": "Трек", "position": j, "gain": 1})
		}
		in["tracks"] = tracks
		b, _ := json.Marshal(in)
		expect(t, f.req("POST", "/api/v1/songs", string(b), f.a, map[string]string{"Idempotency-Key": users.ID()}), 422)
	}
	if f.count(`SELECT count(*) FROM songs`) != 0 {
		t.Fatal("invalid create persisted")
	}
	normalized := strings.Replace(body(" e\u0301 "), `"notes":""`, `"notes":`+fmt.Sprintf("%q", strings.Repeat("🎵", 1000)), 1)
	w := f.req("POST", "/api/v1/songs", normalized, f.a, map[string]string{"Idempotency-Key": users.ID()})
	expect(t, w, 201)
	v := song(t, w)
	if v.Title != "é" {
		t.Fatal("NFC missing")
	}
	original := edit(v)
	v.Publication = "published"
	expect(t, f.put(v, f.a), 409)
	w = f.req("GET", "/api/v1/songs/"+v.ID, "", f.a, nil)
	expect(t, w, 200)
	if edit(song(t, w)) != original {
		t.Fatal("publication rollback failed")
	}
	f.exec(`CREATE TRIGGER fail_track BEFORE UPDATE OF name ON tracks WHEN NEW.name='explode' BEGIN SELECT RAISE(ABORT,'injected failure'); END`)
	v = song(t, w)
	v.Title = "must roll back"
	v.Tracks[1].Name = "explode"
	expect(t, f.put(v, f.a), 503)
	w = f.req("GET", "/api/v1/songs/"+v.ID, "", f.a, nil)
	if edit(song(t, w)) != original {
		t.Fatal("partial edit after SQL failure")
	}
	expect(t, f.req("POST", "/api/v1/songs", strings.Repeat("x", 65537), f.a, map[string]string{"Idempotency-Key": users.ID()}), 413)
}
func TestIdempotencyRestartAndConcurrentEdits(t *testing.T) {
	f := setup(t)
	key := users.ID()
	headers := map[string]string{"Idempotency-Key": key}
	w := f.req("POST", "/api/v1/songs", body("Song"), f.a, headers)
	expect(t, w, 201)
	original := w.Body.String()
	v := song(t, w)
	f.db.Close()
	f.open()
	w = f.req("POST", "/api/v1/songs", body(" Song "), f.a, headers)
	expect(t, w, 201)
	if w.Body.String() != original {
		t.Fatal("replay changed response")
	}
	expect(t, f.req("POST", "/api/v1/songs", body("changed"), f.a, headers), 409)
	var encrypted []byte
	if e := f.db.QueryRow(`SELECT response_ciphertext FROM idempotency_records`).Scan(&encrypted); e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(encrypted), v.Title) {
		t.Fatal("plaintext replay")
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for n := 0; n < 2; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- f.put(v, f.a).Code }()
	}
	wg.Wait()
	close(codes)
	result := map[int]int{}
	for c := range codes {
		result[c]++
	}
	if result[200] != 1 || result[409] != 1 {
		t.Fatalf("concurrent writers: %v", result)
	}
	if f.count(`SELECT count(*) FROM songs`) != 1 {
		t.Fatal("idempotency created duplicate")
	}
}

func (f *fixture) asset(track, state string, active bool) string {
	f.t.Helper()
	id := users.ID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	f.exec(`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,state,playback_path,peaks_path,duration_ms,mime,sample_rate,channels,created_at,updated_at) VALUES(?,?,?,12,?,?,'internal/playback','internal/peaks',6000,'audio/mp4',48000,1,?,?)`, id, track, "internal/original", []byte("fictional hash"), state, now, now)
	column := "pending_asset_id"
	if active {
		column = "active_asset_id"
	}
	f.exec(`UPDATE tracks SET `+column+`=? WHERE id=?`, id, track)
	return id
}
func (f *fixture) job(asset, state string) string {
	id := users.ID()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	f.exec(`INSERT INTO jobs(id,asset_id,state,created_at,updated_at) VALUES(?,?,?,?,?)`, id, asset, state, now, now)
	return id
}
func TestMediaRetentionPublicationAndDeletion(t *testing.T) {
	f := setup(t)
	v := f.create("With media", f.a)
	for _, tr := range v.Tracks {
		f.asset(tr.ID, "ready", true)
	}
	pending := f.asset(v.Tracks[0].ID, "processing", false)
	job := f.job(pending, "processing")
	path := "/api/v1/songs/" + v.ID
	w := f.req("GET", path, "", f.a, nil)
	expect(t, w, 200)
	v = song(t, w)
	if !v.Ready || v.Duration == nil || *v.Duration != 6000 || v.Bars == nil || *v.Bars != 3 || v.Tracks[0].PendingJob == nil || *v.Tracks[0].PendingJob != job || v.Tracks[0].Status != "ready" {
		t.Fatal("active media disabled by replacement")
	}
	v.Publication = "published"
	w = f.put(v, f.a)
	expect(t, w, 200)
	v = song(t, w)
	w = f.req("GET", path, "", f.b, nil)
	expect(t, w, 200)
	if strings.Contains(w.Body.String(), "pendingJobId") || strings.Contains(w.Body.String(), "internal/") || strings.Contains(w.Body.String(), "password") {
		t.Fatal("internal data leaked")
	}
	expect(t, f.put(v, f.b), 403)
	// Removing a ready track keeps publication valid and preserves the remaining media.
	removed := v.Tracks[0].ID
	remaining := v.Tracks[1].ID
	v.Tracks = v.Tracks[1:]
	v.Tracks[0].Position = 0
	w = f.put(v, f.a)
	expect(t, w, 200)
	v = song(t, w)
	if !v.Ready || v.Tracks[0].ID != remaining {
		t.Fatal("remaining media detached")
	}
	if f.count(`SELECT count(*) FROM jobs WHERE id=? AND state='canceled' AND lease_until IS NULL`, job) != 1 || f.count(`SELECT count(*) FROM assets WHERE track_id=? AND state='retired'`, removed) != 2 || f.count(`SELECT count(*) FROM tracks WHERE id=? AND deleted_at IS NOT NULL AND active_asset_id IS NULL AND pending_asset_id IS NULL`, removed) != 1 {
		t.Fatal("removal failed to retire media/job")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	share := users.ID()
	listShare := users.ID()
	f.exec(`INSERT INTO shares(id,kind,owner_id,song_id,token_hash,created_at,updated_at) VALUES(?,'song',?,?,?, ?,?)`, share, f.a.id, v.ID, []byte("song token hash"), now, now)
	f.exec(`INSERT INTO shares(id,kind,owner_id,token_hash,created_at,updated_at) VALUES(?,'list',?,?,?,?)`, listShare, f.a.id, []byte("list token hash"), now, now)
	expect(t, f.req("DELETE", path, "", f.a, map[string]string{"If-Match": etag(v)}), 204)
	if f.count(`SELECT count(*) FROM shares WHERE id=? AND disabled_at IS NOT NULL`, share) != 1 || f.count(`SELECT count(*) FROM shares WHERE id=? AND disabled_at IS NULL`, listShare) != 1 {
		t.Fatal("share scope deletion")
	}
	if f.count(`SELECT count(*) FROM assets WHERE track_id IN (SELECT id FROM tracks WHERE song_id=?) AND state!='retired'`, v.ID) != 0 {
		t.Fatal("live media after song deletion")
	}
	rows, e := f.db.Query(`PRAGMA foreign_key_check`)
	if e != nil {
		t.Fatal(e)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("broken foreign key")
	}
}
func page(t *testing.T, w *httptest.ResponseRecorder) ([]Song, *string) {
	t.Helper()
	expect(t, w, 200)
	var v struct {
		Items []Song  `json:"items"`
		Next  *string `json:"nextCursor"`
	}
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e)
	}
	return v.Items, v.Next
}
func TestListSnapshotSearchSortAndPermissions(t *testing.T) {
	f := setup(t)
	a := f.create("Я 🎵", f.a)
	b := f.create("А 🎵", f.a)
	c := f.create("Б 🎵", f.a)
	private := f.create("Чужой черновик", f.b)
	items, _ := page(t, f.req("GET", "/api/v1/songs", "", f.a, nil))
	if len(items) != 3 || items[0].ID != c.ID {
		t.Fatal("default ordering/ownership")
	}
	all, _ := page(t, f.req("GET", "/api/v1/songs", "", f.admin, nil))
	if len(all) != 4 {
		t.Fatal("admin listing")
	}
	for _, v := range items {
		if v.ID == private.ID {
			t.Fatal("private leaked")
		}
	}
	items, _ = page(t, f.req("GET", "/api/v1/songs?q="+url.QueryEscape("А 🎵"), "", f.a, nil))
	if len(items) != 1 || items[0].ID != b.ID {
		t.Fatal("Unicode case-insensitive search")
	}
	b.BPM = 120
	w := f.put(b, f.a)
	expect(t, w, 200)
	b = song(t, w)
	c.BPM = 60
	w = f.put(c, f.a)
	expect(t, w, 200)
	c = song(t, w)
	for order, first := range map[string]string{"title_desc": a.ID, "bpm_asc": c.ID, "bpm_desc": b.ID} {
		sorted, _ := page(t, f.req("GET", "/api/v1/songs?sort="+order, "", f.a, nil))
		if len(sorted) != 3 || sorted[0].ID != first {
			t.Fatalf("sort %s failed", order)
		}
	}
	items, next := page(t, f.req("GET", "/api/v1/songs?sort=title_asc&limit=1", "", f.a, nil))
	if len(items) != 1 || items[0].ID != b.ID || next == nil {
		t.Fatal("sort/pagination")
	}
	token := *next
	expect(t, f.req("GET", "/api/v1/songs?sort=title_asc&cursor="+url.QueryEscape(token), "", f.b, nil), 400)
	expect(t, f.req("GET", "/api/v1/songs?cursor="+url.QueryEscape(token), "", f.a, nil), 400)
	changed := token[:len(token)-2] + "aa"
	expect(t, f.req("GET", "/api/v1/songs?sort=title_asc&cursor="+url.QueryEscape(changed), "", f.a, nil), 400)
	// Later edits cannot reorder the frozen IDs; new songs don't enter the traversal.
	a.Title = "0 moved"
	expect(t, f.put(a, f.a), 200)
	f.create("0 new song", f.a)
	expect(t, f.req("DELETE", "/api/v1/songs/"+c.ID, "", f.a, map[string]string{"If-Match": etag(c)}), 204)
	f.db.Close()
	f.open()
	items, next = page(t, f.req("GET", "/api/v1/songs?sort=title_asc&limit=1&cursor="+url.QueryEscape(token), "", f.a, nil))
	if len(items) != 1 || items[0].ID != a.ID || next != nil {
		t.Fatal("snapshot restart/order/deletion")
	}
	f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
	expect(t, f.req("GET", "/api/v1/songs?sort=title_asc&cursor="+url.QueryEscape(token), "", f.a, nil), 410)
	for _, q := range []string{"limit=0", "limit=101", "limit=bad", "sort=bad", "cursor=broken", "q=%FF", "q=%C0%AF", "q=%ED%A0%80"} {
		w := f.req("GET", "/api/v1/songs?"+q, "", f.a, nil)
		if w.Code != 400 && w.Code != 422 {
			t.Fatal("invalid list query accepted")
		}
	}
}
func TestSnapshotRechecksPublicationAndSession(t *testing.T) {
	f := setup(t)
	own := f.create("A own", f.a)
	v := f.create("B published", f.b)
	for _, tr := range v.Tracks {
		f.asset(tr.ID, "ready", true)
	}
	v.Publication = "published"
	w := f.put(v, f.b)
	expect(t, w, 200)
	v = song(t, w)
	items, next := page(t, f.req("GET", "/api/v1/songs?sort=title_asc&limit=1", "", f.a, nil))
	if len(items) != 1 || items[0].ID != own.ID || next == nil {
		t.Fatal("missing published member")
	}
	token := *next
	v.Publication = "draft"
	expect(t, f.put(v, f.b), 200)
	items, _ = page(t, f.req("GET", "/api/v1/songs?sort=title_asc&cursor="+url.QueryEscape(token), "", f.a, nil))
	if len(items) != 0 {
		t.Fatal("unpublished member leaked")
	}
	if e := users.SetBlocked(context.Background(), f.db, f.a.id, true); e != nil {
		t.Fatal(e)
	}
	expect(t, f.req("GET", "/api/v1/songs?sort=title_asc&cursor="+url.QueryEscape(token), "", f.a, nil), 401)
}

func TestDraftTrackAdditionAndBoundaryValues(t *testing.T) {
	f := setup(t)
	v := f.create(strings.Repeat("🎵", 160), f.a)
	originalID := v.Tracks[0].ID
	payload := edit(v)
	var in map[string]any
	json.Unmarshal([]byte(payload), &in)
	tracks := in["tracks"].([]any)
	tracks[1] = map[string]any{"name": strings.Repeat("я", 80), "position": 1, "gain": 0}
	in["tracks"] = tracks
	in["bpm"] = 300
	in["beatsPerBar"] = 32
	in["beatUnit"] = 32
	b, _ := json.Marshal(in)
	w := f.req("PUT", "/api/v1/songs/"+v.ID, string(b), f.a, map[string]string{"If-Match": etag(v)})
	expect(t, w, 200)
	v = song(t, w)
	if v.Tracks[0].ID != originalID || v.Tracks[1].Status != "empty" {
		t.Fatal("draft track addition")
	}
	for _, bad := range []string{strings.Replace(string(b), `"position":1`, `"position":1,"id":null`, 1), strings.Replace(string(b), `"title":`, `"TITLE":`, 1), strings.Replace(string(b), `"gain":0`, `"gain":0,"secret":1`, 1)} {
		expect(t, f.req("PUT", "/api/v1/songs/"+v.ID, bad, f.a, map[string]string{"If-Match": etag(v)}), 422)
	}
	tracks = []any{}
	for n := 0; n < 32; n++ {
		tracks = append(tracks, map[string]any{"name": "Дорожка 🎵", "position": n, "gain": 1})
	}
	in["tracks"] = tracks
	in["bpm"] = 20
	in["beatsPerBar"] = 1
	for _, unit := range []int{1, 2, 4, 8, 16, 32} {
		in["beatUnit"] = unit
		b, _ = json.Marshal(in)
		w = f.req("POST", "/api/v1/songs", string(b), f.a, map[string]string{"Idempotency-Key": users.ID()})
		expect(t, w, 201)
		if len(song(t, w).Tracks) != 32 {
			t.Fatal("32 tracks not saved")
		}
	}
}
func TestCreateRollbackAndReplayExpiry(t *testing.T) {
	f := setup(t)
	f.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON tracks WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'injected'); END`)
	key := users.ID()
	h := map[string]string{"Idempotency-Key": key}
	expect(t, f.req("POST", "/api/v1/songs", body("rollback"), f.a, h), 503)
	if f.count(`SELECT count(*) FROM songs`)+f.count(`SELECT count(*) FROM tracks`)+f.count(`SELECT count(*) FROM idempotency_records`) != 0 {
		t.Fatal("partial create persisted")
	}
	f.exec(`DROP TRIGGER reject_second`)
	expect(t, f.req("POST", "/api/v1/songs", body("rollback"), f.a, h), 201)
	f.s.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	expect(t, f.req("POST", "/api/v1/songs", body("new after expiry"), f.a, h), 201)
	if f.count(`SELECT count(*) FROM songs`) != 2 {
		t.Fatal("expired key did not permit new creation")
	}
	// Corrupt encrypted responses must fail closed without creating a duplicate.
	f.exec(`UPDATE idempotency_records SET nonce=x'00'`)
	expect(t, f.req("POST", "/api/v1/songs", body("new after expiry"), f.a, h), 503)
	if f.count(`SELECT count(*) FROM songs`) != 2 {
		t.Fatal("corrupt replay duplicated song")
	}
}

// Names belong to assets, not track titles; failed replacements cannot relabel
// working audio. NULL legacy metadata is never reconstructed from storage paths.
func TestSourceNamesPersistenceAndAccess(t *testing.T) {
	f := setup(t)
	v := f.create("Named audio", f.a)
	path := "/api/v1/songs/" + v.ID
	for _, tr := range v.Tracks {
		f.asset(tr.ID, "ready", true)
	}
	f.exec(`UPDATE assets SET source_name='Исходник сопрано.wav',source_path='' WHERE track_id=?`, v.Tracks[0].ID)
	read := func(a actor) Song {
		t.Helper()
		w := f.req("GET", path, "", a, nil)
		expect(t, w, 200)
		return song(t, w)
	}
	assertName := func(v Song) {
		t.Helper()
		if v.Tracks[0].SourceName == nil || *v.Tracks[0].SourceName != "Исходник сопрано.wav" || v.Tracks[1].SourceName != nil {
			t.Fatal("lost name or fabricated legacy name", v.Tracks)
		}
	}
	assertName(read(f.a))
	assertName(read(f.admin))
	replacement := f.asset(v.Tracks[0].ID, "processing", false)
	f.exec(`UPDATE assets SET source_name='Неудачная замена.wav' WHERE id=?`, replacement)
	assertName(read(f.a))
	f.exec(`UPDATE assets SET state='failed' WHERE id=?`, replacement)
	assertName(read(f.a))
	f.db.Close()
	f.open()
	assertName(read(f.a))
	f.exec(`UPDATE songs SET publication='published' WHERE id=?`, v.ID)
	outsider := read(f.b)
	if outsider.Tracks[0].SourceName != nil {
		t.Fatal("read-only teacher received source metadata")
	}
	expect(t, f.req("GET", path, "", actor{}, nil), 401)
	f.exec(`UPDATE assets SET state='ready' WHERE id=?`, replacement)
	f.exec(`UPDATE tracks SET active_asset_id=?,pending_asset_id=NULL WHERE id=?`, replacement, v.Tracks[0].ID)
	updated := read(f.a)
	if updated.Tracks[0].SourceName == nil || *updated.Tracks[0].SourceName != "Неудачная замена.wav" {
		t.Fatal("successful replacement did not update name")
	}
}
