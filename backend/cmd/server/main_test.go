package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestProcessHealthAndSIGTERM(t *testing.T) {
	for _, name := range []string{"ffmpeg", "ffprobe", "prlimit"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skip("requires " + name)
		}
	}
	binary := filepath.Join(t.TempDir(), "server")
	build := exec.Command("go", "build", "-o", binary, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close()
	dir := t.TempDir()
	static := t.TempDir()
	if err = os.WriteFile(filepath.Join(static, "index.html"), []byte("real process frontend"), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(binary)
	cmd.Env = append(os.Environ(), "CHORAL_ADDR="+addr, "CHORAL_DATA_DIR="+dir, "CHORAL_STATIC_DIR="+static, "CHORAL_ORIGIN=https://localhost", "CHORAL_LOCAL_HTTP=false")
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer cmd.Process.Kill()
	client := &http.Client{Timeout: time.Second}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for {
		response, e := client.Get("http://" + addr + "/readyz")
		if e == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				break
			}
		}
		select {
		case e := <-done:
			t.Fatalf("early exit: %v", e)
		case <-ctx.Done():
			t.Fatal("startup timeout")
		case <-time.After(100 * time.Millisecond):
		}
	}
	response, err := client.Get("http://" + addr + "/deep/link?list=synthetic")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != "real process frontend" {
		t.Fatalf("frontend: %s %v", body, err)
	}
	if err = cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatalf("SIGTERM: %v", err)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("shutdown exceeded grace period")
	}
	if _, err = client.Get("http://" + addr + "/livez"); err == nil {
		t.Fatal("listener remains open")
	}
}
