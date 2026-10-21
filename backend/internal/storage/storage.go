// Package storage owns the private, flat file namespace on the persistent volume.
package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var ErrSize = errors.New("upload_too_large")
var keyPattern = regexp.MustCompile(`^(stage|original|playback|peaks)-[0-9a-f-]{36}$`)

type Store struct{ root *os.Root }

func New(dir string) (*Store, error) {
	dir = filepath.Join(dir, "files")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &Store{root}, nil
}
func (s *Store) Close() error { return s.root.Close() }
func (s *Store) valid(key string) error {
	if !keyPattern.MatchString(key) {
		return errors.New("invalid storage key")
	}
	return nil
}
func (s *Store) Stage(ctx context.Context, key string, r io.Reader, max int64) (err error) {
	if err = s.valid(key); err != nil {
		return
	}
	if !strings.HasPrefix(key, "stage-") {
		return errors.New("invalid stage")
	}
	f, err := s.root.OpenFile(key, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer func() {
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = s.root.Remove(key)
		}
	}()
	n, err := io.Copy(f, io.LimitReader(&contextReader{ctx, r}, max+1))
	if err != nil {
		return err
	}
	if n > max {
		return ErrSize
	}
	if n == 0 {
		return errors.New("empty file")
	}
	return f.Sync()
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}
func (s *Store) Publish(ctx context.Context, from, to string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.valid(from) != nil || s.valid(to) != nil {
		return errors.New("invalid key")
	}
	// Link is atomic and never overwrites an existing immutable object.
	if err := s.root.Link(from, to); err != nil {
		return err
	}
	if err := s.root.Remove(from); err != nil {
		return err
	}
	return s.sync()
}
func (s *Store) sync() error {
	f, e := s.root.Open(".")
	if e != nil {
		return e
	}
	defer f.Close()
	return f.Sync()
}
func (s *Store) Open(ctx context.Context, key string) (io.ReadSeekCloser, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if s.valid(key) != nil {
		return nil, errors.New("invalid key")
	}
	st, e := s.root.Lstat(key)
	if e != nil {
		return nil, e
	}
	if !st.Mode().IsRegular() {
		return nil, errors.New("not regular")
	}
	f, e := s.root.Open(key)
	if e != nil {
		return nil, e
	}
	st, e = f.Stat()
	if e != nil || !st.Mode().IsRegular() {
		f.Close()
		return nil, errors.New("not regular")
	}
	return f, nil
}
func (s *Store) Remove(_ context.Context, key string) error {
	if err := s.valid(key); err != nil {
		return err
	}
	e := s.root.Remove(key)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	return s.sync()
}

// Recover runs before serving requests, in the single service process. Referenced
// originals (including failures) survive; uncommitted files are crash leftovers.
func (s *Store) Recover(keep map[string]bool) error {
	f, e := s.root.Open(".")
	if e != nil {
		return e
	}
	defer f.Close()
	entries, e := f.ReadDir(-1)
	if e != nil {
		return e
	}
	for _, v := range entries {
		key := v.Name()
		if strings.HasPrefix(key, "stage-") || strings.HasPrefix(key, "original-") && !keep[key] {
			if e = s.Remove(context.Background(), key); e != nil {
				return e
			}
		}
	}
	return nil
}
