package uploads

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/sharing"
	"github.com/Axepuff/choral-training-tool/backend/internal/storage"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const origin = "https://uploads.example.test"

type fixture struct {
	t                      *testing.T
	db                     *sql.DB
	s                      *Service
	store                  *storage.Store
	dir, song, track, csrf string
	cookie                 *http.Cookie
	h                      *http.ServeMux
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, dir: t.TempDir(), song: users.ID(), track: users.ID()}
	var e error
	f.db, e = platform.OpenDatabase(context.Background(), f.dir)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { f.db.Close() })
	a, e := auth.New(f.db, origin, false)
	if e != nil {
		t.Fatal(e)
	}
	u, e := users.Create(context.Background(), f.db, "admin@example.test", "fictional password 123", "admin", true)
	if e != nil {
		t.Fatal(e)
	}
	f.exec(`UPDATE users SET must_change_password=0`)
	f.exec(`INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,created_at,updated_at) VALUES(?,?,'Song',120,4,4,'now','now')`, f.song, u.ID)
	f.exec(`INSERT INTO tracks(id,song_id,position,name) VALUES(?,?,0,'Track')`, f.track, f.song)
	f.store, e = storage.New(f.dir)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { f.store.Close() })
	f.s, e = New(f.db, a, f.store, f.dir)
	if e != nil {
		t.Fatal(e)
	}
	f.h = http.NewServeMux()
	a.Register(f.h)
	f.s.Register(f.h)
	share, e := sharing.New(f.db, a, a, f.store, f.dir)
	if e != nil {
		t.Fatal(e)
	}
	share.Register(f.h)
	r := httptest.NewRequest("POST", origin+"/api/v1/auth/login", strings.NewReader(`{"email":"admin@example.test","password":"fictional password 123"}`))
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	check(t, w, 200)
	f.cookie = w.Result().Cookies()[0]
	var v struct {
		CSRF string `json:"csrfToken"`
	}
	json.Unmarshal(w.Body.Bytes(), &v)
	f.csrf = v.CSRF
	return f
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, e := f.db.Exec(q, args...); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) count(table string) int {
	var n int
	if e := f.db.QueryRow("SELECT count(*) FROM " + table).Scan(&n); e != nil {
		f.t.Fatal(e)
	}
	return n
}
func check(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
	}
}
func audio(t *testing.T, format string) []byte {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fixture."+format)
	if b, e := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-y", p).CombinedOutput(); e != nil {
		t.Fatalf("fixture: %v %s", e, b)
	}
	b, e := os.ReadFile(p)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func (f *fixture) request(data []byte, key, version string) *http.Request {
	var b bytes.Buffer
	m := multipart.NewWriter(&b)
	p, e := m.CreateFormFile("file", "../../outside.fake")
	if e != nil {
		f.t.Fatal(e)
	}
	p.Write(data)
	m.Close()
	r := httptest.NewRequest("POST", origin+"/api/v1/songs/"+f.song+"/tracks/"+f.track+"/uploads", &b)
	r.Header.Set("Content-Type", m.FormDataContentType())
	r.Header.Set("Origin", origin)
	r.Header.Set("X-CSRF-Token", f.csrf)
	r.Header.Set("Idempotency-Key", key)
	r.Header.Set("If-Match", version)
	r.AddCookie(f.cookie)
	return r
}
func (f *fixture) send(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}
func (f *fixture) files() []os.DirEntry {
	v, e := os.ReadDir(filepath.Join(f.dir, "files"))
	if e != nil {
		f.t.Fatal(e)
	}
	return v
}
func TestRealFormatsAndReplay(t *testing.T) {
	for _, format := range []string{"wav", "flac", "mp3", "ogg", "m4a", "aiff"} {
		t.Run(format, func(t *testing.T) {
			f := setup(t)
			b := audio(t, format)
			key := users.ID()
			w := f.send(f.request(b, key, `"1"`))
			check(t, w, 202)
			var codec, container, state string
			var duration int
			var active sql.NullString
			if e := f.db.QueryRow(`SELECT a.source_codec,a.source_container,a.duration_ms,j.state,t.active_asset_id FROM assets a JOIN jobs j ON j.asset_id=a.id JOIN tracks t ON t.id=a.track_id`).Scan(&codec, &container, &duration, &state, &active); e != nil {
				t.Fatal(e)
			}
			if codec == "" || container == "" || duration < 1 || duration > 1000 || state != "queued" || active.Valid {
				t.Fatal("metadata or premature activation")
			}
			again := f.send(f.request(b, key, `"1"`))
			check(t, again, 202)
			if again.Body.String() != w.Body.String() || again.Header().Get("ETag") != w.Header().Get("ETag") {
				t.Fatal("replay changed")
			}
			check(t, f.send(f.request([]byte("different"), key, `"1"`)), 409)
			check(t, f.send(f.request(b, users.ID(), `"2"`)), 409)
			if f.count("assets") != 1 || f.count("jobs") != 1 || len(f.files()) != 1 {
				t.Fatal("duplicate/orphan")
			}
			r := httptest.NewRequest("GET", origin+w.Header().Get("Location"), nil)
			r.AddCookie(f.cookie)
			check(t, f.send(r), 200)
		})
	}
}
func TestFailureAndRecovery(t *testing.T) {
	f := setup(t)
	key := users.ID()
	w := f.send(f.request([]byte("broken"), key, `"1"`))
	check(t, w, 422)
	if !strings.Contains(w.Body.String(), "corrupt_audio") {
		t.Fatal(w.Body.String())
	}
	check(t, f.send(f.request([]byte("broken"), key, `"1"`)), 422)
	if f.count("assets") != 1 || len(f.files()) != 1 {
		t.Fatal("failed original lost/duplicated")
	}
	check(t, f.send(f.request(audio(t, "wav"), users.ID(), `"2"`)), 202)
	stage := "stage-" + users.ID()
	orphan := "original-" + users.ID()
	if e := f.store.Stage(context.Background(), stage, strings.NewReader("orphan"), 100); e != nil {
		t.Fatal(e)
	}
	if e := f.store.Publish(context.Background(), stage, orphan); e != nil {
		t.Fatal(e)
	}
	if _, e := New(f.db, f.s.identity, f.store, f.dir); e != nil {
		t.Fatal(e)
	}
	if len(f.files()) != 2 {
		t.Fatal("recovery removed retained original or left orphan")
	}
}
func TestLimitsAndCleanup(t *testing.T) {
	f := setup(t)
	f.s.maxFile = 100
	check(t, f.send(f.request(make([]byte, 101), users.ID(), `"1"`)), 413)
	f.s.quota = 99
	check(t, f.send(f.request([]byte("x"), users.ID(), `"1"`)), 413)
	f.s.quota = OwnerQuota
	f.s.busy[f.song] = "busy"
	check(t, f.send(f.request([]byte("x"), users.ID(), `"1"`)), 429)
	delete(f.s.busy, f.song)
	f.s.maxFile = MaxFile
	b := audio(t, "wav")
	check(t, f.send(f.request(b, users.ID(), "")), 428)
	check(t, f.send(f.request(b, users.ID(), `"9"`)), 409)
	r := f.request(b, users.ID(), `"1"`)
	r.Header.Set("X-CSRF-Token", "wrong")
	check(t, f.send(r), 403)
	if f.count("assets") != 0 || len(f.files()) != 0 {
		t.Fatal("rejected request leaked")
	}
}
func TestForeignAndRevoked(t *testing.T) {
	f := setup(t)
	f.exec(`UPDATE users SET role='teacher'`)
	other := users.ID()
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	f.exec(`INSERT INTO users(id,email_normalized,password_hash,role,created_at,updated_at) VALUES(?,'other@example.test','unused','teacher',?,?)`, other, stamp, stamp)
	f.exec(`UPDATE songs SET owner_id=?`, other)
	check(t, f.send(f.request(audio(t, "wav"), users.ID(), `"1"`)), 404)
	f.exec(`UPDATE sessions SET revoked_at=?`, stamp)
	check(t, f.send(f.request([]byte("x"), users.ID(), `"1"`)), 401)
	if len(f.files()) != 0 {
		t.Fatal("foreign upload stored")
	}
}

