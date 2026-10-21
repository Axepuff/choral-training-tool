package storage

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStorageBoundaries(t *testing.T) {
	dir := t.TempDir()
	s, e := New(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	id := "00000000-0000-4000-8000-000000000001"
	stage := "stage-" + id
	key := "original-" + id
	if e = s.Stage(ctx, stage, strings.NewReader("abcd"), 3); e != ErrSize {
		t.Fatal(e)
	}
	if _, e = s.Open(ctx, stage); !os.IsNotExist(e) {
		t.Fatal("overflow file remains", e)
	}
	if e = s.Stage(ctx, stage, strings.NewReader("abc"), 3); e != nil {
		t.Fatal(e)
	}
	if e = s.Publish(ctx, stage, key); e != nil {
		t.Fatal(e)
	}
	if e = s.Stage(ctx, stage, strings.NewReader("new"), 3); e != nil {
		t.Fatal(e)
	}
	if e = s.Publish(ctx, stage, key); e == nil {
		t.Fatal("overwrote original")
	}
	f, e := s.Open(ctx, key)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(f)
	f.Close()
	if string(b) != "abc" {
		t.Fatal("original changed")
	}
	for _, bad := range []string{"../outside", "/etc/passwd", "original-../../x"} {
		if _, e = s.Open(ctx, bad); e == nil {
			t.Fatal("traversal", bad)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(outside, []byte("private"), 0600)
	link := "playback-" + id
	if e = os.Symlink(outside, filepath.Join(dir, "files", link)); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Open(ctx, link); e == nil {
		t.Fatal("symlink escape")
	}
}
