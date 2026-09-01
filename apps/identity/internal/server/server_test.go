package server_test

import (
	"context"
	"database/sql"
	"log/slog"
	"net"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/test/bufconn"
)

func TestHealthCheckServing(t *testing.T) {
	t.Parallel()

	conn := newConn(t)
	resp, err := healthgrpc.NewHealthClient(conn).Check(t.Context(), &healthgrpc.HealthCheckRequest{
		Service: identityv1.IdentityService_ServiceDesc.ServiceName,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetStatus() != healthgrpc.HealthCheckResponse_SERVING {
		t.Fatalf("status: got %s want %s", resp.GetStatus(), healthgrpc.HealthCheckResponse_SERVING)
	}
}

func newIdentityClient(t *testing.T) identityv1.IdentityServiceClient {
	t.Helper()
	return identityv1.NewIdentityServiceClient(newConn(t))
}

func newConn(t *testing.T) *grpc.ClientConn {
	t.Helper()
	return newConnWith(t, new(sql.DB))
}

func newConnWith(t *testing.T, db *sql.DB) *grpc.ClientConn {
	t.Helper()

	lis := bufconn.Listen(1024 * 1024)
	t.Cleanup(func() { _ = lis.Close() })

	log := slog.New(slog.DiscardHandler)
	srv := server.New(log, db)
	t.Cleanup(srv.Stop)
	go func() {
		_ = srv.Serve(lis)
	}()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