type cancelReader struct {
	r      io.Reader
	cancel context.CancelFunc
}

func (c *cancelReader) Read(p []byte) (int, error) { n, e := c.r.Read(p); c.cancel(); return n, e }
func TestMidStreamCancellation(t *testing.T) {
	f := setup(t)
	r := f.request(audio(t, "wav"), users.ID(), `"1"`)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	r.Body = io.NopCloser(&cancelReader{r.Body, cancel})
	w := f.send(r.WithContext(ctx))
	if w.Code == 202 {
		t.Fatal("canceled upload succeeded")
	}
	if f.count("assets") != 0 || len(f.files()) != 0 || len(f.s.busy) != 0 {
		t.Fatal("cancellation leaked")
	}
}
func TestNonAudioAndTooLong(t *testing.T) {
	for _, kind := range []string{"non-audio", "too-long"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			path := filepath.Join(t.TempDir(), "fixture.wav")
			args := []string{"-v", "error", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1201", "-y", path}
			if kind == "non-audio" {
				path = filepath.Join(t.TempDir(), "fixture.mp4")
				args = []string{"-v", "error", "-f", "lavfi", "-i", "color=size=16x16:duration=0.1", "-an", "-y", path}
			}
			if b, e := exec.Command("ffmpeg", args...).CombinedOutput(); e != nil {
				t.Fatalf("fixture: %v %s", e, b)
			}
			b, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			w := f.send(f.request(b, users.ID(), `"1"`))
			check(t, w, 422)
			code := "unsupported_codec"
			if kind == "too-long" {
				code = "too_long"
			}
			if !strings.Contains(w.Body.String(), code) {
				t.Fatal(w.Body.String())
			}
		})
	}
}
func TestOldAssetSurvives(t *testing.T) {
	f := setup(t)
	id := users.ID()
	f.exec(`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,playback_path,peaks_path,duration_ms,mime,sample_rate,channels,state,created_at,updated_at) VALUES(?,?,'old',1,x'01','playback-old','peaks-old',100,'audio/mp4',48000,1,'ready','now','now')`, id, f.track)
	f.exec(`UPDATE tracks SET active_asset_id=?`, id)
	check(t, f.send(f.request(audio(t, "wav"), users.ID(), `"1"`)), 202)
	var active, pending string
	if e := f.db.QueryRow(`SELECT active_asset_id,pending_asset_id FROM tracks`).Scan(&active, &pending); e != nil {
		t.Fatal(e)
	}
	if active != id || pending == id {
		t.Fatal("old working asset changed")
	}
}

