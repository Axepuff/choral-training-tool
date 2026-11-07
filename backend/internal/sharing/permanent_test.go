package sharing

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// These are HTTP response contracts, independent of the handler's state helpers.
type permanentResponse struct {
	Current *struct {
		Share   share   `json:"share"`
		Version int     `json:"version"`
		URL     *string `json:"url"`
	} `json:"current"`
	Legacy []share `json:"legacy"`
}

func permanentRequest(kind, id string, acceptLegacy bool) (string, string) {
	field := "ownerId"
	if kind == "song" {
		field = "songId"
	}
	query := url.Values{"kind": {kind}, field: {id}}
	body := map[string]any{"kind": kind, field: id}
	if acceptLegacy {
		body["acceptLegacy"] = true
	}
	encoded, _ := json.Marshal(body)
	return "/api/v1/shares/permanent?" + query.Encode(), string(encoded)
}

func permanentResult(t *testing.T, w *httptest.ResponseRecorder, status int) permanentResponse {
	t.Helper()
	expect(t, w, status)
	var result permanentResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal("invalid permanent share response")
	}
	return result
}

func permanentURL(t *testing.T, result permanentResponse) string {
	t.Helper()
	if result.Current == nil || result.Current.URL == nil || result.Current.Share.Disabled != nil {
		t.Fatal("active permanent URL missing")
	}
	return *result.Current.URL
}

func publicURLPath(t *testing.T, address string) string {
	t.Helper()
	u, err := url.Parse(address)
	if err != nil {
		t.Fatal("invalid public URL")
	}
	raw := u.Query().Get("song")
	if raw == "" {
		raw = u.Query().Get("list")
	}
	if len(raw) != 43 {
		t.Fatal("public URL has no bearer grant")
	}
	return "/api/v1/public/shares/" + raw
}

// Owns persistence/authorization of the new API; browser tests own clipboard and dialog behavior.
func TestPermanentSharePersistenceAndAccess(t *testing.T) {
	f := setup(t)
	songID, _, _ := f.song(f.a, true)
	type savedScope struct{ kind, path, body, address, id string }
	var saved []savedScope
	for _, scope := range []struct{ kind, id string }{{"list", f.a.id}, {"song", songID}} {
		path, body := permanentRequest(scope.kind, scope.id, false)
		empty := permanentResult(t, f.req("GET", path, "", f.a, nil), 200)
		if empty.Current != nil || len(empty.Legacy) != 0 {
			t.Fatal("GET created a share")
		}
		first := permanentResult(t, f.req("POST", "/api/v1/shares/permanent", body, f.a, nil), 201)
		address := permanentURL(t, first)
		for _, owner := range []actor{f.a, f.admin} {
			read := permanentResult(t, f.req("GET", path, "", owner, nil), 200)
			repeated := permanentResult(t, f.req("POST", "/api/v1/shares/permanent", body, owner, nil), 200)
			if permanentURL(t, read) != address || permanentURL(t, repeated) != address || read.Current.Share.ID != first.Current.Share.ID {
				t.Fatal("owner/admin or repeated ensure changed the permanent address")
			}
		}
		for _, method := range []string{"GET", "POST"} {
			target, payload := path, ""
			if method == "POST" {
				target, payload = "/api/v1/shares/permanent", body
			}
			expect(t, f.req(method, target, payload, actor{}, nil), 401)
			forbidden := 403
			if scope.kind == "song" {
				forbidden = 404
			}
			expect(t, f.req(method, target, payload, f.b, nil), forbidden)
		}
		expect(t, f.req("POST", "/api/v1/shares/permanent", body, f.a, map[string]string{"X-CSRF-Token": "wrong"}), 403)
		parsed, _ := url.Parse(address)
		var ciphertext, storedHash []byte
		if err := f.db.QueryRow("SELECT token_ciphertext,token_hash FROM shares WHERE id=?", first.Current.Share.ID).Scan(&ciphertext, &storedHash); err != nil {
			t.Fatal(err)
		}
		raw := []byte(parsed.Query().Get(scope.kind))
		if len(ciphertext) == 0 || bytes.Contains(ciphertext, raw) || bytes.Contains(storedHash, raw) {
			t.Fatal("permanent bearer token stored in plaintext")
		}
		saved = append(saved, savedScope{scope.kind, path, body, address, first.Current.Share.ID})
	}
	// No replay record or in-process cache may be required to recover these URLs.
	f.exec("DELETE FROM idempotency_records")
	f.db.Close()
	f.open()
	f.s.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
	for _, scope := range saved {
		result := permanentResult(t, f.req("GET", scope.path, "", f.admin, nil), 200)
		if permanentURL(t, result) != scope.address {
			t.Fatal("restart or replay expiry lost the permanent address")
		}
		expect(t, f.req("GET", publicURLPath(t, scope.address), "", actor{}, nil), 200)
	}
	f.exec("UPDATE songs SET publication='draft' WHERE id=?", songID)
	expect(t, f.req("GET", publicURLPath(t, saved[1].address), "", actor{}, nil), 404)
	f.exec("UPDATE songs SET publication='published' WHERE id=?", songID)
	expect(t, f.req("GET", publicURLPath(t, saved[1].address), "", actor{}, nil), 200)
	f.exec("UPDATE users SET blocked_at='now' WHERE id=?", f.a.id)
	expect(t, f.req("GET", saved[0].path, "", f.a, nil), 401)
	f.exec("UPDATE users SET blocked_at=NULL WHERE id=?", f.a.id)
	f.exec("UPDATE songs SET deleted_at='now' WHERE id=?", songID)
	expect(t, f.req("GET", saved[1].path, "", f.admin, nil), 404)
	expect(t, f.req("POST", "/api/v1/shares/permanent", saved[1].body, f.admin, nil), 404)
	expect(t, f.req("POST", "/api/v1/shares/"+saved[1].id+"/rotate", "", f.admin, map[string]string{"If-Match": "\"1\""}), 404)
}

