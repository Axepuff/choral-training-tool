package platform

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync/atomic"
	"time"
)

type Config struct {
	Addr, DataDir   string
	StaticDir       string
	ShutdownTimeout time.Duration
}

func LoadConfig() (Config, error) {
	c := Config{Addr: "127.0.0.1:8080", DataDir: "./data", ShutdownTimeout: 15 * time.Second}
	c.StaticDir = os.Getenv("CHORAL_STATIC_DIR")
	if v, ok := os.LookupEnv("CHORAL_ADDR"); ok {
		c.Addr = v
	}
	if v, ok := os.LookupEnv("CHORAL_DATA_DIR"); ok {
		c.DataDir = v
	}
	if v, ok := os.LookupEnv("CHORAL_SHUTDOWN_TIMEOUT"); ok {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 || d > time.Minute {
			return c, errors.New("invalid CHORAL_SHUTDOWN_TIMEOUT (0 < duration <= 1m)")
		}
		c.ShutdownTimeout = d
	}
	if _, _, err := net.SplitHostPort(c.Addr); err != nil {
		return c, errors.New("invalid CHORAL_ADDR")
	}
	if c.DataDir == "" {
		return c, errors.New("empty CHORAL_DATA_DIR")
	}
	return c, nil
}

type Service struct {
	Server   *http.Server
	db       *sql.DB
	log      *slog.Logger
	stopping atomic.Bool
	timeout  time.Duration
}

func NewService(c Config, db *sql.DB, logger *slog.Logger, register ...func(*http.ServeMux)) *Service {
	s := &Service{db: db, log: logger, timeout: c.ShutdownTimeout}
	mux := http.NewServeMux()
	for _, routes := range register {
		routes(mux)
	}
	mux.HandleFunc("GET /livez", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "alive"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if s.stopping.Load() || db.PingContext(ctx) != nil {
			writeJSON(w, 503, map[string]string{"status": "unavailable"})
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	notFound := func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 404, map[string]any{"error": map[string]string{"code": "not_found", "message": "Route not implemented", "requestId": w.Header().Get("X-Request-Id")}})
	}
	mux.HandleFunc("/api", notFound)
	mux.HandleFunc("/api/", notFound)
	if c.StaticDir != "" {
		mux.Handle("/", frontend(c.StaticDir))
	} else {
		mux.HandleFunc("/", notFound)
	}
	s.Server = &http.Server{Addr: c.Addr, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := make([]byte, 16)
		if _, err := rand.Read(id); err != nil {
			http.Error(w, "unavailable", 503)
			return
		}
		w.Header().Set("X-Request-Id", hex.EncodeToString(id))
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		r.Body = http.MaxBytesReader(w, r.Body, 101<<20)
		start := time.Now()
		defer func() {
			logger.Info("http_request", "request_id", hex.EncodeToString(id), "duration_ms", time.Since(start).Milliseconds())
		}()
		mux.ServeHTTP(w, r)
	}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10, ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelError)}
	return s
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Serve drains in-flight requests before the caller closes SQLite. On deadline
// active sockets are closed, and the error is returned to the process supervisor.
func (s *Service) Serve(ctx context.Context, listener net.Listener) error {
	done := make(chan error, 1)
	go func() { done <- s.Server.Serve(listener) }()
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		s.stopping.Store(true)
		shutdown, cancel := context.WithTimeout(context.Background(), s.timeout)
		defer cancel()
		err := s.Server.Shutdown(shutdown)
		if err != nil {
			_ = s.Server.Close()
		}
		serveErr := <-done
		if err != nil {
			return err
		}
		if !errors.Is(serveErr, http.ErrServerClosed) {
			return serveErr
		}
		return nil
	}
}
