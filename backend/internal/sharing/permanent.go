package sharing

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type permanentCurrent struct {
	Share   share   `json:"share"`
	Version int     `json:"version"`
	URL     *string `json:"url"`
}
type permanentState struct {
	Current *permanentCurrent `json:"current"`
	Legacy  []share           `json:"legacy"`
}
type permanentInput struct {
	Kind         string `json:"kind"`
	Owner        string `json:"ownerId,omitempty"`
	Song         string `json:"songId,omitempty"`
	AcceptLegacy bool   `json:"acceptLegacy,omitempty"`
}

func tokenAAD(v share) []byte {
	song := ""
	if v.Song != nil {
		song = *v.Song
	}
	return []byte("permanent-share-v1:" + v.ID + ":" + v.Kind + ":" + v.Owner + ":" + song)
}
func (s *Service) encryptToken(v share, raw string) ([]byte, []byte, error) {
	nonce := make([]byte, s.key.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return s.key.Seal(nil, nonce, []byte(raw), tokenAAD(v)), nonce, nil
}
func shareURL(v share, raw string) string {
	if v.Kind == "song" {
		return "/?song=" + raw
	}
	return "/?list=" + raw
}

func (s *Service) permanentState(ctx context.Context, tx *sql.Tx, in permanentInput) (permanentState, error) {
	state := permanentState{Legacy: []share{}}
	rows, err := tx.QueryContext(ctx, `SELECT id,kind,owner_id,song_id,disabled_at,created_at,permanent,version,token_ciphertext,token_nonce,token_hash FROM shares WHERE owner_id=? AND kind=? AND (song_id=? OR (song_id IS NULL AND ?='')) ORDER BY created_at,id`, in.Owner, in.Kind, in.Song, in.Song)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var v share
		var permanent bool
		var version int
		var ciphertext, nonce, storedHash []byte
		if err = rows.Scan(&v.ID, &v.Kind, &v.Owner, &v.Song, &v.Disabled, &v.Created, &permanent, &version, &ciphertext, &nonce, &storedHash); err != nil {
			return state, err
		}
		if !permanent {
			state.Legacy = append(state.Legacy, v)
			continue
		}
		current := &permanentCurrent{Share: v, Version: version}
		if v.Disabled == nil {
			if len(nonce) != s.key.NonceSize() {
				return state, errors.New("invalid permanent token")
			}
			raw, e := s.key.Open(nil, nonce, ciphertext, tokenAAD(v))
			if e != nil || !bytes.Equal(hash(string(raw)), storedHash) {
				return state, errors.New("invalid permanent token")
			}
			url := shareURL(v, string(raw))
			current.URL = &url
		}
		state.Current = current
	}
	return state, rows.Err()
}

func (s *Service) permanent(w http.ResponseWriter, r *http.Request) {
	i := s.identity(w, r)
	if i == nil {
		return
	}
	in := permanentInput{}
	if r.Method == "GET" {
		q := r.URL.Query()
		for key, values := range q {
			if (key != "kind" && key != "ownerId" && key != "songId") || len(values) != 1 {
				fail(w, 422, "validation_error")
				return
			}
		}
		in.Kind, in.Owner, in.Song = q.Get("kind"), q.Get("ownerId"), q.Get("songId")
	} else {
		mt, _, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if e != nil || mt != "application/json" {
			fail(w, 422, "validation_error")
			return
		}
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
		d.DisallowUnknownFields()
		if e = d.Decode(&in); e != nil {
			var size *http.MaxBytesError
			if errors.As(e, &size) {
				fail(w, 413, "payload_too_large")
			} else {
				fail(w, 422, "validation_error")
			}
			return
		}
		if e = d.Decode(new(any)); e != io.EOF {
			var size *http.MaxBytesError
			if errors.As(e, &size) {
				fail(w, 413, "payload_too_large")
			} else {
				fail(w, 422, "validation_error")
			}
			return
		}
	}
	if in.Kind == "song" && (!uuid.MatchString(in.Song) || in.Owner != "") || in.Kind == "list" && (!uuid.MatchString(in.Owner) || in.Song != "") || in.Kind != "song" && in.Kind != "list" {
		fail(w, 422, "validation_error")
		return
	}
	ctx := r.Context()
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
	if in.Kind == "list" && i.Role != "admin" && i.UserID != in.Owner {
		fail(w, 403, "forbidden")
		return
	}
	if in.Kind == "song" {
		err = tx.QueryRowContext(ctx, `SELECT owner_id FROM songs WHERE id=? AND deleted_at IS NULL`, in.Song).Scan(&in.Owner)
	} else {
		var owner string
		err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE id=?`, in.Owner).Scan(&owner)
	}
	if errors.Is(err, sql.ErrNoRows) {
		fail(w, 404, "not_found")
		return
	}
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	if i.Role != "admin" && i.UserID != in.Owner {
		fail(w, 404, "not_found")
		return
	}
	state, err := s.permanentState(ctx, tx, in)
	if err != nil {
		fail(w, 503, "unavailable")
		return
	}
	status := 200
	if r.Method == "POST" {
		if state.Current != nil && state.Current.Share.Disabled != nil {
			fail(w, 409, "share_disabled")
			return
		}
		if state.Current == nil {
			activeLegacy := false
			for _, previous := range state.Legacy {
				if previous.Disabled == nil {
					activeLegacy = true
				}
			}
			if activeLegacy && !in.AcceptLegacy {
				fail(w, 409, "legacy_transition_required")
				return
			}
			v := share{ID: users.ID(), Kind: in.Kind, Owner: in.Owner, Created: s.now().UTC().Format(time.RFC3339Nano)}
			if in.Kind == "song" {
				v.Song = &in.Song
			}
			raw, e := token()
			if e != nil {
				fail(w, 503, "unavailable")
				return
			}
			ciphertext, nonce, e := s.encryptToken(v, raw)
			if e != nil {
				fail(w, 503, "unavailable")
				return
			}
			_, e = tx.ExecContext(ctx, `INSERT INTO shares(id,kind,owner_id,song_id,token_hash,created_at,updated_at,permanent,version,token_ciphertext,token_nonce) VALUES(?,?,?,?,?,?,?,1,1,?,?)`, v.ID, v.Kind, v.Owner, v.Song, hash(raw), v.Created, v.Created, ciphertext, nonce)
			if e != nil {
				fail(w, 503, "unavailable")
				return
			}
			url := shareURL(v, raw)
			state.Current = &permanentCurrent{Share: v, Version: 1, URL: &url}
			status = 201
		}
	}
	if tx.Commit() != nil {
		fail(w, 503, "unavailable")
		return
	}
	reply(w, status, state)
}

// Guard canonical mutations even when an older API client uses the old route.
func permanentVersion(w http.ResponseWriter, r *http.Request, tx *sql.Tx, id string) (bool, bool) {
	var permanent bool
	var version int
	if err := tx.QueryRowContext(r.Context(), `SELECT permanent,version FROM shares WHERE id=?`, id).Scan(&permanent, &version); err != nil {
		fail(w, 503, "unavailable")
		return false, false
	}
	if permanent {
		if r.Header.Get("If-Match") == "" {
			fail(w, 428, "precondition_required")
			return false, false
		}
		if r.Header.Get("If-Match") != `"`+strconv.Itoa(version)+`"` {
			fail(w, 412, "precondition_failed")
			return false, false
		}
	}
	return permanent, true
}
