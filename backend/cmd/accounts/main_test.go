package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

func TestOperatorCommands(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CHORAL_DATA_DIR", filepath.Join(dir, "data"))
	passwordPath := filepath.Join(dir, "password")
	const secret = "fictional operator password"
	if err := os.WriteFile(passwordPath, []byte(secret+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	call := func(args []string, want int) {
		t.Helper()
		f, e := os.Open(passwordPath)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		var out bytes.Buffer
		if code := run(args, f, &out); code != want {
			t.Fatalf("exit %d want %d: %s", code, want, out.String())
		}
		if strings.Contains(out.String(), secret) {
			t.Fatal("password output")
		}
	}
	call([]string{"bootstrap", "admin@example.test"}, 0)
	call([]string{"bootstrap", "admin@example.test"}, 1)
	call([]string{"create-teacher", "teacher@example.test"}, 0)
	call([]string{"reset-admin"}, 0)
	call([]string{"bootstrap", "admin@example.test", "argv-password"}, 1)
	db, e := platform.OpenDatabase(context.Background(), filepath.Join(dir, "data"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var hash string
	if e = db.QueryRow(`SELECT password_hash FROM users WHERE email_normalized='teacher@example.test'`).Scan(&hash); e != nil || !users.Verify(hash, secret) {
		t.Fatal("teacher not persisted")
	}
	if e = os.Chmod(passwordPath, 0644); e != nil {
		t.Fatal(e)
	}
	call([]string{"reset-admin"}, 1)
}
