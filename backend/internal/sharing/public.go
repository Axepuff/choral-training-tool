package sharing

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

// Explicit allowlists keep editor, account, job and filesystem fields private.
func publicSong(v songs.Song, raw string) map[string]any {
	tracks := []map[string]any{}
	for _, t := range v.Tracks {
		base := "/api/v1/public/shares/" + raw + "/songs/" + v.ID + "/tracks/" + t.ID
		tracks = append(tracks, map[string]any{"id": t.ID, "position": t.Position, "name": t.Name, "gain": t.Gain, "durationMs": t.Duration, "mediaUrl": base + "/media", "peaksUrl": base + "/peaks"})
	}
	return map[string]any{"id": v.ID, "title": v.Title, "bpm": v.BPM, "beatsPerBar": v.Beats, "beatUnit": v.Unit, "notes": v.Notes, "durationMs": v.Duration, "barCount": v.Bars, "tracks": tracks}
}

type page struct {
	ID       string
	Position int
}

func (s *Service) public(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw := r.PathValue("token")
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	g, err := grant(ctx, tx, raw)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	limit := 30
	if values, ok := r.URL.Query()["limit"]; ok {
		if len(values) != 1 {
			fail(w, 422, "validation_error")
			return
		}
		limit, err = strconv.Atoi(values[0])
		if err != nil || limit < 1 || limit > 100 {
			fail(w, 422, "validation_error")
			return
		}
	}
	scope := hash("/api/v1/public/shares/" + raw)
	ids := []string{}
	p := page{}
	if c := r.URL.Query().Get("cursor"); c != "" {
		encrypted, e := base64.RawURLEncoding.DecodeString(c)
		n := s.key.NonceSize()
		if e != nil || len(encrypted) < n {
			fail(w, 400, "invalid_cursor")
			return
		}
		body, e := s.key.Open(nil, encrypted[:n], encrypted[n:], scope)
		if e != nil || json.Unmarshal(body, &p) != nil || !uuid.MatchString(p.ID) || p.Position < 0 || g.Kind != "list" {
			fail(w, 400, "invalid_cursor")
			return
		}
		var saved []byte
		var stored, expiry string
		e = tx.QueryRowContext(ctx, `SELECT scope_hash,resource_ids,expires_at FROM page_snapshots WHERE id=?`, p.ID).Scan(&saved, &stored, &expiry)
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 410, "cursor_expired")
			return
		}
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		expires, e := time.Parse(time.RFC3339Nano, expiry)
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		if !s.now().Before(expires) {
			fail(w, 410, "cursor_expired")
			return
		}
		if string(saved) != string(scope) || json.Unmarshal([]byte(stored), &ids) != nil || p.Position > len(ids) {
			fail(w, 400, "invalid_cursor")
			return
		}
	} else if g.Kind == "song" {
		ids = append(ids, g.SongID)
	} else {
		// ponytail: catalog scan within one snapshot; index readiness if scale requires it.
		rows, e := tx.QueryContext(ctx, `SELECT id FROM songs WHERE owner_id=? AND publication='published' AND deleted_at IS NULL ORDER BY updated_at DESC,id ASC`, g.OwnerID)
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		candidates := []string{}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				break
			}
			candidates = append(candidates, id)
		}
		rowErr := rows.Err()
		rows.Close()
		if e != nil || rowErr != nil {
			fail(w, 503, "unavailable")
			return
		}
		for _, id := range candidates {
			v, e := songs.LoadSnapshot(ctx, tx, id)
			if e != nil {
				fail(w, 503, "unavailable")
				return
			}
			if s.Access.CanReadSong(ctx, nil, g, songs.Resource(v)) {
				ids = append(ids, id)
			}
		}
		p.ID = users.ID()
		body, _ := json.Marshal(ids)
		_, err = tx.ExecContext(ctx, `DELETE FROM page_snapshots WHERE expires_at<=?`, s.now().UTC().Format(time.RFC3339Nano))
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO page_snapshots(id,scope_hash,resource_ids,expires_at) VALUES(?,?,?,?)`, p.ID, scope, string(body), s.now().Add(15*time.Minute).UTC().Format(time.RFC3339Nano))
		}
		if err != nil {
			fail(w, 503, "unavailable")
			return
		}
	}
	result := []map[string]any{}
	for p.Position < len(ids) && len(result) < limit {
		id := ids[p.Position]
		p.Position++
		v, e := songs.LoadSnapshot(ctx, tx, id)
		if errors.Is(e, sql.ErrNoRows) {
			continue
		}
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		if s.Access.CanReadSong(ctx, nil, g, songs.Resource(v)) {
			result = append(result, publicSong(v, raw))
		}
	}
	if g.Kind == "song" && len(result) != 1 {
		fail(w, 404, "not_found")
		return
	}
	var next *string
	if p.Position < len(ids) {
		body, _ := json.Marshal(p)
		nonce := make([]byte, s.key.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			fail(w, 503, "unavailable")
			return
		}
		c := base64.RawURLEncoding.EncodeToString(append(nonce, s.key.Seal(nil, nonce, body, scope)...))
		next = &c
	}
	if tx.Commit() != nil {
		fail(w, 503, "unavailable")
		return
	}
	reply(w, 200, map[string]any{"kind": g.Kind, "songs": result, "nextCursor": next})
}

func (s *Service) media(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	raw := r.PathValue("token")
	public := raw != ""
	var i *platform.Identity
	if !public {
		i = s.identity(w, r)
		if i == nil {
			return
		}
	}
	// Token, song, track and active asset are read from one consistent snapshot.
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer tx.Rollback()
	var g *platform.ShareGrant
	if public {
		g, err = grant(ctx, tx, raw)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 404, "not_found")
			return
		}
		if err != nil {
			fail(w, 503, "unavailable")
			return
		}
	}
	v, err := songs.LoadSnapshot(ctx, tx, r.PathValue("songId"))
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	// Session authorizer uses the DB pool: do not reenter it inside this tx.
	allowed := false
	if public {
		allowed = s.Access.CanReadSong(ctx, nil, g, songs.Resource(v))
	} else if songs.Live(ctx, tx, i, s.now()) {
		allowed = i.Role == "admin" || i.UserID == v.Owner || v.Publication == "published" && v.Ready
	}
	if !allowed {
		fail(w, 404, "not_found")
		return
	}
	var asset, state string
	var playback, peaks sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(a.id,''),COALESCE(a.state,''),a.playback_path,a.peaks_path FROM tracks t LEFT JOIN assets a ON a.id=t.active_asset_id AND a.track_id=t.id WHERE t.id=? AND t.song_id=? AND t.deleted_at IS NULL`, r.PathValue("trackId"), v.ID).Scan(&asset, &state, &playback, &peaks)
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	if state != "ready" || !playback.Valid || !peaks.Valid {
		if !public && (i.Role == "admin" || i.UserID == v.Owner) {
			fail(w, 409, "media_not_ready")
		} else {
			fail(w, 404, "not_found")
		}
		return
	}
	key := playback.String
	contentType := "audio/mp4"
	kind := "media"
	if strings.HasSuffix(r.URL.Path, "/peaks") {
		key = peaks.String
		contentType = "application/json"
		kind = "peaks"
	}
	// Never fall back to source_path or to http.FileServer. #7 provides Storage.
	if s.Storage == nil {
		fail(w, 503, "unavailable")
		return
	}
	file, err := s.Storage.Open(ctx, key)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	defer file.Close()
	if tx.Commit() != nil {
		fail(w, 503, "unavailable")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("ETag", `"`+asset+"-"+kind+`"`)
	// ServeContent supplies seek-based Range, conditional GET, length, and HEAD.
	http.ServeContent(mediaWriter{w}, r, "", time.Time{}, file)
}

// ServeContent clears Cache-Control on range errors; keep bearer responses uncached.
type mediaWriter struct{ http.ResponseWriter }

func (w mediaWriter) WriteHeader(status int) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.ResponseWriter.WriteHeader(status)
}
