package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/auth"
	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/sharing"
	"github.com/Axepuff/choral-training-tool/backend/internal/songs"
	"github.com/Axepuff/choral-training-tool/backend/internal/storage"
	"github.com/Axepuff/choral-training-tool/backend/internal/uploads"
)

func main() { os.Exit(run()) }
func run() int {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	c, err := platform.LoadConfig()
	if err != nil {
		log.Error("invalid_configuration")
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	startup, cancel := context.WithTimeout(ctx, 15*time.Second)
	db, err := platform.OpenDatabase(startup, c.DataDir)
	cancel()
	if err != nil {
		log.Error("database_startup_failed")
		return 1
	}
	defer db.Close()
	origin := os.Getenv("CHORAL_ORIGIN")
	if origin == "" {
		origin = "https://localhost"
	}
	local := os.Getenv("CHORAL_LOCAL_HTTP")
	if local != "" && local != "true" && local != "false" {
		log.Error("invalid_auth_configuration")
		return 1
	}
	if local == "true" {
		host, _, e := net.SplitHostPort(c.Addr)
		ip := net.ParseIP(host)
		if e != nil || ip == nil || !ip.IsLoopback() {
			log.Error("local_auth_requires_loopback_listener")
			return 1
		}
	}
	identity, err := auth.New(db, origin, local == "true")
	if err != nil {
		log.Error("invalid_auth_configuration")
		return 1
	}
	songAPI, err := songs.New(db, identity, identity, c.DataDir)
	if err != nil {
		log.Error("song_key_startup_failed")
		return 1
	}
	store, err := storage.New(c.DataDir)
	if err != nil {
		log.Error("storage_startup_failed")
		return 1
	}
	defer store.Close()
	uploadAPI, err := uploads.New(db, identity, store, c.DataDir)
	if err != nil {
		log.Error("upload_startup_failed")
		return 1
	}
	shareAPI, err := sharing.New(db, identity, identity, store, c.DataDir)
	if err != nil {
		log.Error("share_key_startup_failed")
		return 1
	}
	listener, err := net.Listen("tcp", c.Addr)
	if err != nil {
		log.Error("listen_failed")
		return 1
	}
	log.Info("server_started")
	if err := platform.NewService(c, db, log, identity.Register, songAPI.Register, shareAPI.Register, uploadAPI.Register).Serve(ctx, listener); err != nil {
		log.Error("server_stopped_with_error")
		return 1
	}
	log.Info("server_stopped")
	return 0
}
