package users

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
)

func TestBootstrapRecoveryAndHashing(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := platform.OpenDatabase(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const password = "fictional initial password"
	if _, err = Create(ctx, db, "teacher@example.test", password, "teacher", false); err != ErrConflict {
		t.Fatal("teacher before bootstrap")
	}
	// Competing operator invocations cannot create two initial administrators.
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, e := Create(ctx, db, "Admin@Example.test", password, "admin", true)
			results <- e
		}()
	}
	wg.Wait()
	close(results)
	successes := 0
	for e := range results {
		if e == nil {
			successes++
		} else if e != ErrConflict {
			t.Fatal(e)
		}
	}
	if successes != 1 {
		t.Fatal("bootstrap not atomic")
	}
	var id, hash string
	if err = db.QueryRow(`SELECT id,password_hash FROM users`).Scan(&id, &hash); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=1$") || !Verify(hash, password) || Verify(hash, "different password") {
		t.Fatal("Argon2id verification")
	}
	second, e := Hash(password)
	if e != nil || second == hash {
		t.Fatal("salt reused")
	}
	before := hash
	if _, e = Create(ctx, db, "other@example.test", "different fictional password", "admin", true); e != ErrConflict {
		t.Fatal("repeat bootstrap accepted")
	}
	if err = db.QueryRow(`SELECT password_hash FROM users WHERE id=?`, id).Scan(&hash); err != nil || hash != before {
		t.Fatal("repeat bootstrap modified credentials")
	}
	_, err = db.Exec(`INSERT INTO sessions VALUES ('s',?,x'01',x'02','2099-01-01T00:00:00Z',NULL,'now','now')`, id)
	if err != nil {
		t.Fatal(err)
	}
	if err = ResetAdmin(ctx, db, "new fictional recovery password"); err != nil {
		t.Fatal(err)
	}
	var revoked bool
	var change bool
	if err = db.QueryRow(`SELECT s.revoked_at IS NOT NULL,u.must_change_password,u.password_hash FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.id='s'`).Scan(&revoked, &change, &hash); err != nil || !revoked || !change || !Verify(hash, "new fictional recovery password") {
		t.Fatal("recovery did not revoke/change")
	}
	if _, err = Create(ctx, db, "second@example.test", password, "admin", false); err != nil {
		t.Fatal(err)
	}
	if err = ResetAdmin(ctx, db, password); err != ErrConflict {
		t.Fatal("recovery accepted multiple administrators")
	}
	if _, err = Create(ctx, db, " ADMIN@example.test ", password, "teacher", false); err != ErrConflict {
		t.Fatal("duplicate normalized email")
	}
}
func TestCredentialValidation(t *testing.T) {
	for _, s := range []string{"display <a@example.test>", "a@example.test\nBcc: other@example.test", strings.Repeat("a", 255) + "@x.test", "\xff@example.test"} {
		if _, e := NormalizeEmail(s); e == nil {
			t.Fatal("invalid email")
		}
	}
	a, e := NormalizeEmail(" E\u0301@EXAMPLE.TEST ")
	if e != nil || a != "é@example.test" {
		t.Fatal("email normalization")
	}
	for _, p := range []string{"short", strings.Repeat("x", 129), "\xfffictional password"} {
		if _, e := Hash(p); e == nil {
			t.Fatal("invalid password")
		}
	}
	p := strings.Repeat("🎵", 128)
	h, e := Hash(p)
	if e != nil || !Verify(h, p) {
		t.Fatal("Unicode scalar length")
	}
	spaced := "  fictional password  "
	h, e = Hash(spaced)
	if e != nil || Verify(h, strings.TrimSpace(spaced)) || !Verify(h, spaced) {
		t.Fatal("password whitespace changed")
	}
	for _, h := range []string{"bad", "$argon2id$v=19$m=99999999,t=3,p=1$aaaa$bbbb"} {
		if Verify(h, "fictional password") {
			t.Fatal("malformed hash accepted")
		}
	}
}
