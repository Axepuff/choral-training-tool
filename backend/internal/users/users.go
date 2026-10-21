// Package users owns account credentials and transactional session revocation.
package users

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

var ErrInvalid = errors.New("invalid account data")
var ErrConflict = errors.New("account operation conflicts with current state")

type User struct {
	ID                 string `json:"id"`
	Email              string `json:"email"`
	Role               string `json:"role"`
	Blocked            bool   `json:"blocked"`
	MustChangePassword bool   `json:"mustChangePassword"`
}

func ID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func NormalizeEmail(s string) (string, error) {
	if !utf8.ValidString(s) {
		return "", ErrInvalid
	}
	s = strings.ToLower(norm.NFC.String(strings.TrimSpace(s)))
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || len(s) > 254 || !strings.Contains(s, "@") {
		return "", ErrInvalid
	}
	return s, nil
}
func ValidPassword(s string) bool {
	n := utf8.RuneCountInString(s)
	return utf8.ValidString(s) && n >= 12 && n <= 128
}
func Hash(password string) (string, error) {
	if !ValidPassword(password) {
		return "", ErrInvalid
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)
	return "$argon2id$v=19$m=65536,t=3,p=1$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}
func Verify(hash, password string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || strings.Join(parts[:4], "$") != "$argon2id$v=19$m=65536,t=3,p=1" {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[4])
	key, e2 := base64.RawStdEncoding.DecodeString(parts[5])
	if e != nil || e2 != nil || len(salt) != 16 || len(key) != 32 || len(password) > 512 {
		return false
	}
	return subtle.ConstantTimeCompare(key, argon2.IDKey([]byte(password), salt, 3, 64*1024, 1, 32)) == 1
}

// Create is operator-only. Bootstrap atomically refuses any nonempty user table.
func Create(ctx context.Context, db *sql.DB, email, password, role string, bootstrap bool) (User, error) {
	var u User
	email, err := NormalizeEmail(email)
	if err != nil || (role != "admin" && role != "teacher") || (bootstrap && role != "admin") {
		return u, ErrInvalid
	}
	hash, err := Hash(password)
	if err != nil {
		return u, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return u, err
	}
	defer tx.Rollback()
	u = User{ID: ID(), Email: email, Role: role, MustChangePassword: true}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	query := `INSERT INTO users(id,email_normalized,password_hash,role,created_at,updated_at) SELECT ?,?,?,?,?,? WHERE `
	if bootstrap {
		query += `NOT EXISTS(SELECT 1 FROM users)`
	} else {
		query += `EXISTS(SELECT 1 FROM users WHERE role='admin' AND blocked_at IS NULL)`
	}
	result, err := tx.ExecContext(ctx, query, u.ID, email, hash, role, now, now)
	if err != nil {
		return User{}, ErrConflict
	}
	n, err := result.RowsAffected()
	if err != nil {
		return User{}, err
	}
	if n != 1 {
		return User{}, ErrConflict
	}
	return u, tx.Commit()
}

// SetPassword must run in the same transaction as the caller's authorization.
func SetPassword(ctx context.Context, tx *sql.Tx, id, hash string, temporary bool) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := tx.ExecContext(ctx, `UPDATE users SET password_hash=?,must_change_password=?,updated_at=? WHERE id=?`, hash, temporary, now, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrInvalid
	}
	_, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=?,updated_at=? WHERE user_id=? AND revoked_at IS NULL`, now, now, id)
	return err
}

// ResetAdmin is a local recovery operation, permitted only for a sole admin.
func ResetAdmin(ctx context.Context, db *sql.DB, password string) error {
	hash, err := Hash(password)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(ctx, `SELECT id FROM users WHERE role='admin' AND (SELECT count(*) FROM users WHERE role='admin')=1`).Scan(&id)
	if err != nil {
		return ErrConflict
	}
	if err = SetPassword(ctx, tx, id, hash, true); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE users SET blocked_at=NULL WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// SetBlocked is the transactional primitive for the later account-management API.
// Authorization belongs to the caller (or a local operator), never to UI roles.
func SetBlocked(ctx context.Context, db *sql.DB, id string, blocked bool) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var role string
	var already bool
	if err = tx.QueryRowContext(ctx, `SELECT role,blocked_at IS NOT NULL FROM users WHERE id=?`, id).Scan(&role, &already); err != nil {
		return err
	}
	if blocked && !already && role == "admin" {
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE role='admin' AND blocked_at IS NULL`).Scan(&count); err != nil {
			return err
		}
		if count <= 1 {
			return ErrConflict
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var at any
	if blocked {
		at = now
	}
	if _, err = tx.ExecContext(ctx, `UPDATE users SET blocked_at=?,updated_at=? WHERE id=?`, at, now, id); err != nil {
		return err
	}
	if blocked {
		if _, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=?,updated_at=? WHERE user_id=? AND revoked_at IS NULL`, now, now, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}
