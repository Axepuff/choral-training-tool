package songs

import (
	"context"
	"crypto/cipher"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type Service struct {
	DB        *sql.DB
	Identity  platform.IdentityProvider
	Access    platform.Authorizer
	now       func() time.Time
	replay    cipher.AEAD
	cursorKey []byte
}

func (s *Service) Register(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/songs", s.list)
	m.HandleFunc("POST /api/v1/songs", s.write)
	m.HandleFunc("GET /api/v1/songs/{songId}", s.get)
	m.HandleFunc("PUT /api/v1/songs/{songId}", s.write)
	m.HandleFunc("DELETE /api/v1/songs/{songId}", s.write)
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}
func fail(w http.ResponseWriter, status int, code string) {
	messages := map[string]string{"validation_error": "Проверьте данные", "unauthorized": "Требуется вход", "csrf_failed": "Запрос отклонён", "password_change_required": "Смените временный пароль", "unavailable": "Сервис временно недоступен", "not_found": "Не найдено", "forbidden": "Недостаточно прав", "precondition_required": "Нужна версия песни", "version_conflict": "Песня изменена; обновите данные", "media_not_ready": "Дорожки ещё не готовы", "idempotency_conflict": "Ключ операции уже использован с другими данными", "invalid_cursor": "Неверная страница списка", "cursor_expired": "Срок просмотра списка истёк; откройте его заново", "payload_too_large": "Слишком большой запрос"}
	reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": messages[code], "requestId": w.Header().Get("X-Request-Id")}})
}
func (s *Service) identity(w http.ResponseWriter, r *http.Request) *platform.Identity {
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

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func load(ctx context.Context, q queryer, id string) (Song, error) {
	var v Song
	err := q.QueryRowContext(ctx, `SELECT id,owner_id,title,bpm,beats_per_bar,beat_unit,notes,publication,version,updated_at FROM songs WHERE id=? AND deleted_at IS NULL`, id).Scan(&v.ID, &v.Owner, &v.Title, &v.BPM, &v.Beats, &v.Unit, &v.Notes, &v.Publication, &v.Version, &v.Updated)
	if err != nil {
		return v, err
	}
	rows, err := q.QueryContext(ctx, `SELECT t.id,t.position,t.name,t.gain,a.state,a.duration_ms,p.state,
 (SELECT j.id FROM jobs j WHERE j.asset_id=p.id ORDER BY j.created_at DESC,j.id LIMIT 1)
 FROM tracks t LEFT JOIN assets a ON a.id=t.active_asset_id AND a.track_id=t.id LEFT JOIN assets p ON p.id=t.pending_asset_id AND p.track_id=t.id WHERE t.song_id=? AND t.deleted_at IS NULL ORDER BY t.position`, id)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	v.Tracks = []Track{}
	v.Ready = true
	for rows.Next() {
		var t Track
		var active, pending, job sql.NullString
		var duration sql.NullInt64
		if err = rows.Scan(&t.ID, &t.Position, &t.Name, &t.Gain, &active, &duration, &pending, &job); err != nil {
			return v, err
		}
		t.Status = "empty"
		if pending.Valid {
			switch pending.String {
			case "pending":
				t.Status = "queued"
			case "processing", "failed":
				t.Status = pending.String
			}
		}
		if job.Valid {
			x := job.String
			t.PendingJob = &x
		}
		if active.String == "ready" && duration.Valid {
			t.Status = "ready"
			d := duration.Int64
			t.Duration = &d
			media := "/api/v1/songs/" + id + "/tracks/" + t.ID + "/media"
			peaks := "/api/v1/songs/" + id + "/tracks/" + t.ID + "/peaks"
			t.Media = &media
			t.Peaks = &peaks
			if v.Duration == nil || d > *v.Duration {
				v.Duration = &d
			}
		} else {
			v.Ready = false
		}
		v.Tracks = append(v.Tracks, t)
	}
	if len(v.Tracks) == 0 {
		v.Ready = false
	}
	if v.Duration != nil {
		bars := int64(math.Ceil(float64(*v.Duration) * float64(v.BPM*v.Unit) / float64(60000*v.Beats*4)))
		v.Bars = &bars
	}
	return v, rows.Err()
}

// Read all fields/tracks from one snapshot, including concurrent editor updates.
func (s *Service) load(ctx context.Context, id string) (Song, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Song{}, err
	}
	defer tx.Rollback()
	v, err := load(ctx, tx, id)
	if err != nil {
		return v, err
	}
	return v, tx.Commit()
}
func resource(v Song) platform.Resource {
	return platform.Resource{SongID: v.ID, OwnerID: v.Owner, Publication: v.Publication, Ready: v.Ready}
}
func etag(v Song) string { return fmt.Sprintf(`"%d"`, v.Version) }
func (s *Service) readable(ctx context.Context, i *platform.Identity, v Song) bool {
	return s.Access.CanReadSong(ctx, i, nil, resource(v))
}
func (s *Service) present(ctx context.Context, i *platform.Identity, v Song) Song {
	if !s.Access.CanEditSong(ctx, *i, resource(v)) {
		for n := range v.Tracks {
			v.Tracks[n].PendingJob = nil
		}
	}
	return v
}
func (s *Service) get(w http.ResponseWriter, r *http.Request) {
	i := s.identity(w, r)
	if i == nil {
		return
	}
	v, err := s.load(r.Context(), r.PathValue("songId"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	if !s.readable(r.Context(), i, v) {
		fail(w, 404, "not_found")
		return
	}
	w.Header().Set("ETag", etag(v))
	reply(w, 200, s.present(r.Context(), i, v))
}

// Recheck identity in the writing transaction, without reentering the one-connection
// pool through Authorizer. Revocation/role changes cannot race a committed write.
func live(ctx context.Context, tx *sql.Tx, i *platform.Identity, now time.Time) bool {
	var expiry string
	err := tx.QueryRowContext(ctx, `SELECT s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND u.id=? AND u.role=? AND s.revoked_at IS NULL AND u.blocked_at IS NULL AND u.must_change_password=0`, i.SessionID, i.UserID, i.Role).Scan(&expiry)
	t, e := time.Parse(time.RFC3339Nano, expiry)
	return err == nil && e == nil && now.Before(t)
}
func (s *Service) write(w http.ResponseWriter, r *http.Request) {
	i := s.identity(w, r)
	if i == nil {
		return
	}
	ctx := r.Context()
	create := r.Method == "POST"
	deleting := r.Method == "DELETE"
	var in songWrite
	var before Song
	var err error
	var version int64
	if !create {
		before, err = s.load(ctx, r.PathValue("songId"))
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "not_found")
			return
		}
		if err != nil {
			fail(w, 503, "unavailable")
			return
		}
		if !s.readable(ctx, i, before) {
			fail(w, 404, "not_found")
			return
		}
		if !s.Access.CanEditSong(ctx, *i, resource(before)) {
			fail(w, 403, "forbidden")
			return
		}
		h := r.Header.Get("If-Match")
		if h == "" {
			fail(w, 428, "precondition_required")
			return
		}
		if len(h) < 3 || h[0] != '"' || h[len(h)-1] != '"' {
			fail(w, 422, "validation_error")
			return
		}
		version, err = strconv.ParseInt(h[1:len(h)-1], 10, 64)
		if err != nil || version < 1 || fmt.Sprintf(`"%d"`, version) != h {
			fail(w, 422, "validation_error")
			return
		}
	}
	if !deleting && !decode(w, r, &in) {
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if create && !uuid.MatchString(key) {
		fail(w, 422, "validation_error")
		return
	}
	normalized, _ := json.Marshal(in)
	digest := sha256.Sum256(normalized)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	if !live(ctx, tx, i, s.now()) {
		fail(w, 401, "unauthorized")
		return
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	if create {
		if _, err = tx.ExecContext(ctx, `DELETE FROM idempotency_records WHERE expires_at<=?`, now); err != nil {
			fail(w, 503, "unavailable")
			return
		}
		var saved, body, nonce []byte
		aad := []byte("POST:/api/v1/songs:" + i.UserID + ":" + key)
		err = tx.QueryRowContext(ctx, `SELECT request_digest,response_ciphertext,nonce FROM idempotency_records WHERE method='POST' AND url='/api/v1/songs' AND actor=? AND key=?`, i.UserID, key).Scan(&saved, &body, &nonce)
		if err == nil {
			if string(saved) != string(digest[:]) {
				fail(w, 409, "idempotency_conflict")
				return
			}
			var v Song
			if len(nonce) != s.replay.NonceSize() {
				fail(w, 503, "unavailable")
				return
			}
			body, err = s.replay.Open(nil, nonce, body, aad)
			if err != nil || json.Unmarshal(body, &v) != nil {
				fail(w, 503, "unavailable")
				return
			}
			if tx.Commit() != nil {
				fail(w, 503, "unavailable")
				return
			}
			w.Header().Set("Location", "/api/v1/songs/"+v.ID)
			w.Header().Set("ETag", etag(v))
			reply(w, 201, v)
			return
		}
		if !errors.Is(err, sql.ErrNoRows) {
			fail(w, 503, "unavailable")
			return
		}
		before.ID = users.ID()
		before.Owner = i.UserID
		_, err = tx.ExecContext(ctx, `INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,notes,publication,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, before.ID, i.UserID, *in.Title, *in.BPM, *in.Beats, *in.Unit, *in.Notes, *in.Publication, now, now)
	} else {
		// Owner and current version are read again under the transaction's snapshot.
		current, e := load(ctx, tx, before.ID)
		if e != nil {
			if errors.Is(e, sql.ErrNoRows) {
				fail(w, 404, "not_found")
			} else {
				fail(w, 503, "unavailable")
			}
			return
		}
		if current.Owner != i.UserID && i.Role != "admin" {
			fail(w, 404, "not_found")
			return
		}
		if current.Version != version {
			fail(w, 409, "version_conflict")
			return
		}
		before = current
		if deleting {
			_, err = tx.ExecContext(ctx, `UPDATE songs SET deleted_at=?,updated_at=?,publication='draft',version=version+1 WHERE id=?`, now, now, before.ID)
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE songs SET title=?,bpm=?,beats_per_bar=?,beat_unit=?,notes=?,publication=?,updated_at=?,version=version+1 WHERE id=?`, *in.Title, *in.BPM, *in.Beats, *in.Unit, *in.Notes, *in.Publication, now, before.ID)
		}
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	keep := map[string]bool{}
	old := map[string]Track{}
	for _, t := range before.Tracks {
		old[t.ID] = t
	}
	if !deleting {
		// Hide all positions first so arbitrary swaps never collide with the unique index.
		if _, err = tx.ExecContext(ctx, `UPDATE tracks SET deleted_at=? WHERE song_id=? AND deleted_at IS NULL`, now, before.ID); err != nil {
			fail(w, 503, "unavailable")
			return
		}
		for _, t := range in.Tracks {
			id := ""
			if t.ID != nil {
				id = *t.ID
				if _, ok := old[id]; !ok {
					fail(w, 422, "validation_error")
					return
				}
			} else {
				id = users.ID()
			}
			keep[id] = true
			if t.ID != nil {
				_, err = tx.ExecContext(ctx, `UPDATE tracks SET name=?,position=?,gain=?,deleted_at=NULL WHERE id=? AND song_id=?`, *t.Name, *t.Position, *t.Gain, id, before.ID)
			} else {
				_, err = tx.ExecContext(ctx, `INSERT INTO tracks(id,song_id,position,name,gain) VALUES(?,?,?,?,?)`, id, before.ID, *t.Position, *t.Name, *t.Gain)
			}
			if err != nil {
				fail(w, 503, "unavailable")
				return
			}
		}
	}
	for _, t := range before.Tracks {
		if !keep[t.ID] {
			if err = retire(ctx, tx, t.ID, now); err != nil {
				fail(w, 503, "unavailable")
				return
			}
		}
	}
	if deleting {
		if _, err = tx.ExecContext(ctx, `UPDATE shares SET disabled_at=?,updated_at=? WHERE song_id=? AND disabled_at IS NULL`, now, now, before.ID); err != nil {
			fail(w, 503, "unavailable")
			return
		}
		if tx.Commit() != nil {
			fail(w, 503, "unavailable")
			return
		}
		reply(w, 204, nil)
		return
	}
	v, err := load(ctx, tx, before.ID)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	if v.Publication == "published" && !v.Ready {
		fail(w, 409, "media_not_ready")
		return
	}
	if create {
		body, _ := json.Marshal(v)
		aad := []byte("POST:/api/v1/songs:" + i.UserID + ":" + key)
		encrypted, nonce, e := s.seal(body, aad)
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		headers, _ := json.Marshal(map[string]string{"Location": "/api/v1/songs/" + v.ID, "ETag": etag(v)})
		_, err = tx.ExecContext(ctx, `INSERT INTO idempotency_records(method,url,actor,key,request_digest,status,headers,response_ciphertext,nonce,key_id,expires_at) VALUES('POST','/api/v1/songs',?,?,?,201,?,?,?,'songs-v1',?)`, i.UserID, key, digest[:], string(headers), encrypted, nonce, s.now().Add(24*time.Hour).UTC().Format(time.RFC3339Nano))
		if err != nil {
			fail(w, 503, "unavailable")
			return
		}
	}
	if tx.Commit() != nil {
		fail(w, 503, "unavailable")
		return
	}
	w.Header().Set("ETag", etag(v))
	status := 200
	if create {
		status = 201
		w.Header().Set("Location", "/api/v1/songs/"+v.ID)
	}
	reply(w, status, v)
}
func retire(ctx context.Context, tx *sql.Tx, id, now string) error {
	for _, q := range []string{
		`UPDATE jobs SET state='canceled',lease_until=NULL,updated_at=? WHERE asset_id IN (SELECT id FROM assets WHERE track_id=?) AND state IN ('queued','processing')`,
		`UPDATE assets SET state='retired',updated_at=? WHERE track_id=?`,
		`UPDATE tracks SET deleted_at=?,active_asset_id=NULL,pending_asset_id=NULL WHERE id=?`,
	} {
		if _, err := tx.ExecContext(ctx, q, now, id); err != nil {
			return err
		}
	}
	return nil
}
