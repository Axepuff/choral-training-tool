package platform

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Exercises the exact container backup/restore entrypoint on real SQLite/FS.
func TestBackupCleanRestore(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("requires sqlite3 CLI (included in container)")
	}
	source := t.TempDir()
	target := t.TempDir()
	db, err := OpenDatabase(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO users VALUES ('control','control@example.test','fictional-hash','teacher',NULL,1,'now','now')`)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(filepath.Join(source, "files"), 0700); err != nil {
		t.Fatal(err)
	}
	payload := []byte("synthetic control file\x00\x01")
	if err = os.WriteFile(filepath.Join(source, "files", "control"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	// Synthetic key material only; proves non-DB state survives the same snapshot.
	if err = os.WriteFile(filepath.Join(source, "control.key"), []byte("fictional-key"), 0600); err != nil {
		t.Fatal(err)
	}
	run := func(dir, operation string, input []byte) ([]byte, error) {
		cmd := exec.Command("sh", "../../../scripts/container-data.sh", operation)
		cmd.Env = append(os.Environ(), "CHORAL_DATA_DIR="+dir)
		cmd.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Log(stderr.String())
		}
		return out, err
	}
	archive, err := run(source, "backup", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = run(target, "restore", archive); err != nil {
		t.Fatal(err)
	}
	restored, err := OpenDatabase(context.Background(), target)
	if err != nil {
		t.Fatal(err)
	}
	var email string
	err = restored.QueryRow(`SELECT email_normalized FROM users WHERE id='control'`).Scan(&email)
	if err != nil || email != "control@example.test" {
		t.Fatalf("control record: %q %v", email, err)
	}
	restored.Close()
	for name, want := range map[string][]byte{"files/control": payload, "control.key": []byte("fictional-key")} {
		got, err := os.ReadFile(filepath.Join(target, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("restored %s differs: %v", name, err)
		}
	}
	if _, err = run(target, "restore", archive); err == nil {
		t.Fatal("overwriting populated volume accepted")
	}
	if _, err = run(t.TempDir(), "restore", []byte("corrupt archive")); err == nil {
		t.Fatal("corrupt archive accepted")
	}
	if err = os.WriteFile(filepath.Join(source, "choral.sqlite"), []byte("corrupt db"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = run(source, "backup", nil); err == nil {
		t.Fatal("corrupt database archived")
	}
}