func TestQuotaReplayAndPublicMedia(t *testing.T) {
	f := setup(t)
	b := audio(t, "wav")
	key := users.ID()
	first := f.send(f.request(b, key, `"1"`))
	check(t, first, 202)
	f.s.quota = int64(len(b))
	check(t, f.send(f.request(b, key, `"1"`)), 202)
	check(t, f.send(f.request(b, users.ID(), `"2"`)), 413)
	// Build worker output fixtures in the actual private storage, then publish them
	// in SQLite. The worker itself belongs to #8.
	var asset, original string
	if e := f.db.QueryRow(`SELECT id,source_path FROM assets`).Scan(&asset, &original); e != nil {
		t.Fatal(e)
	}
	playback, peaks := "playback-"+users.ID(), "peaks-"+users.ID()
	media := audio(t, "m4a")
	for key, data := range map[string][]byte{playback: media, peaks: []byte(`{"points":[]}`)} {
		stage := "stage-" + users.ID()
		if e := f.store.Stage(context.Background(), stage, bytes.NewReader(data), MaxFile); e != nil {
			t.Fatal(e)
		}
		if e := f.store.Publish(context.Background(), stage, key); e != nil {
			t.Fatal(e)
		}
	}
	f.exec(`UPDATE assets SET state='ready',playback_path=?,peaks_path=?,mime='audio/mp4',sample_rate=48000,channels=1 WHERE id=?`, playback, peaks, asset)
	f.exec(`UPDATE tracks SET active_asset_id=?,pending_asset_id=NULL`, asset)
	f.exec(`UPDATE songs SET publication='published'`)
	raw := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	hash := sha256.Sum256([]byte(raw))
	f.exec(`INSERT INTO shares(id,kind,owner_id,song_id,token_hash,created_at,updated_at) SELECT ?,'song',owner_id,id,?,'now','now' FROM songs`, users.ID(), hash[:])
	path := origin + "/api/v1/public/shares/" + raw + "/songs/" + f.song + "/tracks/" + f.track + "/media"
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("Range", "bytes=0-7")
	w := f.send(r)
	check(t, w, 206)
	if !bytes.Equal(w.Body.Bytes(), media[:8]) {
		t.Fatal("wrong media range")
	}
	check(t, f.send(httptest.NewRequest("HEAD", path, nil)), 200)
	f.exec(`UPDATE assets SET playback_path=?`, original)
	w = f.send(httptest.NewRequest("GET", path, nil))
	check(t, w, 503)
	if bytes.Contains(w.Body.Bytes(), b) {
		t.Fatal("original exposed")
	}
}

