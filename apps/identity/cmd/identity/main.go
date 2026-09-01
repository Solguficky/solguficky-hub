package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"google.golang.org/grpc"
)

var errDatabaseURLMissing = errors.New("IDENTITY_DATABASE_URL is not set")

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

	dsn, err := databaseURL()
	if err != nil {
		log.Error("database configuration failed", "service", server.ServiceName, "error", err)
		return 1
	}
	if err := migrations.ApplyDSN(ctx, dsn); err != nil {
		log.Error("migrations failed", "service", server.ServiceName, "error", err)
		return 1
	}
	log.Info("migrations applied", "service", server.ServiceName)

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
		// Serve уже вернулся: и GracefulStop, и Stop его завершают. Читать
		// errCh обязательно — при готовности обоих case select выбирает ветку
		// псевдослучайно, поэтому отказ листенера, совпавший с сигналом, иначе
		// потерялся бы, и процесс отчитался бы кодом 0.
		if serveErr := <-errCh; !serveDone(serveErr) {
			log.Error("serve failed", "service", server.ServiceName, "error", serveErr)
			return 1
		}
	case serveErr := <-errCh:
		if !serveDone(serveErr) {
			log.Error("serve failed", "service", server.ServiceName, "error", serveErr)
			return 1
		}
	}

	return 0
}

// serveDone отличает штатное завершение Serve от собственного отказа сервера.
func serveDone(err error) bool {
	return err == nil || errors.Is(err, grpc.ErrServerStopped)
}

func databaseURL() (string, error) {
	dsn := os.Getenv("IDENTITY_DATABASE_URL")
	if dsn == "" {
		return "", errDatabaseURLMissing
	}
	return dsn, nil
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
