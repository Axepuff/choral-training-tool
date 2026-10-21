package platform

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
)

func ResponseKey(dir, filename string) (cipher.AEAD, []byte, error) {
	path := filepath.Join(dir, filename)
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
			return nil, nil, err
		}
		if closeErr != nil {
			return nil, nil, closeErr
		}
	} else if errors.Is(err, os.ErrExist) {
		key, err = os.ReadFile(path)
		if err != nil {
			return nil, nil, err
		}
	} else {
		return nil, nil, err
	}
	if len(key) != 32 {
		return nil, nil, errors.New("invalid response key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	return gcm, key, nil
}
