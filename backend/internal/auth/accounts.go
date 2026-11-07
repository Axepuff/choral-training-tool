package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type accountCursor struct {
	ID       string
	Position int
}

// Account selection only. Account creation/blocking remains the separate #13 task.
func (s *Service) accounts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 30
	for key, values := range q {
		if (key != "cursor" && key != "limit") || len(values) != 1 {
			fail(w, 422, "validation_error", "Проверьте параметры списка")
			return
		}
	}
	if value, ok := q["limit"]; ok {
		var err error
		limit, err = strconv.Atoi(value[0])
		if err != nil || limit < 1 || limit > 100 {
			fail(w, 422, "validation_error", "Проверьте размер страницы")
			return
		}
	}
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		fail(w, 503, "unavailable", "Список аккаунтов недоступен")
		return
	}
	defer tx.Rollback()
	a, err := s.session(ctx, tx, r)
	if err != nil {
		s.sessionError(w, err)
		return
	}
	if a.User.MustChangePassword {
		fail(w, 403, "password_change_required", "Смените временный пароль")
		return
	}
	if a.User.Role != "admin" {
		fail(w, 403, "forbidden", "Недостаточно прав")
		return
	}
	w.Header().Set("Vary", "Cookie")
	aad := []byte("admin-users-cursor-v1:" + a.User.ID)
	scope := digest(string(aad))
	ids := []string{}
	cur := accountCursor{ID: users.ID()}
	if c := q.Get("cursor"); c != "" {
		raw, e := base64.RawURLEncoding.DecodeString(c)
		n := s.accountKey.NonceSize()
		if e != nil || len(raw) <= n || base64.RawURLEncoding.EncodeToString(raw) != c {
			fail(w, 400, "invalid_cursor", "Неверная страница списка")
			return
		}
		plain, e := s.accountKey.Open(nil, raw[:n], raw[n:], aad)
		if e != nil || json.Unmarshal(plain, &cur) != nil || cur.Position < 0 {
			fail(w, 400, "invalid_cursor", "Неверная страница списка")
			return
		}
		var saved []byte
		var body, expires string
		err = tx.QueryRowContext(ctx, `SELECT scope_hash,resource_ids,expires_at FROM page_snapshots WHERE id=?`, cur.ID).Scan(&saved, &body, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			fail(w, 410, "cursor_expired", "Откройте список заново")
			return
		}
		if err != nil {
			fail(w, 503, "unavailable", "Список аккаунтов недоступен")
			return
		}
		if subtle.ConstantTimeCompare(saved, scope) != 1 {
			fail(w, 400, "invalid_cursor", "Неверная страница списка")
			return
		}
		expiry, e := time.Parse(time.RFC3339Nano, expires)
		if e != nil || json.Unmarshal([]byte(body), &ids) != nil {
			fail(w, 503, "unavailable", "Список аккаунтов недоступен")
			return
		}
		if !s.now().Before(expiry) {
			fail(w, 410, "cursor_expired", "Откройте список заново")
			return
		}
		if cur.Position > len(ids) {
			fail(w, 400, "invalid_cursor", "Неверная страница списка")
			return
		}
	} else {
		rows, e := tx.QueryContext(ctx, `SELECT id FROM users ORDER BY email_normalized,id`)
		if e != nil {
			fail(w, 503, "unavailable", "Список аккаунтов недоступен")
			return
		}
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				break
			}
			ids = append(ids, id)
		}
		rowErr := rows.Err()
		rows.Close()
		if e != nil || rowErr != nil {
			fail(w, 503, "unavailable", "Список аккаунтов недоступен")
			return
		}
		if len(ids) > limit {
			body, _ := json.Marshal(ids)
			_, e = tx.ExecContext(ctx, `DELETE FROM page_snapshots WHERE expires_at<=?`, s.now().UTC().Format(time.RFC3339Nano))
			if e == nil {
				_, e = tx.ExecContext(ctx, `INSERT INTO page_snapshots(id,scope_hash,resource_ids,expires_at) VALUES(?,?,?,?)`, cur.ID, scope, string(body), s.now().Add(15*time.Minute).UTC().Format(time.RFC3339Nano))
			}
			if e != nil {
				fail(w, 503, "unavailable", "Список аккаунтов недоступен")
				return
			}
		}
	}
	items := []users.User{}
	for cur.Position < len(ids) && len(items) < limit {
		var u users.User
		err = tx.QueryRowContext(ctx, `SELECT id,email_normalized,role,blocked_at IS NOT NULL,must_change_password FROM users WHERE id=?`, ids[cur.Position]).Scan(&u.ID, &u.Email, &u.Role, &u.Blocked, &u.MustChangePassword)
		cur.Position++
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			fail(w, 503, "unavailable", "Список аккаунтов недоступен")
			return
		}
		items = append(items, u)
	}
	var next *string
	if cur.Position < len(ids) {
		plain, _ := json.Marshal(cur)
		nonce := make([]byte, s.accountKey.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			fail(w, 503, "unavailable", "Список аккаунтов недоступен")
			return
		}
		c := base64.RawURLEncoding.EncodeToString(append(nonce, s.accountKey.Seal(nil, nonce, plain, aad)...))
		next = &c
	}
	if tx.Commit() != nil {
		fail(w, 503, "unavailable", "Список аккаунтов недоступен")
		return
	}
	reply(w, 200, struct {
		Items []users.User `json:"items"`
		Next  *string      `json:"nextCursor"`
	}{items, next})
}