type hookReader struct {
	r    io.Reader
	once bool
	hook func()
}

func (h *hookReader) Read(p []byte) (int, error) {
	n, e := h.r.Read(p)
	if !h.once {
		h.once = true
		h.hook()
	}
	return n, e
}
func TestLiveChangesDuringUpload(t *testing.T) {
	for _, kind := range []string{"revoke", "version", "delete"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			r := f.request(audio(t, "wav"), users.ID(), `"1"`)
			r.Body = io.NopCloser(&hookReader{r: r.Body, hook: func() {
				switch kind {
				case "revoke":
					f.exec(`UPDATE sessions SET revoked_at='now'`)
				case "version":
					f.exec(`UPDATE songs SET version=version+1`)
				case "delete":
					f.exec(`UPDATE songs SET deleted_at='now'`)
				}
			}})
			w := f.send(r)
			status := 401
			if kind == "version" {
				status = 409
			}
			if kind == "delete" {
				status = 404
			}
			check(t, w, status)
			if len(f.files()) != 0 || f.count("assets") != 0 {
				t.Fatal("live change leaked files")
			}
		})
	}
}
func TestStreamingAdmission(t *testing.T) {
	f := setup(t)
	b := audio(t, "wav")
	r := f.request(b, users.ID(), `"1"`)
	r.Body = io.NopCloser(&hookReader{r: r.Body, hook: func() { check(t, f.send(f.request(b, users.ID(), `"1"`)), 429) }})
	check(t, f.send(r), 202)
	if len(f.s.busy) != 0 || len(f.files()) != 1 {
		t.Fatal("reservation leak")
	}
}
func TestProbeTimeoutAndOutputLimit(t *testing.T) {
	f := setup(t)
	stage := "stage-" + users.ID()
	if e := f.store.Stage(context.Background(), stage, bytes.NewReader(audio(t, "wav")), MaxFile); e != nil {
		t.Fatal(e)
	}
	file, e := f.store.Open(context.Background(), stage)
	if e != nil {
		t.Fatal(e)
	}
	defer file.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, code := probe(ctx, file.(*os.File))
	if code != "probe_timeout" {
		t.Fatal(code)
	}
	var out limitedBuffer
	if _, e := out.Write(make([]byte, 65537)); e == nil {
		t.Fatal("unbounded probe output")
	}
}

func TestNetworkReadTimeout(t *testing.T) {
	f := setup(t)
	f.s.timeout = 80 * time.Millisecond
	server := httptest.NewServer(f.h)
	defer server.Close()
	conn, e := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	r := f.request([]byte("x"), users.ID(), `"1"`)
	prefix := "--slow\r\nContent-Disposition: form-data; name=\"file\"; filename=\"slow.wav\"\r\nContent-Type: application/octet-stream\r\n\r\nx"
	head := "POST " + r.URL.Path + " HTTP/1.1\r\nHost: uploads.example.test\r\nOrigin: " + origin + "\r\nCookie: " + f.cookie.String() + "\r\nX-CSRF-Token: " + f.csrf + "\r\nIdempotency-Key: " + r.Header.Get("Idempotency-Key") + "\r\nIf-Match: \"1\"\r\nContent-Type: multipart/form-data; boundary=slow\r\nContent-Length: 10000\r\n\r\n"
	if _, e = io.WriteString(conn, head+prefix); e != nil {
		t.Fatal(e)
	}
	response, e := http.ReadResponse(bufio.NewReader(conn), r)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	io.Copy(io.Discard, response.Body)
	if response.StatusCode != 408 {
		t.Fatalf("timeout status %d", response.StatusCode)
	}
	if len(f.files()) != 0 || f.count("assets") != 0 {
		t.Fatal("timeout leaked files")
	}
}

