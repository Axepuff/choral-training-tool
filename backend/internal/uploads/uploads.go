package uploads

import (
	"context"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/storage"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

const MaxFile int64 = 100 << 20
const OwnerQuota int64 = 10 << 30

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type Service struct {
	db             *sql.DB
	identity       platform.IdentityProvider
	store          *storage.Store
	key            cipher.AEAD
	mu             sync.Mutex
	busy           map[string]string
	reserved       map[string]int64
	maxFile, quota int64
	timeout        time.Duration
}

func New(db *sql.DB, i platform.IdentityProvider, store *storage.Store, dir string) (*Service, error) {
	key, _, e := platform.ResponseKey(dir, "upload-responses.key")
	if e != nil {
		return nil, e
	}
	rows, e := db.Query(`SELECT source_path FROM assets`)
	if e != nil {
		return nil, e
	}
	keep := map[string]bool{}
	for rows.Next() {
		var k string
		if e = rows.Scan(&k); e != nil {
			break
		}
		keep[k] = true
	}
	re := rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if re != nil {
		return nil, re
	}
	if e = store.Recover(keep); e != nil {
		return nil, e
	}
	return &Service{db: db, identity: i, store: store, key: key, busy: map[string]string{}, reserved: map[string]int64{}, maxFile: MaxFile, quota: OwnerQuota, timeout: 120 * time.Second}, nil
}
func (s *Service) Register(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/songs/{songId}/tracks/{trackId}/uploads", s.upload)
	m.HandleFunc("GET /api/v1/jobs/{jobId}", s.job)
}
func reply(w http.ResponseWriter, status int, b []byte, etag, location string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	if etag != "" {
		w.Header().Set("ETag", etag)
	}
	if location != "" {
		w.Header().Set("Location", location)
	}
	w.WriteHeader(status)
	_, _ = w.Write(b)
}
func fail(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Connection", "close")
	messages := map[string]string{"corrupt_audio": "Файл повреждён или не является поддерживаемым аудио", "unsupported_codec": "Аудиокодек не поддерживается", "too_long": "Аудио длиннее 20 минут", "probe_timeout": "Проверка аудио превысила 15 секунд", "upload_timeout": "Время загрузки истекло", "upload_too_large": "Файл больше 100 MiB", "quota_exceeded": "Квота оригиналов исчерпана", "upload_busy": "Дождитесь завершения текущей загрузки", "pending_upload": "Дорожка уже ожидает обработки", "unavailable": "Сервис временно недоступен", "validation_error": "Проверьте файл и параметры запроса", "unauthorized": "Требуется вход", "csrf_failed": "Запрос отклонён", "password_change_required": "Смените временный пароль", "not_found": "Не найдено", "forbidden": "Недостаточно прав", "precondition_required": "Нужна версия песни", "version_conflict": "Песня изменена; обновите данные", "idempotency_conflict": "Ключ использован с другим файлом"}
	b, _ := json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": messages[code], "requestId": w.Header().Get("X-Request-Id")}})
	reply(w, status, b, "", "")
}
func (s *Service) identityFor(w http.ResponseWriter, r *http.Request) *platform.Identity {
	i, e := s.identity.Authenticate(r.Context(), r)
	if e == nil && i != nil {
		return i
	}
	switch {
	case errors.Is(e, auth.ErrUnauthorized):
		fail(w, 401, "unauthorized")
	case errors.Is(e, auth.ErrCSRF):
		fail(w, 403, "csrf_failed")
	case errors.Is(e, auth.ErrPasswordChange):
		fail(w, 403, "password_change_required")
	default:
		fail(w, 503, "unavailable")
	}
	return nil
}
func (s *Service) allowed(ctx context.Context, tx *sql.Tx, i *platform.Identity, song, track string) (songs.Song, int) {
	v, e := songs.LoadSnapshot(ctx, tx, song)
	if errors.Is(e, sql.ErrNoRows) {
		return v, 404
	}
	if e != nil {
		return v, 503
	}
	if !songs.Live(ctx, tx, i, time.Now()) {
		return v, 401
	}
	if i.Role != "admin" && i.UserID != v.Owner {
		if v.Publication == "published" && v.Ready {
			return v, 403
		}
		return v, 404
	}
	if track != "" {
		var n int
		e = tx.QueryRowContext(ctx, `SELECT count(*) FROM tracks WHERE id=? AND song_id=? AND deleted_at IS NULL`, track, song).Scan(&n)
		if e != nil {
			return v, 503
		}
		if n != 1 {
			return v, 404
		}
	}
	return v, 0
}
func denied(w http.ResponseWriter, status int) {
	code := map[int]string{401: "unauthorized", 403: "forbidden", 404: "not_found", 503: "unavailable"}[status]
	fail(w, status, code)
}
func (s *Service) upload(w http.ResponseWriter, r *http.Request) {
	i := s.identityFor(w, r)
	if i == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), s.timeout)
	defer cancel()
	r = r.WithContext(ctx)
	// A read deadline interrupts a blocked network body read as well as context-aware copies.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(s.timeout))
	// net/http installs a fresh deadline for the next request; do not clear
	// an expired deadline before its unread-body cleanup.
	_ = controller.SetWriteDeadline(time.Now().Add(s.timeout + 20*time.Second))
	song, track := r.PathValue("songId"), r.PathValue("trackId")
	key := r.Header.Get("Idempotency-Key")
	if !uuid.MatchString(key) {
		fail(w, 422, "validation_error")
		return
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		fail(w, 503, "unavailable")
		return
	}
	v, status := s.allowed(ctx, tx, i, song, track)
	_ = tx.Rollback()
	if status != 0 {
		denied(w, status)
		return
	}
	s.mu.Lock()
	if len(s.busy) >= 2 || s.busy[song] != "" {
		s.mu.Unlock()
		w.Header().Set("Retry-After", "2")
		fail(w, 429, "upload_busy")
		return
	}
	// Replays need bounded scratch space but no second durable quota reservation.
	reservation := s.maxFile
	var replayExists int
	e = s.db.QueryRowContext(ctx, `SELECT count(*) FROM idempotency_records WHERE method='POST' AND actor=? AND url=? AND key=? AND key_id='upload-v1' AND expires_at>?`, i.UserID, r.URL.Path, key, time.Now().UTC().Format(time.RFC3339Nano)).Scan(&replayExists)
	if e != nil {
		s.mu.Unlock()
		fail(w, 503, "unavailable")
		return
	}
	if replayExists != 0 {
		reservation = 0
	}
	var used int64
	e = s.db.QueryRowContext(ctx, `SELECT COALESCE(sum(a.source_bytes),0) FROM assets a JOIN tracks t ON t.id=a.track_id JOIN songs s ON s.id=t.song_id WHERE s.owner_id=? AND a.source_path!=''`, v.Owner).Scan(&used)
	if e != nil {
		s.mu.Unlock()
		fail(w, 503, "unavailable")
		return
	}
	if reservation != 0 && used+s.reserved[v.Owner]+reservation > s.quota {
		s.mu.Unlock()
		fail(w, 413, "quota_exceeded")
		return
	}
	s.busy[song] = v.Owner
	s.reserved[v.Owner] += reservation
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.busy, song); s.reserved[v.Owner] -= reservation; s.mu.Unlock() }()
	stage := "stage-" + users.ID()
	original := "original-" + users.ID()
	committed := false
	defer func() {
		_ = s.store.Remove(context.Background(), stage)
		if !committed {
			_ = s.store.Remove(context.Background(), original)
		}
	}()
	r.Body = http.MaxBytesReader(w, r.Body, s.maxFile+(1<<20))
	mr, e := r.MultipartReader()
	if e != nil {
		fail(w, 422, "validation_error")
		return
	}
	part, e := mr.NextPart()
	if e != nil || part.FormName() != "file" || part.FileName() == "" {
		fail(w, 422, "validation_error")
		return
	}
	hash := sha256.New()
	e = s.store.Stage(ctx, stage, io.TeeReader(part, hash), s.maxFile)
	if e != nil {
		var filesystem *os.PathError
		var overflow *http.MaxBytesError
		var timeout net.Error
		switch {
		case errors.As(e, &filesystem):
			fail(w, 503, "unavailable")
		case errors.Is(e, storage.ErrSize) || errors.As(e, &overflow):
			fail(w, 413, "upload_too_large")
		case ctx.Err() != nil || errors.As(e, &timeout) && timeout.Timeout():
			fail(w, 408, "upload_timeout")
		default:
			fail(w, 422, "corrupt_audio")
		}
		return
	}
	if _, e = mr.NextPart(); e != io.EOF {
		fail(w, 422, "validation_error")
		return
	}
	f, e := s.store.Open(ctx, stage)
	if e != nil {
		fail(w, 503, "unavailable")
		return
	}
	file := f.(*os.File)
	st, e := file.Stat()
	if e != nil {
		f.Close()
		fail(w, 503, "unavailable")
		return
	}
	// Replay is checked after hashing, before If-Match and pending-state checks.
	tx, e = s.db.BeginTx(ctx, nil)
	if e != nil {
		f.Close()
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	v, status = s.allowed(ctx, tx, i, song, track)
	if status != 0 {
		f.Close()
		denied(w, status)
		return
	}
	aad := []byte(i.UserID + "|" + r.URL.Path + "|" + key)
	var digest, body, nonce []byte
	var savedStatus int
	var etag, location, expiry, headers string
	e = tx.QueryRowContext(ctx, `SELECT request_digest,status,response_ciphertext,nonce,headers,expires_at FROM idempotency_records WHERE method='POST' AND actor=? AND url=? AND key=? AND key_id='upload-v1'`, i.UserID, r.URL.Path, key).Scan(&digest, &savedStatus, &body, &nonce, &headers, &expiry)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		f.Close()
		fail(w, 503, "unavailable")
		return
	}
	if e == nil && expiry > time.Now().UTC().Format(time.RFC3339Nano) {
		f.Close()
		if string(digest) != string(hash.Sum(nil)) {
			fail(w, 409, "idempotency_conflict")
			return
		}
		var h map[string]string
		if json.Unmarshal([]byte(headers), &h) != nil {
			fail(w, 503, "unavailable")
			return
		}
		etag, location = h["ETag"], h["Location"]
		body, e = s.key.Open(nil, nonce, body, aad)
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		reply(w, savedStatus, body, etag, location)
		return
	}
	if replayExists != 0 {
		f.Close()
		fail(w, 409, "idempotency_conflict")
		return
	}
	if r.Header.Get("If-Match") == "" {
		f.Close()
		fail(w, 428, "precondition_required")
		return
	}
	if r.Header.Get("If-Match") != fmt.Sprintf(`"%d"`, v.Version) {
		f.Close()
		fail(w, 409, "version_conflict")
		return
	}
	var pending int
	e = tx.QueryRowContext(ctx, `SELECT count(*) FROM tracks t JOIN assets a ON a.id=t.pending_asset_id WHERE t.id=? AND a.state IN ('pending','processing')`, track).Scan(&pending)
	if e != nil {
		f.Close()
		fail(w, 503, "unavailable")
		return
	}
	if pending != 0 {
		f.Close()
		fail(w, 409, "pending_upload")
		return
	}
	// Release SQLite during the subprocess; live identity/version are checked again.
	_ = tx.Rollback()
	meta, code := probe(ctx, file)
	f.Close()
	if code == "unavailable" {
		fail(w, 503, code)
		return
	}
	if ctx.Err() != nil {
		fail(w, 408, "upload_timeout")
		return
	}
	if e = s.store.Publish(ctx, stage, original); e != nil {
		fail(w, 503, "unavailable")
		return
	}
	tx, e = s.db.BeginTx(ctx, nil)
	if e != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	current, status := s.allowed(ctx, tx, i, song, track)
	if status != 0 {
		denied(w, status)
		return
	}
	if current.Version != v.Version {
		fail(w, 409, "version_conflict")
		return
	}
	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339Nano)
	asset, job := users.ID(), users.ID()
	state, jobState := "pending", "queued"
	status = 202
	if code != "" {
		state, jobState = "failed", "failed"
		status = 422
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,duration_ms,sample_rate,channels,source_codec,source_container,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, asset, track, original, st.Size(), hash.Sum(nil), meta.Duration, meta.Rate, meta.Channels, meta.Codec, meta.Container, state, stamp, stamp)
	if e == nil {
		_, e = tx.ExecContext(ctx, `INSERT INTO jobs(id,asset_id,state,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?)`, job, asset, jobState, nullCode(code), stamp, stamp)
	}
	if e == nil {
		_, e = tx.ExecContext(ctx, `UPDATE tracks SET pending_asset_id=? WHERE id=?`, asset, track)
	}
	if e == nil {
		_, e = tx.ExecContext(ctx, `UPDATE songs SET version=version+1,updated_at=? WHERE id=?`, stamp, song)
	}
	location = "/api/v1/jobs/" + job
	etag = fmt.Sprintf(`"%d"`, v.Version+1)
	body, _ = json.Marshal(jobDTO(job, song, track, jobState, 0, nullCode(code), stamp, stamp))
	if status == 422 {
		body, _ = json.Marshal(map[string]any{"error": map[string]string{"code": code, "message": map[string]string{"corrupt_audio": "Файл повреждён или не является аудио", "unsupported_codec": "Аудиокодек не поддерживается", "too_long": "Аудио длиннее 20 минут", "probe_timeout": "Проверка превысила 15 секунд"}[code], "requestId": w.Header().Get("X-Request-Id")}})
	}
	nonce = make([]byte, s.key.NonceSize())
	if e == nil {
		_, e = rand.Read(nonce)
	}
	if e == nil {
		h, _ := json.Marshal(map[string]string{"ETag": etag, "Location": location})
		_, e = tx.ExecContext(ctx, `INSERT OR REPLACE INTO idempotency_records(method,url,actor,key,request_digest,status,headers,response_ciphertext,nonce,key_id,expires_at) VALUES('POST',?,?,?,?,?,?,?,?, 'upload-v1',?)`, r.URL.Path, i.UserID, key, hash.Sum(nil), status, string(h), s.key.Seal(nil, nonce, body, aad), nonce, now.Add(24*time.Hour).Format(time.RFC3339Nano))
	}
	if e == nil {
		_, e = tx.ExecContext(ctx, `DELETE FROM idempotency_records WHERE key_id='upload-v1' AND expires_at<=?`, stamp)
	}
	if e != nil || tx.Commit() != nil {
		fail(w, 503, "unavailable")
		return
	}
	committed = true
	reply(w, status, body, etag, location)
}
func nullCode(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func jobDTO(id, song, track, state string, attempts int, code any, created, updated string) map[string]any {
	return map[string]any{"id": id, "songId": song, "trackId": track, "state": state, "attempts": attempts, "errorCode": code, "createdAt": created, "updatedAt": updated}
}
func (s *Service) job(w http.ResponseWriter, r *http.Request) {
	i := s.identityFor(w, r)
	if i == nil {
		return
	}
	tx, e := s.db.BeginTx(r.Context(), nil)
	if e != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	var song, track, state, created, updated string
	var attempts int
	var code sql.NullString
	e = tx.QueryRowContext(r.Context(), `SELECT t.song_id,t.id,j.state,j.attempts,j.error_code,j.created_at,j.updated_at FROM jobs j JOIN assets a ON a.id=j.asset_id JOIN tracks t ON t.id=a.track_id WHERE j.id=?`, r.PathValue("jobId")).Scan(&song, &track, &state, &attempts, &code, &created, &updated)
	if errors.Is(e, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if e != nil {
		fail(w, 503, "unavailable")
		return
	}
	_, status := s.allowed(r.Context(), tx, i, song, "")
	if status != 0 {
		if status == 403 {
			status = 404
		}
		denied(w, status)
		return
	}
	b, _ := json.Marshal(jobDTO(r.PathValue("jobId"), song, track, state, attempts, nullCode(code.String), created, updated))
	reply(w, 200, b, "", "")
}