func TestPermanentShareConcurrentEnsureAndGuardedChanges(t *testing.T) {
	f := setup(t)
	path, body := permanentRequest("list", f.a.id, false)
	results := make(chan *httptest.ResponseRecorder, 8)
	for n := 0; n < cap(results); n++ {
		owner := f.a
		if n%2 == 1 {
			owner = f.admin
		}
		go func(a actor) { results <- f.req("POST", "/api/v1/shares/permanent", body, a, nil) }(owner)
	}
	created, address, shareID := 0, "", ""
	for n := 0; n < cap(results); n++ {
		w := <-results
		if w.Code != 200 && w.Code != 201 {
			t.Fatalf("concurrent ensure failed: %d", w.Code)
		}
		if w.Code == 201 {
			created++
		}
		result := permanentResult(t, w, w.Code)
		if address == "" {
			address, shareID = permanentURL(t, result), result.Current.Share.ID
		} else if permanentURL(t, result) != address || result.Current.Share.ID != shareID {
			t.Fatal("concurrent requests created different links")
		}
	}
	if created != 1 {
		t.Fatalf("created %d permanent links", created)
	}
	rotate := "/api/v1/shares/" + shareID + "/rotate"
	remove := "/api/v1/shares/" + shareID
	for _, operation := range []struct{ method, path string }{{"POST", rotate}, {"DELETE", remove}} {
		expect(t, f.req(operation.method, operation.path, "", f.a, nil), 428)
		expect(t, f.req(operation.method, operation.path, "", f.b, map[string]string{"If-Match": "\"1\""}), 404)
	}
	mutations := make(chan *httptest.ResponseRecorder, 2)
	for _, a := range []actor{f.a, f.admin} {
		go func(owner actor) {
			mutations <- f.req("POST", rotate, "", owner, map[string]string{"If-Match": "\"1\""})
		}(a)
	}
	success, conflict := 0, 0
	for n := 0; n < cap(mutations); n++ {
		switch (<-mutations).Code {
		case 200:
			success++
		case 412:
			conflict++
		default:
			t.Fatal("unexpected concurrent rotation status")
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("two actors rotated the same version")
	}
	rotated := permanentResult(t, f.req("GET", path, "", f.a, nil), 200)
	newAddress := permanentURL(t, rotated)
	if newAddress == address || rotated.Current.Version != 2 {
		t.Fatal("rotation did not create exactly one new version/address")
	}
	expect(t, f.req("GET", publicURLPath(t, address), "", actor{}, nil), 404)
	expect(t, f.req("GET", publicURLPath(t, newAddress), "", actor{}, nil), 200)
	// A lost response replay must not replace the successful address again.
	expect(t, f.req("POST", rotate, "", f.a, map[string]string{"If-Match": "\"1\""}), 412)
	again := permanentResult(t, f.req("GET", path, "", f.a, nil), 200)
	if permanentURL(t, again) != newAddress {
		t.Fatal("stale retry rotated again")
	}
	expect(t, f.req("DELETE", remove, "", f.a, map[string]string{"If-Match": "\"2\""}), 204)
	disabled := permanentResult(t, f.req("GET", path, "", f.a, nil), 200)
	if disabled.Current == nil || disabled.Current.URL != nil || disabled.Current.Share.Disabled == nil || disabled.Current.Version != 3 {
		t.Fatal("disabled state exposes an address or loses its version")
	}
	expect(t, f.req("GET", publicURLPath(t, newAddress), "", actor{}, nil), 404)
	expect(t, f.req("POST", "/api/v1/shares/permanent", body, f.a, nil), 409)
	expect(t, f.req("POST", rotate, "", f.admin, map[string]string{"If-Match": "\"3\""}), 200)
	enabled := permanentResult(t, f.req("GET", path, "", f.a, nil), 200)
	if permanentURL(t, enabled) == newAddress || permanentURL(t, enabled) == address {
		t.Fatal("reenabling resurrected a revoked address")
	}
	expect(t, f.req("GET", publicURLPath(t, newAddress), "", actor{}, nil), 404)
}

func TestPermanentShareLegacyUpgradeAndCorruption(t *testing.T) {
	f := setup(t)
	old, _ := f.create(f.a, "list", f.a.id)
	revoked, _ := f.create(f.a, "list", f.a.id)
	expect(t, f.req("DELETE", "/api/v1/shares/"+revoked.Share.ID, "", f.a, nil), 204)
	// Reconstruct the previous additive schema, then run the real upgrade with live grants.
	f.exec("DROP INDEX shares_permanent_list; DROP INDEX shares_permanent_song")
	for _, column := range []string{"token_nonce", "token_ciphertext", "version", "permanent"} {
		f.exec("ALTER TABLE shares DROP COLUMN " + column)
	}
	f.exec("DELETE FROM schema_migrations WHERE name='0006_permanent_shares.sql'")
	f.db.Close()
	f.open()
	path, body := permanentRequest("list", f.a.id, false)
	state := permanentResult(t, f.req("GET", path, "", f.a, nil), 200)
	if state.Current != nil || len(state.Legacy) != 2 {
		t.Fatal("upgrade silently promoted or lost legacy grants")
	}
	expect(t, f.req("GET", publicPath(old), "", actor{}, nil), 200)
	expect(t, f.req("GET", publicPath(revoked), "", actor{}, nil), 404)
	expect(t, f.req("POST", "/api/v1/shares/permanent", body, f.a, nil), 409)
	_, acceptedBody := permanentRequest("list", f.a.id, true)
	current := permanentResult(t, f.req("POST", "/api/v1/shares/permanent", acceptedBody, f.a, nil), 201)
	address := permanentURL(t, current)
	expect(t, f.req("GET", publicPath(old), "", actor{}, nil), 200)
	expect(t, f.req("GET", publicPath(revoked), "", actor{}, nil), 404)
	expect(t, f.req("DELETE", "/api/v1/shares/"+old.Share.ID, "", f.a, nil), 204)
	expect(t, f.req("GET", publicURLPath(t, address), "", actor{}, nil), 200)
	// A history containing only revoked links must not claim old links still work.
	onlyRevoked, _ := f.create(f.b, "list", f.b.id)
	expect(t, f.req("DELETE", "/api/v1/shares/"+onlyRevoked.Share.ID, "", f.b, nil), 204)
	otherPath, otherBody := permanentRequest("list", f.b.id, false)
	other := permanentResult(t, f.req("POST", "/api/v1/shares/permanent", otherBody, f.b, nil), 201)
	var ciphertext, nonce []byte
	if err := f.db.QueryRow("SELECT token_ciphertext,token_nonce FROM shares WHERE id=?", other.Current.Share.ID).Scan(&ciphertext, &nonce); err != nil {
		t.Fatal(err)
	}
	// Valid ciphertext from another resource is invalid here, even with an intact key.
	f.exec("UPDATE shares SET token_ciphertext=?,token_nonce=? WHERE id=?", ciphertext, nonce, current.Current.Share.ID)
	expect(t, f.req("GET", path, "", f.a, nil), 503)
	expect(t, f.req("POST", "/api/v1/shares/permanent", acceptedBody, f.a, nil), 503)
	expect(t, f.req("POST", "/api/v1/shares/"+current.Current.Share.ID+"/rotate", "", f.a, map[string]string{"If-Match": "\"1\""}), 503)
	// Failure must not silently rotate the still valid public grant or damage the other scope.
	expect(t, f.req("GET", publicURLPath(t, address), "", actor{}, nil), 200)
	readOther := permanentResult(t, f.req("GET", otherPath, "", f.b, nil), 200)
	if permanentURL(t, readOther) != permanentURL(t, other) {
		t.Fatal("corruption leaked into another resource")
	}
}

func TestPermanentShareRequestValidation(t *testing.T) {
	f := setup(t)
	_, body := permanentRequest("list", f.a.id, false)
	for _, malformed := range []string{"null", "{}", body + "{}", fmt.Sprintf("{\"kind\":\"list\",\"ownerId\":%q,\"unexpected\":true}", f.a.id)} {
		expect(t, f.req("POST", "/api/v1/shares/permanent", malformed, f.a, nil), 422)
	}
	expect(t, f.req("GET", "/api/v1/shares/permanent?kind=list&kind=song&ownerId="+f.a.id, "", f.a, nil), 422)
	expect(t, f.req("POST", "/api/v1/shares/permanent", body, f.a, map[string]string{"Content-Type": "text/plain"}), 422)
	oversized := fmt.Sprintf("{\"kind\":\"list\",\"ownerId\":%q,\"acceptLegacy\":false}%s", f.a.id, strings.Repeat(" ", 8192))
	expect(t, f.req("POST", "/api/v1/shares/permanent", oversized, f.a, nil), 413)
}
