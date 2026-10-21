package auth

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

const sample = "fictional password 123"
const replacement = "replacement password 456"

type fixture struct {
	t              *testing.T
	db             *sql.DB
	s              *Service
	handler        http.Handler
	logs           bytes.Buffer
	admin, teacher users.User
	dir            string
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t}
	var err error
	f.dir = t.TempDir()
	f.db, err = platform.OpenDatabase(context.Background(), f.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.db.Close() })
	f.admin, err = users.Create(context.Background(), f.db, "Admin@Example.test", sample, "admin", true)
	if err != nil {
		t.Fatal(err)
	}
	f.teacher, err = users.Create(context.Background(), f.db, " Teacher@Example.test ", sample, "teacher", false)
	if err != nil {
		t.Fatal(err)
	}
	f.s, err = New(f.db, "https://choir.example.test", false)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = platform.NewService(platform.Config{}, f.db, slog.New(slog.NewJSONHandler(&f.logs, nil)), f.s.Register).Server.Handler
	return f
}
func (f *fixture) request(method, path, body string, c *http.Cookie, csrfToken, origin string) *httptest.ResponseRecorder {
	f.t.Helper()
	r := httptest.NewRequest(method, "https://choir.example.test"+path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.4:1234"
	r.Header.Set("Content-Type", "application/json")
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if c != nil {
		r.AddCookie(c)
	}
	if csrfToken != "" {
		r.Header.Set("X-CSRF-Token", csrfToken)
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}
func (f *fixture) login(email, password string, old *http.Cookie) (*http.Cookie, state) {
	f.t.Helper()
	b, _ := json.Marshal(map[string]string{"email": email, "password": password})
	w := f.request("POST", "/api/v1/auth/login", string(b), old, "", f.s.Origin)
	expect(f.t, w, 200)
	var a state
	if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil {
		f.t.Fatal(err)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		f.t.Fatal("missing cookie")
	}
	return cookies[0], a
}
func expect(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
	}
}
func (f *fixture) change(c *http.Cookie, a state) {
	f.t.Helper()
	b, _ := json.Marshal(map[string]string{"currentPassword": sample, "newPassword": replacement})
	expect(f.t, f.request("PUT", "/api/v1/auth/password", string(b), c, a.CSRF, f.s.Origin), 204)
}
func (f *fixture) unrestricted(email string) (*http.Cookie, state) {
	f.t.Helper()
	c, a := f.login(email, sample, nil)
	f.change(c, a)
	return f.login(email, replacement, nil)
}
func (f *fixture) identity(c *http.Cookie) *platform.Identity {
	f.t.Helper()
	r := httptest.NewRequest("GET", "/api/v1/songs", nil)
	r.AddCookie(c)
	i, e := f.s.Authenticate(context.Background(), r)
	if e != nil {
		f.t.Fatal(e)
	}
	return i
}

func TestSessionLifecycle(t *testing.T) {
	f := setup(t)
	c, a := f.login(" TEACHER@EXAMPLE.TEST ", sample, nil)
	if a.User.ID != f.teacher.ID || a.User.Role != "teacher" || a.User.Email != "teacher@example.test" || !a.User.MustChangePassword {
		t.Fatal("wrong server profile")
	}
	if c.Name != CookieName || !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteLaxMode || c.Path != "/" || c.Domain != "" || len(c.Value) != 43 {
		t.Fatal("unsafe cookie")
	}
	if d := a.Expires.Sub(time.Now()); d < 7*24*time.Hour-time.Minute || d > 7*24*time.Hour {
		t.Fatal("wrong TTL")
	}
	expect(t, f.request("GET", "/api/v1/auth/me", "", c, "", ""), 200)
	r := httptest.NewRequest("GET", "/api/v1/songs?role=admin", nil)
	r.AddCookie(c)
	if _, e := f.s.Authenticate(context.Background(), r); e == nil {
		t.Fatal("temporary password gate bypassed")
	}
	for _, origin := range []string{"", "https://attacker.test"} {
		expect(t, f.request("POST", "/api/v1/auth/logout", "", c, a.CSRF, origin), 403)
	}
	expect(t, f.request("POST", "/api/v1/auth/logout", "", c, "wrong", f.s.Origin), 403)
	fresh, b := f.login("teacher@example.test", sample, c)
	if fresh.Value == c.Value || b.CSRF == a.CSRF {
		t.Fatal("session not rotated")
	}
	expect(t, f.request("GET", "/api/v1/auth/me", "", c, "", ""), 401)
	expect(t, f.request("POST", "/api/v1/auth/logout", "", fresh, a.CSRF, f.s.Origin), 403)
	out := f.request("POST", "/api/v1/auth/logout", "", fresh, b.CSRF, f.s.Origin)
	expect(t, out, 204)
	if out.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("cookie not cleared")
	}
	expect(t, f.request("GET", "/api/v1/auth/me", "", fresh, "", ""), 401)
	c, a = f.login("teacher@example.test", sample, nil)
	f.s.now = func() time.Time { return a.Expires }
	expect(t, f.request("GET", "/api/v1/auth/me", "", c, "", ""), 401)
	// No raw session/CSRF or password in persistent storage or HTTP logs.
	var tokenHash, csrfHash []byte
	if err := f.db.QueryRow(`SELECT token_hash,csrf_hash FROM sessions WHERE token_hash=?`, digest(c.Value)).Scan(&tokenHash, &csrfHash); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(tokenHash, []byte(c.Value)) || bytes.Equal(csrfHash, []byte(a.CSRF)) {
		t.Fatal("plaintext session secret")
	}
	for _, secret := range []string{sample, c.Value, a.CSRF, "teacher@example.test"} {
		if strings.Contains(f.logs.String(), secret) {
			t.Fatal("sensitive data logged")
		}
	}
}
func TestInvalidCredentialsAndPersistentLimiter(t *testing.T) {
	f := setup(t)
	for _, email := range []string{"absent@example.test", "teacher@example.test", "not an email"} {
		b, _ := json.Marshal(map[string]string{"email": email, "password": "incorrect password"})
		w := f.request("POST", "/api/v1/auth/login", string(b), nil, "", f.s.Origin)
		expect(t, w, 401)
		var v struct {
			Error struct{ Code, Message string }
		}
		if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
			t.Fatal(err)
		}
		if v.Error.Code != "invalid_credentials" || v.Error.Message != "Неверный email или пароль" {
			t.Fatal("credential enumeration")
		}
	}
	// teacher already has one failed attempt; the fifth failure is 401, next is 429.
	body := `{"email":"TEACHER@example.test","password":"wrong"}`
	for i := 0; i < 4; i++ {
		expect(t, f.request("POST", "/api/v1/auth/login", body, nil, "", f.s.Origin), 401)
	}
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.db, err = platform.OpenDatabase(context.Background(), f.dir)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := New(f.db, f.s.Origin, false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	restarted.Register(mux)
	f.handler = mux
	f.s = restarted
	w := f.request("POST", "/api/v1/auth/login", body, nil, "", f.s.Origin)
	expect(t, w, 429)
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("missing retry delay")
	}
	f.s.now = func() time.Time { return time.Now().Add(16 * time.Minute) }
	f.login("teacher@example.test", sample, nil)
}
func TestPasswordResetBlockingAndAuthorization(t *testing.T) {
	f := setup(t)
	admin, _ := f.unrestricted("admin@example.test")
	teacher, ta := f.unrestricted("teacher@example.test")
	ai := f.identity(admin)
	ti := f.identity(teacher)
	ctx := context.Background()
	own := platform.Resource{SongID: "song", OwnerID: ti.UserID}
	other := platform.Resource{SongID: "other", OwnerID: ai.UserID}
	if !f.s.CanEditSong(ctx, *ti, own) || f.s.CanEditSong(ctx, *ti, other) || !f.s.CanEditSong(ctx, *ai, own) || f.s.CanManageUsers(ctx, *ti) || !f.s.CanManageUsers(ctx, *ai) {
		t.Fatal("role/ownership authorization")
	}
	forged := *ti
	forged.Role = "admin"
	if f.s.CanManageUsers(ctx, forged) || f.s.CanEditSong(ctx, forged, other) {
		t.Fatal("client role accepted")
	}
	if f.s.CanReadSong(ctx, ti, nil, other) {
		t.Fatal("private song leaked")
	}
	other.Publication = "published"
	other.Ready = true
	if !f.s.CanReadSong(ctx, ti, nil, other) {
		t.Fatal("published song denied")
	}
	if !f.s.CanManageShare(ctx, *ti, &own, ti.UserID) || f.s.CanManageShare(ctx, *ti, &other, ti.UserID) {
		t.Fatal("share owner mismatch")
	}
	g := &platform.ShareGrant{Kind: "song", OwnerID: own.OwnerID, SongID: own.SongID, ShareID: "validated-share"}
	if f.s.CanReadSong(ctx, nil, g, own) {
		t.Fatal("draft shared")
	}
	own.Publication = "published"
	own.Ready = true
	if !f.s.CanReadSong(ctx, nil, g, own) {
		t.Fatal("valid share denied")
	}
	g.SongID = "wrong"
	if f.s.CanReadSong(ctx, nil, g, own) {
		t.Fatal("share scope bypass")
	}
	g.Kind = "list"
	g.SongID = ""
	if !f.s.CanReadSong(ctx, nil, g, own) {
		t.Fatal("list scope denied")
	}
	resetPath := "/api/v1/admin/users/" + f.teacher.ID + "/password"
	body := `{"temporaryPassword":"temporary fictional 789"}`
	expect(t, f.request("PUT", resetPath, body, teacher, ta.CSRF, f.s.Origin), 403)
	var aa state
	w := f.request("GET", "/api/v1/auth/me", "", admin, "", "")
	expect(t, w, 200)
	if err := json.Unmarshal(w.Body.Bytes(), &aa); err != nil {
		t.Fatal(err)
	}
	expect(t, f.request("PUT", resetPath, body, admin, aa.CSRF, f.s.Origin), 204)
	expect(t, f.request("GET", "/api/v1/auth/me", "", teacher, "", ""), 401)
	if f.s.CanEditSong(ctx, *ti, own) {
		t.Fatal("revoked identity accepted")
	}
	c, a := f.login("teacher@example.test", "temporary fictional 789", nil)
	if !a.User.MustChangePassword {
		t.Fatal("reset did not require change")
	}
	if err := users.SetBlocked(ctx, f.db, f.teacher.ID, true); err != nil {
		t.Fatal(err)
	}
	expect(t, f.request("GET", "/api/v1/auth/me", "", c, "", ""), 401)
	b, _ := json.Marshal(map[string]string{"email": "teacher@example.test", "password": "temporary fictional 789"})
	expect(t, f.request("POST", "/api/v1/auth/login", string(b), nil, "", f.s.Origin), 401)
	if err := users.SetBlocked(ctx, f.db, f.teacher.ID, false); err != nil {
		t.Fatal(err)
	}
	expect(t, f.request("GET", "/api/v1/auth/me", "", c, "", ""), 401)
	if err := users.SetBlocked(ctx, f.db, f.admin.ID, true); err != users.ErrConflict {
		t.Fatal("last admin blocked")
	}
	// Even a DB-side block without explicit revoke fails the identity join.
	if _, err := f.db.Exec(`UPDATE users SET blocked_at='blocked' WHERE id=?`, f.admin.ID); err != nil {
		t.Fatal(err)
	}
	if f.s.CanManageUsers(ctx, *ai) {
		t.Fatal("blocked identity accepted")
	}
}
func TestChangePasswordRevokesAllSessions(t *testing.T) {
	f := setup(t)
	one, a := f.login("teacher@example.test", sample, nil)
	two, second := f.login("teacher@example.test", sample, nil)
	expect(t, f.request("PUT", "/api/v1/auth/password", `{"currentPassword":"incorrect password","newPassword":"new fictional password"}`, one, a.CSRF, f.s.Origin), 422)
	body, _ := json.Marshal(map[string]string{"currentPassword": sample, "newPassword": sample})
	w := f.request("PUT", "/api/v1/auth/password", string(body), one, a.CSRF, f.s.Origin)
	expect(t, w, 422)
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("rejected password change modified cookie")
	}
	for index, c := range []*http.Cookie{one, two} {
		w = f.request("GET", "/api/v1/auth/me", "", c, "", "")
		expect(t, w, 200)
		var unchanged state
		if err := json.Unmarshal(w.Body.Bytes(), &unchanged); err != nil {
			t.Fatal(err)
		}
		before := []state{a, second}[index]
		if !unchanged.User.MustChangePassword || unchanged.CSRF != before.CSRF || !unchanged.Expires.Equal(before.Expires) {
			t.Fatal("rejected password change modified session or temporary status")
		}
		r := httptest.NewRequest("GET", "/api/v1/songs", nil)
		r.AddCookie(c)
		if _, err := f.s.Authenticate(context.Background(), r); err != ErrPasswordChange {
			t.Fatal("rejected password change bypassed temporary password gate")
		}
	}
	f.change(one, a)
	for _, c := range []*http.Cookie{one, two} {
		expect(t, f.request("GET", "/api/v1/auth/me", "", c, "", ""), 401)
	}
	fresh, b := f.login("teacher@example.test", replacement, nil)
	if fresh.Value == one.Value || b.User.MustChangePassword {
		t.Fatal("change password failed")
	}
	f.identity(fresh)
	expect(t, f.request("POST", "/api/v1/auth/login", `{"email":"teacher@example.test","password":"fictional password 123"}`, nil, "", f.s.Origin), 401)
}
func TestInputAndLocalBoundary(t *testing.T) {
	f := setup(t)
	for _, body := range []string{`{"email":"teacher@example.test","password":"fictional password 123","role":"admin"}`, `null`, `{} {}`, `{"email":"\ud800","password":"x"}`, "{\"email\":\"\xff\"}"} {
		expect(t, f.request("POST", "/api/v1/auth/login", body, nil, "", f.s.Origin), 422)
	}
	expect(t, f.request("POST", "/api/v1/auth/login", strings.Repeat("x", 8193), nil, "", f.s.Origin), 413)
	expect(t, f.request("POST", "/api/v1/auth/login", `{}`, nil, "", "https://attacker.test"), 403)
	r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{}`))
	r.Header.Set("Origin", f.s.Origin)
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	expect(t, w, 422)
	for _, origin := range []string{"http://choir.example.test", "https://choir.example.test/", "https://user@choir.example.test", "https://choir.example.test?x=1"} {
		if _, err := New(f.db, origin, false); err == nil {
			t.Fatal("unsafe origin accepted")
		}
	}
	if _, err := New(f.db, "http://0.0.0.0:8080", true); err == nil {
		t.Fatal("nonlocal HTTP accepted")
	}
	local, err := New(f.db, "http://127.0.0.1:8080", true)
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	local.cookie(w, "test", time.Now().Add(time.Hour))
	cookie := w.Result().Cookies()[0]
	if cookie.Secure || !cookie.HttpOnly || cookie.Name == CookieName {
		t.Fatal("local cookie scope")
	}
	if !validSurrogates([]byte(`{"x":"\ud83d\ude00"}`)) || validSurrogates([]byte(`{"x":"\udc00"}`)) {
		t.Fatal("Unicode boundary")
	}
}

func TestIdentityBoundaryAndRestart(t *testing.T) {
	f := setup(t)
	expect(t, f.request("GET", "/api/v1/auth/me", "", nil, "", ""), 401)
	c, a := f.login("teacher@example.test", sample, nil)
	r := httptest.NewRequest("GET", "/api/v1/songs?role=admin&ownerId=other", nil)
	r.AddCookie(c)
	if _, err := f.s.Authenticate(context.Background(), r); err != ErrPasswordChange {
		t.Fatal("missing password gate")
	}
	f.change(c, a)
	c, a = f.login("teacher@example.test", replacement, nil)
	old := f.identity(c)
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.db, err = platform.OpenDatabase(context.Background(), f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.s, err = New(f.db, f.s.Origin, false)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	f.s.Register(mux)
	f.handler = mux
	w := f.request("GET", "/api/v1/auth/me", "", c, "", "")
	expect(t, w, 200)
	var after state
	if err = json.Unmarshal(w.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if after.CSRF != a.CSRF || !after.Expires.Equal(a.Expires) {
		t.Fatal("restart changed session")
	}
	r = httptest.NewRequest("POST", "/api/v1/songs?role=admin&ownerId=other", nil)
	r.AddCookie(c)
	if _, err = f.s.Authenticate(context.Background(), r); err != ErrCSRF {
		t.Fatal("identity skipped CSRF")
	}
	r.Header.Set("Origin", f.s.Origin)
	r.Header.Set("X-CSRF-Token", a.CSRF)
	i, err := f.s.Authenticate(context.Background(), r)
	if err != nil || i.Role != "teacher" || i.UserID != f.teacher.ID {
		t.Fatal("identity trusts request role/owner")
	}
	if _, err = f.db.Exec(`UPDATE users SET role='admin' WHERE id=?`, f.teacher.ID); err != nil {
		t.Fatal(err)
	}
	if f.s.CanEditSong(context.Background(), *old, platform.Resource{OwnerID: f.teacher.ID}) {
		t.Fatal("stale role identity accepted")
	}
	i, err = f.s.Authenticate(context.Background(), r)
	if err != nil || i.Role != "admin" {
		t.Fatal("current role not loaded")
	}
	f.db.Close()
	if _, err = f.s.Authenticate(context.Background(), r); err == nil {
		t.Fatal("closed database authenticated")
	}
}
