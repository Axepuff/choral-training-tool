package songs

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
)

// New keeps the response key outside SQLite. Back up this file with the data
// volume; losing it makes unexpired creation replays fail closed.
func New(db *sql.DB, i platform.IdentityProvider, a platform.Authorizer, dir string) (*Service, error) {
	gcm, key, err := platform.ResponseKey(dir, "song-responses.key")
	if err != nil {
		return nil, err
	}
	cursorKey := sha256.Sum256(append([]byte("songs-cursor-v1:"), key...))
	return &Service{cursorKey: cursorKey[:], DB: db, Identity: i, Access: a, now: time.Now, replay: gcm}, nil
}
func (s *Service) seal(body, aad []byte) ([]byte, []byte, error) {
	nonce := make([]byte, s.replay.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return s.replay.Seal(nil, nonce, body, aad), nonce, nil
}
