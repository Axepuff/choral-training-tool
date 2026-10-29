// Package auth implements the API v1 identity and authorization contract.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

const CookieName = "__Host-choral_session"

var ErrUnauthorized = errors.New("unauthorized")
var ErrCSRF = errors.New("csrf_failed")
var ErrPasswordChange = errors.New("password_change_required")

type Service struct {
	DB        *sql.DB
	Origin    string
	Local     bool
	now       func() time.Time
	dummy     string
	loginSlot chan struct{}
	verify    func(string, string) bool
}

// New requires a fixed external origin; proxy headers and request Host are untrusted.
// HTTP/cookie exceptions are restricted to an explicit loopback origin.
func New(db *sql.DB, origin string, local bool) (*Service, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" {
		return nil, errors.New("invalid auth origin")
	}
	if local {
		ip := net.ParseIP(u.Hostname())
		if u.Scheme != "http" || (u.Hostname() != "localhost" && (ip == nil || !ip.IsLoopback())) {
			return nil, errors.New("local auth requires loopback HTTP")
		}
	} else if u.Scheme != "https" {
		return nil, errors.New("auth requires HTTPS")
	}
	dummy, err := users.Hash("dummy password never accepted")
	if err != nil {
		return nil, err
	}
	return &Service{DB: db, Origin: origin, Local: local, now: time.Now, dummy: dummy, loginSlot: make(chan struct{}, 1), verify: users.Verify}, nil
}
func (s *Service) cookieName() string {
	if s.Local {
		return "choral_session_local"
	}
	return CookieName
}
func digest(v string) []byte { h := sha256.Sum256([]byte(v)); return h[:] }
func csrf(token string) string {
	h := hmac.New(sha256.New, []byte(token))
	h.Write([]byte("choral-csrf-v1"))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func token() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func (s *Service) cookie(w http.ResponseWriter, value string, expiry time.Time) {
	age := int(expiry.Sub(s.now()).Seconds())
	if value == "" {
		age = -1
	}
	http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: value, Path: "/", HttpOnly: true, Secure: !s.Local, SameSite: http.SameSiteLaxMode, Expires: expiry, MaxAge: age})
}

type state struct {
	User    users.User `json:"user"`
	CSRF    string     `json:"csrfToken"`
	Expires time.Time  `json:"expiresAt"`
	ID      string     `json:"-"`
	hash    string
}
type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Service) session(ctx context.Context, q queryer, r *http.Request) (*state, error) {
	c, err := r.Cookie(s.cookieName())
	if err != nil || len(c.Value) != 43 {
		return nil, ErrUnauthorized
	}
	a := &state{}
	var expiry string
	var csrfHash []byte
	err = q.QueryRowContext(ctx, `SELECT u.id,u.email_normalized,u.role,u.must_change_password,u.password_hash,s.id,s.expires_at,s.csrf_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND u.blocked_at IS NULL`, digest(c.Value)).Scan(&a.User.ID, &a.User.Email, &a.User.Role, &a.User.MustChangePassword, &a.hash, &a.ID, &expiry, &csrfHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrUnauthorized
		}
		return nil, err
	}
	a.Expires, err = time.Parse(time.RFC3339Nano, expiry)
	if err != nil {
		return nil, err
	}
	a.CSRF = csrf(c.Value)
	if !s.now().Before(a.Expires) || subtle.ConstantTimeCompare(digest(a.CSRF), csrfHash) != 1 {
		return nil, ErrUnauthorized
	}
	return a, nil
}

