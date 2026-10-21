package songs

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
)

// New keeps the response key outside SQLite. Back up this file with the data
// volume; losing it makes unexpired creation replays fail closed.
func New(db *sql.DB, i platform.IdentityProvider, a platform.Authorizer, dir string) (*Service, error) {
	path := filepath.Join(dir, "song-responses.key")
	key := make([]byte, 32)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err == nil {
		if _, err = rand.Read(key); err == nil {
			_, err = f.Write(key)
		}
		if err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return nil, err
		}
		if closeErr != nil {
			return nil, closeErr
		}
	} else if errors.Is(err, os.ErrExist) {
		key, err = os.ReadFile(path)
		if err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	if len(key) != 32 {
		return nil, errors.New("invalid song response key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
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
