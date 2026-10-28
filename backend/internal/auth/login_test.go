package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

func loginRequest(s *Service, email, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(string(body)))
	r.RemoteAddr = "192.0.2.4:1234"
	r.Header.Set("Origin", s.Origin)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux := http.NewServeMux()
	s.Register(mux)
	mux.ServeHTTP(w, r)
	return w
}

func TestLoginGlobalBudget(t *testing.T) {
	f := setup(t)
	now := time.Now()
	f.s.now = func() time.Time { return now }
	for i := 0; i < 19; i++ {
		expect(t, loginRequest(f.s, fmt.Sprintf("absent%d@example.test", i), sample), 401)
	}
	expect(t, loginRequest(f.s, "teacher@example.test", sample), 200)
	// Recreating the service must not reset the persistent budget.
	restarted, err := New(f.db, f.s.Origin, false)
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = func() time.Time { return now }
	restarted.verify = func(string, string) bool { t.Fatal("rate-limited request reached Argon2id"); return false }
	w := loginRequest(restarted, "teacher@example.test", sample)
	expect(t, w, 429)
	if w.Header().Get("Retry-After") != "60" || len(w.Result().Cookies()) != 0 {
		t.Fatal("invalid rate-limit response")
	}
	restarted.verify = users.Verify
	now = now.Add(time.Minute)
	expect(t, loginRequest(restarted, "teacher@example.test", sample), 200)
}

func TestLoginReleasesDatabaseAndRechecksAccount(t *testing.T) {
	for _, change := range []string{"none", "password change", "password reset", "block", "block and unblock", "role", "temporary flag", "delete", "cancel"} {
		t.Run(change, func(t *testing.T) {
			f := setup(t)
			newHash, err := users.Hash(replacement)
			if err != nil {
				t.Fatal(err)
			}
			entered, release := make(chan struct{}), make(chan struct{})
			// Run real Argon2id, then hold the verification boundary deterministically.
			f.s.verify = func(hash, password string) bool {
				valid := users.Verify(hash, password)
				close(entered)
				<-release
				return valid
			}
			done := make(chan *httptest.ResponseRecorder, 1)
			finished := make(chan struct{})
			var resume sync.Once
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go func() {
				r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"email":"teacher@example.test","password":"fictional password 123"}`)).WithContext(ctx)
				r.Header.Set("Origin", f.s.Origin)
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				f.s.login(w, r)
				done <- w
				close(finished)
			}()
			t.Cleanup(func() { resume.Do(func() { close(release) }); <-finished })
			select {
			case <-entered:
			case <-time.After(30 * time.Second):
				t.Fatal("verification did not start")
			}
			dbctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if err := f.db.PingContext(dbctx); err != nil {
				t.Fatalf("login holds database during verification: %v", err)
			}
			// Saturation must reject immediately, even with a different email.
			rejected := make(chan *httptest.ResponseRecorder, 24)
			for i := 0; i < 24; i++ {
				go func(i int) { rejected <- loginRequest(f.s, fmt.Sprintf("another%d@example.test", i), sample) }(i)
			}
			for i := 0; i < 24; i++ {
				expect(t, <-rejected, 429)
			}
			switch change {
			case "password change", "password reset":
				tx, e := f.db.BeginTx(dbctx, nil)
				if e != nil {
					t.Fatal(e)
				}
				defer tx.Rollback()
				if e = users.SetPassword(dbctx, tx, f.teacher.ID, newHash, change == "password reset"); e != nil {
					t.Fatal(e)
				}
				err = tx.Commit()
			case "block", "block and unblock":
				err = users.SetBlocked(dbctx, f.db, f.teacher.ID, true)
				if err == nil && change == "block and unblock" {
					err = users.SetBlocked(dbctx, f.db, f.teacher.ID, false)
				}
			case "role":
				_, err = f.db.ExecContext(dbctx, `UPDATE users SET role='admin' WHERE id=?`, f.teacher.ID)
			case "temporary flag":
				_, err = f.db.ExecContext(dbctx, `UPDATE users SET must_change_password=0 WHERE id=?`, f.teacher.ID)
			case "delete":
				_, err = f.db.ExecContext(dbctx, `DELETE FROM users WHERE id=?`, f.teacher.ID)
			case "cancel":
				cancel()
			}
			if err != nil {
				t.Fatal(err)
			}
			resume.Do(func() { close(release) })
			w := <-done
			<-finished
			status := 401
			if change == "none" {
				status = 200
			}
			if change == "cancel" {
				status = 503
			}
			expect(t, w, status)
			var sessions int
			if err = f.db.QueryRow(`SELECT count(*) FROM sessions`).Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if change == "none" {
				if sessions != 1 || len(w.Result().Cookies()) != 1 {
					t.Fatal("valid login did not create session")
				}
			} else if sessions != 0 || len(w.Result().Cookies()) != 0 {
				t.Fatal("stale credentials created session")
			}
			// All exits release the admission slot.
			f.s.verify = users.Verify
			expect(t, loginRequest(f.s, "missing@example.test", sample), 401)
		})
	}
}
