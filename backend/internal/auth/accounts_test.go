package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type accountPageResponse struct {
	Items []users.User `json:"items"`
	Next  *string      `json:"nextCursor"`
}

func accountPage(t *testing.T, f *fixture, path string, cookie *http.Cookie) accountPageResponse {
	t.Helper()
	w := f.request("GET", path, "", cookie, "", "")
	expect(t, w, 200)
	var page accountPageResponse
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
		t.Fatal("invalid account page")
	}
	// This endpoint must keep the public User allowlist even if internal account data grows.
	var fields struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, item := range fields.Items {
		if len(item) != 5 {
			t.Fatal("account selection exposed extra fields")
		}
		for _, field := range []string{"id", "email", "role", "blocked", "mustChangePassword"} {
			if _, exists := item[field]; !exists {
				t.Fatalf("account selection omitted %s", field)
			}
		}
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Vary") != "Cookie" {
		t.Fatal("private account list may be shared by a cache")
	}
	return page
}

// Protects this new read boundary, including its own cursor scope and durable snapshot contract.
func TestAccountSelectionPermissionsSnapshotAndRestart(t *testing.T) {
	f := setup(t)
	expect(t, f.request("GET", "/api/v1/admin/users", "", nil, "", ""), 401)
	temporary, _ := f.login(f.admin.Email, sample, nil)
	expect(t, f.request("GET", "/api/v1/admin/users", "", temporary, "", ""), 403)
	admin, _ := f.unrestricted(f.admin.Email)
	teacher, _ := f.unrestricted(f.teacher.Email)
	expect(t, f.request("GET", "/api/v1/admin/users", "", teacher, "", ""), 403)
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=1&limit=2", "?ownerId=ignored"} {
		expect(t, f.request("GET", "/api/v1/admin/users"+query, "", admin, "", ""), 422)
	}
	first := accountPage(t, f, "/api/v1/admin/users?limit=1", admin)
	if len(first.Items) != 1 || first.Items[0].ID != f.admin.ID || first.Next == nil {
		t.Fatal("first page is not ordered by email with a continuation")
	}
	cursor := *first.Next
	path := "/api/v1/admin/users?cursor=" + url.QueryEscape(cursor) + "&limit=1"
	otherAdmin, err := users.Create(context.Background(), f.db, "aaa-new@example.test", sample, "admin", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec("UPDATE users SET must_change_password=0 WHERE id=?", otherAdmin.ID); err != nil {
		t.Fatal(err)
	}
	otherCookie, _ := f.login(otherAdmin.Email, sample, nil)
	expect(t, f.request("GET", path, "", otherCookie, "", ""), 400)
	renamed := "000-renamed@example.test"
	if _, err = f.db.Exec("UPDATE users SET email_normalized=?,blocked_at='now' WHERE id=?", renamed, f.teacher.ID); err != nil {
		t.Fatal(err)
	}
	checkRemaining := func() {
		t.Helper()
		page := accountPage(t, f, path, admin)
		if len(page.Items) != 1 || page.Items[0].ID != f.teacher.ID || page.Items[0].Email != renamed || !page.Items[0].Blocked || page.Next != nil {
			t.Fatal("snapshot membership/order changed or account fields went stale")
		}
	}
	checkRemaining()
	// Reopen SQLite and the actual auth service: cursor encryption must survive a restart.
	f.db.Close()
	f.db, err = platform.OpenDatabase(context.Background(), f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.s, err = New(f.db, "https://choir.example.test", false, f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.handler = platform.NewService(platform.Config{}, f.db, slog.New(slog.NewJSONHandler(&f.logs, nil)), f.s.Register).Server.Handler
	checkRemaining()
	// A changed authenticated ciphertext must stay 400 even after old snapshots are cleaned up.
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		t.Fatal("invalid returned cursor encoding")
	}
	raw[len(raw)-1] ^= 1
	forged := "/api/v1/admin/users?cursor=" + base64.RawURLEncoding.EncodeToString(raw)
	expect(t, f.request("GET", forged, "", admin, "", ""), 400)
	later := time.Now().Add(16 * time.Minute)
	f.s.now = func() time.Time { return later }
	accountPage(t, f, "/api/v1/admin/users?limit=1", admin)
	expect(t, f.request("GET", path, "", admin, "", ""), 410)
	expect(t, f.request("GET", forged, "", admin, "", ""), 400)
	expect(t, f.request("GET", path, "", otherCookie, "", ""), 400)
	if _, err = f.db.Exec("UPDATE users SET role='teacher' WHERE id=?", otherAdmin.ID); err != nil {
		t.Fatal(err)
	}
	expect(t, f.request("GET", "/api/v1/admin/users", "", otherCookie, "", ""), 403)
	if _, err = f.db.Exec("UPDATE users SET blocked_at='now' WHERE id=?", f.admin.ID); err != nil {
		t.Fatal(err)
	}
	expect(t, f.request("GET", "/api/v1/admin/users", "", admin, "", ""), 401)
	for _, value := range []string{admin.Value, otherCookie.Value, sample, replacement, renamed} {
		if strings.Contains(f.logs.String(), value) {
			t.Fatal("account selection leaked private data to HTTP logs")
		}
	}
}
