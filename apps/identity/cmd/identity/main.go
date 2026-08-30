package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
)

const shutdownTimeout = 15 * time.Second

func main() {
	os.Exit(run())
}

func run() int {
	level, levelErr := logLevel()
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)
	if levelErr != nil {
		log.Warn("invalid IDENTITY_LOG_LEVEL, falling back to info",
			"service", server.ServiceName, "error", levelErr)
	}

	addr := os.Getenv("IDENTITY_GRPC_ADDR")
	if addr == "" {
		addr = ":50051"
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	lis, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		log.Error("listen failed", "service", server.ServiceName, "addr", addr, "error", err)
		return 1
	}

	srv := server.New(log)
	errCh := make(chan error, 1)
	go func() {
		log.Info("identity listening", "service", server.ServiceName, "addr", lis.Addr().String())
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received",
			"service", server.ServiceName, "timeout", shutdownTimeout.String())
		stopped := make(chan struct{})
		go func() {
			srv.GracefulStop()
			close(stopped)
		}()
		select {
		case <-stopped:
			log.Info("graceful shutdown complete", "service", server.ServiceName)
		case <-time.After(shutdownTimeout):
			log.Error("graceful shutdown timed out, forcing stop",
				"service", server.ServiceName, "timeout", shutdownTimeout.String())
			srv.Stop()
		}
	case serveErr := <-errCh:
		if serveErr != nil {
			log.Error("serve failed", "service", server.ServiceName, "error", serveErr)
			return 1
		}
	}

	return 0
}

func logLevel() (slog.Level, error) {
	raw := os.Getenv("IDENTITY_LOG_LEVEL")
	if raw == "" {
		return slog.LevelInfo, nil
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(raw)); err != nil {
		return slog.LevelInfo, err
	}
	return level, nil
}