func TestCommitRollbackAndMissingProbe(t *testing.T) {
	f := setup(t)
	b := audio(t, "wav")
	f.exec(`CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'test failure'); END`)
	check(t, f.send(f.request(b, users.ID(), `"1"`)), 503)
	if f.count("assets") != 0 || f.count("jobs") != 0 || len(f.files()) != 0 {
		t.Fatal("transaction failure left asset/job/file")
	}
	var version int
	f.db.QueryRow(`SELECT version FROM songs`).Scan(&version)
	if version != 1 {
		t.Fatal("version changed on rollback")
	}
	f.exec(`DROP TRIGGER reject_job`)
	t.Setenv("PATH", t.TempDir())
	check(t, f.send(f.request(b, users.ID(), `"1"`)), 503)
	if len(f.files()) != 0 || f.count("jobs") != 0 {
		t.Fatal("missing probe produced success")
	}
}
func TestReplayAfterRestart(t *testing.T) {
	f := setup(t)
	b := audio(t, "wav")
	key := users.ID()
	first := f.send(f.request(b, key, `"1"`))
	check(t, first, 202)
	f.db.Close()
	f.store.Close()
	var e error
	f.db, e = platform.OpenDatabase(context.Background(), f.dir)
	if e != nil {
		t.Fatal(e)
	}
	f.store, e = storage.New(f.dir)
	if e != nil {
		t.Fatal(e)
	}
	a, e := auth.New(f.db, origin, false)
	if e != nil {
		t.Fatal(e)
	}
	f.s, e = New(f.db, a, f.store, f.dir)
	if e != nil {
		t.Fatal(e)
	}
	f.h = http.NewServeMux()
	f.s.Register(f.h)
	again := f.send(f.request(b, key, `"1"`))
	check(t, again, 202)
	if again.Body.String() != first.Body.String() || again.Header().Get("Location") != first.Header().Get("Location") || len(f.files()) != 1 {
		t.Fatal("restart replay changed")
	}
}
func TestUnsupportedWavCodec(t *testing.T) {
	f := setup(t)
	b := audio(t, "wav")
	offset := bytes.Index(b, []byte("fmt "))
	if offset < 0 {
		t.Fatal("no wave fmt")
	}
	b[offset+8] = 255
	b[offset+9] = 255
	w := f.send(f.request(b, users.ID(), `"1"`))
	check(t, w, 422)
	if !strings.Contains(w.Body.String(), "unsupported_codec") {
		t.Fatal(w.Body.String())
	}
}

type gatedReader struct {
	r       io.Reader
	started chan struct{}
	release chan struct{}
	once    bool
}

func (g *gatedReader) Read(p []byte) (int, error) {
	if !g.once {
		g.once = true
		close(g.started)
		<-g.release
	}
	return g.r.Read(p)
}
func TestServerConcurrency(t *testing.T) {
	f := setup(t)
	b := audio(t, "wav")
	done := make(chan *httptest.ResponseRecorder, 2)
	release := make(chan struct{})
	defer func() {
		if release != nil {
			close(release)
		}
	}()
	for n := 0; n < 2; n++ {
		song, track := users.ID(), users.ID()
		f.exec(`INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,created_at,updated_at) SELECT ?,owner_id,'Parallel',120,4,4,'now','now' FROM songs WHERE id=?`, song, f.song)
		f.exec(`INSERT INTO tracks(id,song_id,position,name) VALUES(?,?,0,'Track')`, track, song)
		r := f.request(b, users.ID(), `"1"`)
		r.URL.Path = "/api/v1/songs/" + song + "/tracks/" + track + "/uploads"
		started := make(chan struct{})
		r.Body = io.NopCloser(&gatedReader{r: r.Body, started: started, release: release})
		go func() { done <- f.send(r) }()
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("upload did not start")
		}
	}
	check(t, f.send(f.request(b, users.ID(), `"1"`)), 429)
	close(release)
	release = nil
	for n := 0; n < 2; n++ {
		select {
		case w := <-done:
			check(t, w, 202)
		case <-time.After(5 * time.Second):
			t.Fatal("upload did not finish")
		}
	}
	if len(f.s.busy) != 0 || f.count("jobs") != 2 || len(f.files()) != 2 {
		t.Fatal("concurrency reservation leak")
	}
}
