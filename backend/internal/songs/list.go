package songs

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Axepuff/choral-training-tool/backend/internal/users"
	"golang.org/x/text/unicode/norm"
)

type snapshot struct {
	IDs []string
}

func sign(key []byte, payload string) string {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func cursor(id string, pos int, key, scope []byte) string {
	p := id + ":" + strconv.Itoa(pos)
	return base64.RawURLEncoding.EncodeToString([]byte(p + ":" + sign(key, p+":"+string(scope))))
}
func (s *Service) list(w http.ResponseWriter, r *http.Request) {
	i := s.identity(w, r)
	if i == nil {
		return
	}
	ctx := r.Context()
	q := r.URL.Query()
	limit := 30
	var err error
	if v, ok := q["limit"]; ok {
		if len(v) != 1 {
			fail(w, 422, "validation_error")
			return
		}
		limit, err = strconv.Atoi(v[0])
		if err != nil || limit < 1 || limit > 100 {
			fail(w, 422, "validation_error")
			return
		}
	}
	if !utf8.ValidString(q.Get("q")) {
		fail(w, 422, "validation_error")
		return
	}
	search := strings.ToLower(norm.NFC.String(strings.TrimSpace(q.Get("q"))))
	order := q.Get("sort")
	if order == "" {
		order = "updated_desc"
	}
	switch order {
	case "updated_desc", "title_asc", "title_desc", "bpm_asc", "bpm_desc":
	default:
		fail(w, 422, "validation_error")
		return
	}
	if utf8.RuneCountInString(search) > 160 {
		fail(w, 422, "validation_error")
		return
	}
	scopeBytes, _ := json.Marshal([]string{"/api/v1/songs", i.UserID, i.Role, search, order})
	scope := sha256.Sum256(scopeBytes)
	var snap snapshot
	var id string
	pos := 0
	if c := q.Get("cursor"); c != "" {
		raw, e := base64.RawURLEncoding.DecodeString(c)
		parts := strings.Split(string(raw), ":")
		if e != nil || len(parts) != 3 || !uuid.MatchString(parts[0]) {
			fail(w, 400, "invalid_cursor")
			return
		}
		id = parts[0]
		pos, e = strconv.Atoi(parts[1])
		if e != nil || pos < 0 {
			fail(w, 400, "invalid_cursor")
			return
		}
		if !hmac.Equal([]byte(parts[2]), []byte(sign(s.cursorKey, parts[0]+":"+parts[1]+":"+string(scope[:])))) {
			fail(w, 400, "invalid_cursor")
			return
		}
		var saved []byte
		var body, expiry string
		e = s.DB.QueryRowContext(ctx, `SELECT scope_hash,resource_ids,expires_at FROM page_snapshots WHERE id=?`, id).Scan(&saved, &body, &expiry)
		if errors.Is(e, sql.ErrNoRows) {
			fail(w, 410, "cursor_expired")
			return
		}
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		if string(saved) != string(scope[:]) || json.Unmarshal([]byte(body), &snap) != nil || pos > len(snap.IDs) {
			fail(w, 400, "invalid_cursor")
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
	} else {
		// ponytail: scan the catalog for MVP; use indexed normalized search when scale requires it.
		// Freeze membership/order from one SQLite read snapshot. Current access is
		// checked again below for every returned item and every continuation.
		tx, e := s.DB.BeginTx(ctx, nil)
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		defer tx.Rollback()
		rows, e := tx.QueryContext(ctx, `SELECT id FROM songs WHERE deleted_at IS NULL ORDER BY updated_at DESC,id ASC`)
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		ids := []string{}
		for rows.Next() {
			var v string
			if e = rows.Scan(&v); e != nil {
				break
			}
			ids = append(ids, v)
		}
		rowErr := rows.Err()
		rows.Close()
		if e != nil || rowErr != nil {
			fail(w, 503, "unavailable")
			return
		}
		selected := []Song{}
		for _, v := range ids {
			song, e := load(ctx, tx, v)
			if e != nil {
				fail(w, 503, "unavailable")
				return
			}
			if (i.Role == "admin" || song.Owner == i.UserID || song.Publication == "published" && song.Ready) && strings.Contains(strings.ToLower(song.Title), search) {
				selected = append(selected, song)
			}
		}
		sort.SliceStable(selected, func(a, b int) bool {
			x, y := selected[a], selected[b]
			switch order {
			case "title_asc":
				if strings.ToLower(x.Title) != strings.ToLower(y.Title) {
					return strings.ToLower(x.Title) < strings.ToLower(y.Title)
				}
			case "title_desc":
				if strings.ToLower(x.Title) != strings.ToLower(y.Title) {
					return strings.ToLower(x.Title) > strings.ToLower(y.Title)
				}
			case "bpm_asc":
				if x.BPM != y.BPM {
					return x.BPM < y.BPM
				}
			case "bpm_desc":
				if x.BPM != y.BPM {
					return x.BPM > y.BPM
				}
			default:
				xt, _ := time.Parse(time.RFC3339Nano, x.Updated)
				yt, _ := time.Parse(time.RFC3339Nano, y.Updated)
				if !xt.Equal(yt) {
					return xt.After(yt)
				}
			}
			return x.ID < y.ID
		})
		snap.IDs = []string{}
		for _, v := range selected {
			snap.IDs = append(snap.IDs, v.ID)
		}
		id = users.ID()
		body, _ := json.Marshal(snap)
		// The durable server key verifies expired cursors even after snapshot cleanup.
		if _, e = tx.ExecContext(ctx, `DELETE FROM page_snapshots WHERE expires_at<?`, s.now().UTC().Format(time.RFC3339Nano)); e == nil {
			_, e = tx.ExecContext(ctx, `INSERT INTO page_snapshots(id,scope_hash,resource_ids,expires_at) VALUES(?,?,?,?)`, id, scope[:], string(body), s.now().Add(15*time.Minute).UTC().Format(time.RFC3339Nano))
		}
		if e != nil || tx.Commit() != nil {
			fail(w, 503, "unavailable")
			return
		}
	}
	items := []Song{}
	for pos < len(snap.IDs) && len(items) < limit {
		v, e := s.load(ctx, snap.IDs[pos])
		pos++
		if errors.Is(e, sql.ErrNoRows) {
			continue
		}
		if e != nil {
			fail(w, 503, "unavailable")
			return
		}
		if s.readable(ctx, i, v) {
			items = append(items, s.present(ctx, i, v))
		}
	}
	var next *string
	if pos < len(snap.IDs) {
		c := cursor(id, pos, s.cursorKey, scope[:])
		next = &c
	}
	reply(w, 200, struct {
		Items []Song  `json:"items"`
		Next  *string `json:"nextCursor"`
	}{items, next})
}