// Authenticate also enforces the temporary-password gate and CSRF on writes;
// dependent APIs must use this entry point before authorizing a resource.
func (s *Service) Authenticate(ctx context.Context, r *http.Request) (*platform.Identity, error) {
	a, err := s.session(ctx, s.DB, r)
	if err != nil {
		return nil, err
	}
	if a.User.MustChangePassword && r.URL.Path != "/api/v1/auth/me" && r.URL.Path != "/api/v1/auth/password" && r.URL.Path != "/api/v1/auth/logout" {
		return nil, ErrPasswordChange
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" && !s.validCSRF(r, a) {
		return nil, ErrCSRF
	}
	return &platform.Identity{UserID: a.User.ID, Role: a.User.Role, SessionID: a.ID}, nil
}
func (s *Service) validCSRF(r *http.Request, a *state) bool {
	return r.Header.Get("Origin") == s.Origin && hmac.Equal([]byte(r.Header.Get("X-CSRF-Token")), []byte(a.CSRF))
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Cookie")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func fail(w http.ResponseWriter, status int, code, message string) {
	reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": message, "requestId": w.Header().Get("X-Request-Id")}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	typ, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || typ != "application/json" {
		fail(w, 422, "validation_error", "Требуется JSON")
		return false
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil {
		fail(w, 413, "payload_too_large", "Слишком большой запрос")
		return false
	}
	// encoding/json replaces invalid UTF-8 and lone surrogates; reject such input.
	if !utf8.Valid(b) || !validSurrogates(b) {
		fail(w, 422, "validation_error", "Некорректный Unicode")
		return false
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if err = d.Decode(v); err != nil || d.Decode(new(any)) != io.EOF || strings.TrimSpace(string(b)) == "null" {
		fail(w, 422, "validation_error", "Некорректные данные")
		return false
	}
	return true
}

// Inspect escaped code units only; escaped backslashes are skipped.
func validSurrogates(b []byte) bool {
	for i := 0; i < len(b); i++ {
		if b[i] != '\\' {
			continue
		}
		i++
		if i >= len(b) {
			return false
		}
		if b[i] != 'u' {
			continue
		}
		if i+4 >= len(b) {
			return false
		}
		var v uint16
		for _, c := range b[i+1 : i+5] {
			v *= 16
			switch {
			case c >= '0' && c <= '9':
				v += uint16(c - '0')
			case c >= 'a' && c <= 'f':
				v += uint16(c - 'a' + 10)
			case c >= 'A' && c <= 'F':
				v += uint16(c - 'A' + 10)
			default:
				return false
			}
		}
		i += 4
		if v >= 0xdc00 && v <= 0xdfff {
			return false
		}
		if v >= 0xd800 && v <= 0xdbff {
			if i+6 >= len(b) || b[i+1] != '\\' || b[i+2] != 'u' {
				return false
			}
			var low string
			low = string(b[i+3 : i+7])
			if len(low) != 4 || !(low[0] == 'd' || low[0] == 'D') || !strings.ContainsRune("cCdDeEfF", rune(low[1])) {
				return false
			}
			for _, c := range low[2:] {
				if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
					return false
				}
			}
			i += 6
		}
	}
	return true
}
func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/auth/login", s.login)
	mux.HandleFunc("GET /api/v1/auth/me", s.me)
	mux.HandleFunc("POST /api/v1/auth/logout", s.logout)
	mux.HandleFunc("PUT /api/v1/auth/password", s.password)
	mux.HandleFunc("PUT /api/v1/admin/users/{userId}/password", s.reset)
}
func (s *Service) me(w http.ResponseWriter, r *http.Request) {
	a, err := s.session(r.Context(), s.DB, r)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	reply(w, 200, a)
}
func (s *Service) sessionError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrUnauthorized) {
		fail(w, 401, "unauthorized", "Требуется вход")
	} else {
		fail(w, 503, "unavailable", "Сервис временно недоступен")
	}
}

const (
	loginFailureWindow = 5 * time.Minute
	loginCooldown      = 30 * time.Second
	loginFailureLimit  = 20
)

