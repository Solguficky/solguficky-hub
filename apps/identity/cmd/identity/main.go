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

func main() {
	os.Exit(run())
}

func run() int {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	addr := os.Getenv("IDENTITY_GRPC_ADDR")
	if addr == "" {
		addr = ":50051"
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	lis, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		log.Error("listen failed", "addr", addr, "error", err)
		return 1
	}

	srv := server.New(log)
	errCh := make(chan error, 1)
	go func() {
		log.Info("identity listening", "service", "identity", "addr", lis.Addr().String())
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		stopped := make(chan struct{})
		go func() {
			srv.GracefulStop()
			close(stopped)
		}()
		select {
		case <-stopped:
		case <-time.After(15 * time.Second):
			srv.Stop()
		}
	case serveErr := <-errCh:
		if serveErr != nil {
			log.Error("serve failed", "error", serveErr)
			return 1
		}
	}

	return 0
}
