// Package sharing owns bearer grants and authorized playback reads.
package sharing

import (
	"context"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type Service struct {
	DB       *sql.DB
	Identity platform.IdentityProvider
	Access   platform.Authorizer
	Storage  platform.Storage
	key      cipher.AEAD
	now      func() time.Time
}

func New(db *sql.DB, i platform.IdentityProvider, a platform.Authorizer, storage platform.Storage, dir string) (*Service, error) {
	key, _, err := platform.ResponseKey(dir, "share-responses.key")
	if err != nil {
		return nil, err
	}
	return &Service{db, i, a, storage, key, time.Now}, nil
}
func (s *Service) Register(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/shares", s.list)
	m.HandleFunc("POST /api/v1/shares", s.write)
	m.HandleFunc("POST /api/v1/shares/{shareId}/rotate", s.write)
	m.HandleFunc("DELETE /api/v1/shares/{shareId}", s.write)
	m.HandleFunc("GET /api/v1/public/shares/{token}", s.public)
	for _, prefix := range []string{"/api/v1", "/api/v1/public/shares/{token}"} {
		m.HandleFunc("GET "+prefix+"/songs/{songId}/tracks/{trackId}/media", s.media)
		m.HandleFunc("GET "+prefix+"/songs/{songId}/tracks/{trackId}/peaks", s.media)
	}
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func fail(w http.ResponseWriter, status int, code string) {
	reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": http.StatusText(status), "requestId": w.Header().Get("X-Request-Id")}})
}
func (s *Service) identity(w http.ResponseWriter, r *http.Request) *platform.Identity {
	w.Header().Set("Vary", "Cookie")
	i, err := s.Identity.Authenticate(r.Context(), r)
	if err == nil && i != nil {
		return i
	}
	switch {
	case errors.Is(err, auth.ErrUnauthorized):
		fail(w, 401, "unauthorized")
	case errors.Is(err, auth.ErrCSRF):
		fail(w, 403, "csrf_failed")
	case errors.Is(err, auth.ErrPasswordChange):
		fail(w, 403, "password_change_required")
	default:
		fail(w, 503, "unavailable")
	}
	return nil
}

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func hash(raw string) []byte { h := sha256.Sum256([]byte(raw)); return h[:] }
func token() (string, error) {
	b := make([]byte, 32)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}

type share struct {
	ID       string  `json:"id"`
	Kind     string  `json:"kind"`
	Owner    string  `json:"ownerId"`
	Song     *string `json:"songId"`
	Disabled *string `json:"disabledAt"`
	Created  string  `json:"createdAt"`
}
type secret struct {
	Share share  `json:"share"`
	Token string `json:"token"`
	URL   string `json:"url"`
}
type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func load(ctx context.Context, q queryer, id string) (share, error) {
	var v share
	err := q.QueryRowContext(ctx, `SELECT id,kind,owner_id,song_id,disabled_at,created_at FROM shares WHERE id=?`, id).Scan(&v.ID, &v.Kind, &v.Owner, &v.Song, &v.Disabled, &v.Created)
	return v, err
}
func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	i := s.identity(w, r)
	if i == nil {
		return
	}
	owner := r.URL.Query().Get("ownerId")
	if owner == "" {
		owner = i.UserID
	}
	if !uuid.MatchString(owner) {
		fail(w, 422, "validation_error")
		return
	}
	if !s.Access.CanManageShare(r.Context(), *i, nil, owner) {
		fail(w, 403, "forbidden")
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT id,kind,owner_id,song_id,disabled_at,created_at FROM shares WHERE owner_id=? ORDER BY created_at,id`, owner)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer rows.Close()
	items := []share{}
	for rows.Next() {
		var v share
		if err = rows.Scan(&v.ID, &v.Kind, &v.Owner, &v.Song, &v.Disabled, &v.Created); err != nil {
			break
		}
		items = append(items, v)
	}
	if err != nil || rows.Err() != nil {
		fail(w, 503, "unavailable")
		return
	}
	reply(w, 200, map[string]any{"items": items})
}
func decode(w http.ResponseWriter, r *http.Request) (map[string]string, bool) {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		fail(w, 422, "validation_error")
		return nil, false
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	var v map[string]string
	if err = d.Decode(&v); err != nil {
		var size *http.MaxBytesError
		if errors.As(err, &size) {
			fail(w, 413, "payload_too_large")
		} else {
			fail(w, 422, "validation_error")
		}
		return nil, false
	}
	var extra any
	if err = d.Decode(&extra); err != io.EOF {
		var size *http.MaxBytesError
		if errors.As(err, &size) {
			fail(w, 413, "payload_too_large")
			return nil, false
		}
		fail(w, 422, "validation_error")
		return nil, false
	}
	if len(v) != 2 || v["kind"] != "song" && v["kind"] != "list" || v["kind"] == "song" && !uuid.MatchString(v["songId"]) || v["kind"] == "list" && !uuid.MatchString(v["ownerId"]) {
		fail(w, 422, "validation_error")
		return nil, false
	}
	return v, true
}
func (s *Service) write(w http.ResponseWriter, r *http.Request) {
	i := s.identity(w, r)
	if i == nil {
		return
	}
	ctx := r.Context()
	create := r.PathValue("shareId") == ""
	var in map[string]string
	key := r.Header.Get("Idempotency-Key")
	if create {
		var ok bool
		in, ok = decode(w, r)
		if !ok {
			return
		}
		if !uuid.MatchString(key) {
			fail(w, 422, "validation_error")
			return
		}
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	if !songs.Live(ctx, tx, i, s.now()) {
		fail(w, 401, "unauthorized")
		return
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	var v share
	var digest []byte
	aad := []byte("POST:/api/v1/shares:" + i.UserID + ":" + key)
	if create {
		normalized, _ := json.Marshal(in)
		digest = hash(string(normalized))
		if _, err = tx.ExecContext(ctx, `DELETE FROM idempotency_records WHERE expires_at<=?`, now); err != nil {
			fail(w, 503, "unavailable")
			return
		}
		var saved, body, nonce []byte
		err = tx.QueryRowContext(ctx, `SELECT request_digest,response_ciphertext,nonce FROM idempotency_records WHERE method='POST' AND url='/api/v1/shares' AND actor=? AND key=?`, i.UserID, key).Scan(&saved, &body, &nonce)
		if err == nil {
			if string(saved) != string(digest) {
				fail(w, 409, "idempotency_conflict")
				return
			}
			if len(nonce) != s.key.NonceSize() {
				fail(w, 503, "unavailable")
				return
			}
			body, err = s.key.Open(nil, nonce, body, aad)
			var result secret
			if err != nil || json.Unmarshal(body, &result) != nil {
				fail(w, 503, "unavailable")
				return
			}
			var count int
			err = tx.QueryRowContext(ctx, `SELECT count(*) FROM shares WHERE id=? AND token_hash=? AND disabled_at IS NULL`, result.Share.ID, hash(result.Token)).Scan(&count)
			if err != nil {
				fail(w, 503, "unavailable")
				return
			}
			if count != 1 {
				fail(w, 409, "idempotency_stale")
				return
			}
			if tx.Commit() != nil {
				fail(w, 503, "unavailable")
				return
			}
			w.Header().Set("Location", "/api/v1/shares/"+result.Share.ID)
			reply(w, 201, result)
			return
		}
		if !errors.Is(err, sql.ErrNoRows) {
			fail(w, 503, "unavailable")
			return
		}
		v = share{ID: users.ID(), Kind: in["kind"], Owner: in["ownerId"], Created: now}
		if v.Kind == "song" {
			id := in["songId"]
			v.Song = &id
			err = tx.QueryRowContext(ctx, `SELECT owner_id FROM songs WHERE id=? AND deleted_at IS NULL`, id).Scan(&v.Owner)
		} else {
			var id string
			err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE id=?`, v.Owner).Scan(&id)
		}
	} else {
		v, err = load(ctx, tx, r.PathValue("shareId"))
	}
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	// Live identity and ownership are checked in the same write transaction.
	if i.Role != "admin" && v.Owner != i.UserID {
		fail(w, 404, "not_found")
		return
	}
	if v.Song != nil {
		var owner string
		err = tx.QueryRowContext(ctx, `SELECT owner_id FROM songs WHERE id=? AND deleted_at IS NULL`, *v.Song).Scan(&owner)
		if errors.Is(err, sql.ErrNoRows) || err == nil && owner != v.Owner {
			fail(w, 404, "not_found")
			return
		}
		if err != nil {
			fail(w, 503, "unavailable")
			return
		}
	}
	if r.Method == "DELETE" {
		_, err = tx.ExecContext(ctx, `UPDATE shares SET disabled_at=COALESCE(disabled_at,?),updated_at=? WHERE id=?`, now, now, v.ID)
		if err != nil || tx.Commit() != nil {
			fail(w, 503, "unavailable")
			return
		}
		reply(w, 204, nil)
		return
	}
	raw, err := token()
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	v.Disabled = nil
	if create {
		_, err = tx.ExecContext(ctx, `INSERT INTO shares(id,kind,owner_id,song_id,token_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, v.ID, v.Kind, v.Owner, v.Song, hash(raw), now, now)
	} else {
		_, err = tx.ExecContext(ctx, `UPDATE shares SET token_hash=?,disabled_at=NULL,updated_at=? WHERE id=?`, hash(raw), now, v.ID)
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	result := secret{v, raw, "/?list=" + raw}
	if v.Kind == "song" {
		result.URL = "/?song=" + raw
	}
	status := 200
	if create {
		status = 201
		body, _ := json.Marshal(result)
		nonce := make([]byte, s.key.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			fail(w, 503, "unavailable")
			return
		}
		body = s.key.Seal(nil, nonce, body, aad)
		_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_records(method,url,actor,key,request_digest,status,headers,response_ciphertext,nonce,key_id,expires_at) VALUES('POST','/api/v1/shares',?,?,?,201,'{}',?,?, 'shares-v1',?)`, i.UserID, key, digest, body, nonce, s.now().Add(24*time.Hour).UTC().Format(time.RFC3339Nano))
	}
	if err != nil || tx.Commit() != nil {
		fail(w, 503, "unavailable")
		return
	}
	if create {
		w.Header().Set("Location", "/api/v1/shares/"+v.ID)
	}
	reply(w, status, result)
}

// grant is the only entrance for public access; cookies never augment it.
func grant(ctx context.Context, q queryer, raw string) (*platform.ShareGrant, error) {
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(b) != 32 || base64.RawURLEncoding.EncodeToString(b) != raw {
		return nil, sql.ErrNoRows
	}
	var g platform.ShareGrant
	var song sql.NullString
	err = q.QueryRowContext(ctx, `SELECT id,kind,owner_id,song_id FROM shares WHERE token_hash=? AND disabled_at IS NULL`, hash(raw)).Scan(&g.ShareID, &g.Kind, &g.OwnerID, &song)
	g.SongID = song.String
	return &g, err
}
