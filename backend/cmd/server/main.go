package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
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
	listener, err := net.Listen("tcp", c.Addr)
	if err != nil {
		log.Error("listen_failed")
		return 1
	}
	log.Info("server_started")
	if err := platform.NewService(c, db, log).Serve(ctx, listener); err != nil {
		log.Error("server_stopped_with_error")
		return 1
	}
	log.Info("server_stopped")
	return 0
}