func (s *Service) login(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != s.Origin {
		fail(w, 403, "csrf_failed", "Запрос отклонён")
		return
	}
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	// No waiting queue: reject excess work before touching SQLite or Argon2id.
	select {
	case s.loginSlot <- struct{}{}:
		defer func() { <-s.loginSlot }()
	default:
		w.Header().Set("Retry-After", "1")
		fail(w, 429, "rate_limited", "Слишком много попыток входа")
		return
	}
	email, e := users.NormalizeEmail(in.Email)
	if e != nil {
		email = strings.ToLower(strings.TrimSpace(in.Email))
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	scope := digest(ip + "\x00" + email)
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	defer tx.Rollback()
	now := s.now().UTC()
	n := now.Unix()
	if _, err = tx.ExecContext(ctx, `DELETE FROM login_attempts WHERE window_start<=? AND locked_until<=?`, n-int64(loginFailureWindow/time.Second), n); err != nil {
		s.sessionError(w, err)
		return
	}
	var failures int
	var start, locked int64
	err = tx.QueryRowContext(ctx, `SELECT failures,window_start,locked_until FROM login_attempts WHERE scope=?`, scope).Scan(&failures, &start, &locked)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.sessionError(w, err)
		return
	}
	if locked > n {
		// Shorten pre-upgrade locks once, persistently; retries must not extend them.
		if remaining := int64(loginCooldown / time.Second); locked-n > remaining {
			locked = n + remaining
			if _, err = tx.ExecContext(ctx, `UPDATE login_attempts SET locked_until=? WHERE scope=?`, locked, scope); err != nil {
				s.sessionError(w, err)
				return
			}
			if err = tx.Commit(); err != nil {
				s.sessionError(w, err)
				return
			}
		}
		w.Header().Set("Retry-After", strconv.FormatInt(locked-n, 10))
		fail(w, 429, "rate_limited", "Слишком много попыток входа")
		return
	}
	if locked != 0 || n-start >= int64(loginFailureWindow/time.Second) {
		locked = 0
		failures = 0
		start = n
	}
	// A single persistent budget bounds work even when both IP and email change.
	globalScope := digest("login-global-v1")
	var attempts int
	var window int64
	err = tx.QueryRowContext(ctx, `SELECT failures,window_start FROM login_attempts WHERE scope=?`, globalScope).Scan(&attempts, &window)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.sessionError(w, err)
		return
	}
	if n-window >= 60 {
		attempts, window = 0, n
	}
	if attempts >= 20 {
		w.Header().Set("Retry-After", strconv.FormatInt(window+60-n, 10))
		fail(w, 429, "rate_limited", "Слишком много попыток входа")
		return
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO login_attempts(scope,failures,window_start) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET failures=excluded.failures,window_start=excluded.window_start`, globalScope, attempts+1, window)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	a := &state{}
	var hash, revision string
	var blocked bool
	err = tx.QueryRowContext(ctx, `SELECT id,email_normalized,role,must_change_password,password_hash,blocked_at IS NOT NULL,updated_at FROM users WHERE email_normalized=?`, email).Scan(&a.User.ID, &a.User.Email, &a.User.Role, &a.User.MustChangePassword, &hash, &blocked, &revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.sessionError(w, err)
		return
	}
	if hash == "" {
		hash = s.dummy
	}
	if err = tx.Commit(); err != nil {
		s.sessionError(w, err)
		return
	}
	valid := s.verify(hash, in.Password)
	tx, err = s.DB.BeginTx(ctx, nil)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	defer tx.Rollback()
	// Credentials and account state must still match at session issuance.
	var current bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND email_normalized=? AND password_hash=? AND role=? AND must_change_password=? AND blocked_at IS NULL AND updated_at=?)`, a.User.ID, a.User.Email, hash, a.User.Role, a.User.MustChangePassword, revision).Scan(&current)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	valid = valid && current
	now = s.now().UTC()
	n = now.Unix()
	if !valid || blocked || a.User.ID == "" || e != nil {
		failures++
		if failures >= loginFailureLimit {
			locked = n + int64(loginCooldown/time.Second)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO login_attempts(scope,failures,window_start,locked_until) VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET failures=excluded.failures,window_start=excluded.window_start,locked_until=excluded.locked_until`, scope, failures, start, locked)
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			s.sessionError(w, err)
			return
		}
		fail(w, 401, "invalid_credentials", "Неверный email или пароль")
		return
	}
	// A successful login resets this IP/email scope.
	if _, err = tx.ExecContext(ctx, `DELETE FROM login_attempts WHERE scope=?`, scope); err != nil {
		s.sessionError(w, err)
		return
	}
	if c, err := r.Cookie(s.cookieName()); err == nil {
		if _, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=?,updated_at=? WHERE token_hash=?`, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), digest(c.Value)); err != nil {
			s.sessionError(w, err)
			return
		}
	}
	raw, err := token()
	if err != nil {
		s.sessionError(w, err)
		return
	}
	a.CSRF = csrf(raw)
	a.Expires = now.Add(7 * 24 * time.Hour)
	a.ID = users.ID()
	_, err = tx.ExecContext(ctx, `INSERT INTO sessions(id,user_id,token_hash,csrf_hash,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, a.ID, a.User.ID, digest(raw), digest(a.CSRF), a.Expires.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		s.sessionError(w, err)
		return
	}
	s.cookie(w, raw, a.Expires)
	reply(w, 200, a)
}

func (s *Service) writeSession(w http.ResponseWriter, r *http.Request, tx *sql.Tx) (*state, bool) {
	a, err := s.session(r.Context(), tx, r)
	if err != nil {
		s.sessionError(w, err)
		return nil, false
	}
	if !s.validCSRF(r, a) {
		fail(w, 403, "csrf_failed", "Запрос отклонён")
		return nil, false
	}
	return a, true
}
func (s *Service) logout(w http.ResponseWriter, r *http.Request) {
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	defer tx.Rollback()
	a, ok := s.writeSession(w, r, tx)
	if !ok {
		return
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	_, err = tx.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=?,updated_at=? WHERE id=?`, now, now, a.ID)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		s.sessionError(w, err)
		return
	}
	s.cookie(w, "", time.Unix(1, 0))
	reply(w, 204, nil)
}
func (s *Service) password(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Current string `json:"currentPassword"`
		New     string `json:"newPassword"`
	}
	if !decode(w, r, &in) {
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	defer tx.Rollback()
	a, ok := s.writeSession(w, r, tx)
	if !ok {
		return
	}
	if !users.Verify(a.hash, in.Current) {
		fail(w, 422, "validation_error", "Неверный текущий пароль")
		return
	}
	if a.User.MustChangePassword && in.New == in.Current {
		fail(w, 422, "validation_error", "Новый пароль должен отличаться от временного")
		return
	}
	hash, err := users.Hash(in.New)
	if err != nil {
		fail(w, 422, "validation_error", "Пароль должен содержать 12–128 символов")
		return
	}
	if err = users.SetPassword(r.Context(), tx, a.User.ID, hash, false); err == nil {
		err = tx.Commit()
	}
	if err != nil {
		s.sessionError(w, err)
		return
	}
	s.cookie(w, "", time.Unix(1, 0))
	reply(w, 204, nil)
}
func (s *Service) reset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"temporaryPassword"`
	}
	if !decode(w, r, &in) {
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	defer tx.Rollback()
	a, ok := s.writeSession(w, r, tx)
	if !ok {
		return
	}
	if a.User.Role != "admin" || a.User.MustChangePassword {
		fail(w, 403, "forbidden", "Недостаточно прав")
		return
	}
	hash, err := users.Hash(in.Password)
	if err != nil {
		fail(w, 422, "validation_error", "Пароль должен содержать 12–128 символов")
		return
	}
	err = users.SetPassword(r.Context(), tx, r.PathValue("userId"), hash, true)
	if errors.Is(err, users.ErrInvalid) {
		fail(w, 404, "not_found", "Пользователь не найден")
		return
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		s.sessionError(w, err)
		return
	}
	reply(w, 204, nil)
}

// liveIdentity rechecks session, role, blocking and password gate. A role supplied
// by a caller cannot elevate privileges, even if it has a valid user's ID.
func (s *Service) liveIdentity(ctx context.Context, i platform.Identity) string {
	var role string
	var expiry string
	err := s.DB.QueryRowContext(ctx, `SELECT u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.id=? AND s.revoked_at IS NULL AND u.blocked_at IS NULL AND u.must_change_password=0`, i.SessionID, i.UserID).Scan(&role, &expiry)
	t, e := time.Parse(time.RFC3339Nano, expiry)
	if err != nil || e != nil || !s.now().Before(t) || role != i.Role {
		return ""
	}
	return role
}
func (s *Service) CanReadSong(ctx context.Context, i *platform.Identity, g *platform.ShareGrant, r platform.Resource) bool {
	if i != nil {
		role := s.liveIdentity(ctx, *i)
		if role == "admin" || role == "teacher" && (i.UserID == r.OwnerID || r.Publication == "published" && r.Ready) {
			return true
		}
	}
	return g != nil && g.ShareID != "" && r.Publication == "published" && r.Ready && g.OwnerID == r.OwnerID && ((g.Kind == "song" && g.SongID == r.SongID) || (g.Kind == "list" && g.SongID == ""))
}
func (s *Service) CanEditSong(ctx context.Context, i platform.Identity, r platform.Resource) bool {
	role := s.liveIdentity(ctx, i)
	return role == "admin" || role == "teacher" && i.UserID == r.OwnerID
}
func (s *Service) CanManageShare(ctx context.Context, i platform.Identity, r *platform.Resource, owner string) bool {
	if r != nil && r.OwnerID != owner {
		return false
	}
	role := s.liveIdentity(ctx, i)
	return role == "admin" || role == "teacher" && owner == i.UserID
}
func (s *Service) CanManageUsers(ctx context.Context, i platform.Identity) bool {
	return s.liveIdentity(ctx, i) == "admin"
}

var _ platform.IdentityProvider = (*Service)(nil)
var _ platform.Authorizer = (*Service)(nil)
