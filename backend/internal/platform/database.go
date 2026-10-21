package platform

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/Axepuff/choral-training-tool/backend/migrations"
	_ "modernc.org/sqlite"
)

// OpenDatabase uses one connection (one writer); pragmas apply on every reconnect.
func OpenDatabase(ctx context.Context, dir string) (*sql.DB, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	path, err := filepath.Abs(filepath.Join(dir, "choral.sqlite"))
	if err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: path}
	db, err := sql.Open("sqlite", u.String()+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err = db.PingContext(ctx); err == nil {
		err = Migrate(ctx, db)
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Migrate runs each immutable SQL file and its version record in one transaction.
// BEGIN IMMEDIATE serializes concurrent processes before reading the version.
func Migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		return err
	}
	entries, err := migrations.Files.ReadDir(".")
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			known[e.Name()] = true
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT name FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		if !known[name] {
			rows.Close()
			return fmt.Errorf("unknown migration: %s", name)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !known[e.Name()] {
			continue
		}
		body, err := migrations.Files.ReadFile(e.Name())
		if err != nil {
			return err
		}
		if err := applyMigration(ctx, db, e.Name(), body); err != nil {
			return err
		}
	}
	return nil
}
func applyMigration(ctx context.Context, db *sql.DB, name string, body []byte) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")
	sum := fmt.Sprintf("%x", sha256.Sum256(body))
	var saved string
	err = conn.QueryRowContext(ctx, "SELECT checksum FROM schema_migrations WHERE name=?", name).Scan(&saved)
	if err == nil {
		if saved != sum {
			return fmt.Errorf("migration changed: %s", name)
		}
	} else {
		if err != sql.ErrNoRows {
			return err
		}
		if _, err = conn.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err = conn.ExecContext(ctx, "INSERT INTO schema_migrations(name,checksum) VALUES (?,?)", name, sum); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
