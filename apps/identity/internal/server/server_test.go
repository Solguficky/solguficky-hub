package server_test

import (
	"context"
	"log/slog"
	"net"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// Чёрный ящик: значение заглушки — деталь реализации и проверяется
// внутренним тестом. Снаружи наблюдаемы непустой ответ, его повторяемость и
// то, что optional-поле контракта проходит по проводу в обоих состояниях.
func TestResolveIdentityOverGRPC(t *testing.T) {
	t.Parallel()

	username := "alice"
	cases := []struct {
		name string
		req  *identityv1.ResolveIdentityRequest
	}{
		{name: "with username", req: &identityv1.ResolveIdentityRequest{TelegramUserId: 42, TelegramUsername: &username}},
		{name: "without username", req: &identityv1.ResolveIdentityRequest{TelegramUserId: 42}},
	}

	client := newIdentityClient(t)
	var first string
	for _, tc := range cases {
		resp, err := client.ResolveIdentity(t.Context(), tc.req)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if resp.GetIdentityId() == "" {
			t.Fatalf("%s: identity_id is empty", tc.name)
		}
		if len(resp.GetGlobalRoles()) != 0 {
			t.Fatalf("%s: global_roles: got %v want empty", tc.name, resp.GetGlobalRoles())
		}
		if first == "" {
			first = resp.GetIdentityId()
		} else if resp.GetIdentityId() != first {
			t.Fatalf("%s: identity_id: got %q want %q from the previous call", tc.name, resp.GetIdentityId(), first)
		}
	}
}

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

func TestResolveIdentityInvalidArgumentOverGRPC(t *testing.T) {
	t.Parallel()

	client := newIdentityClient(t)
	_, err := client.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("got %v want %s", err, codes.InvalidArgument)
	}
}

func newIdentityClient(t *testing.T) identityv1.IdentityServiceClient {
	t.Helper()
	return identityv1.NewIdentityServiceClient(newConn(t))
}

func newConn(t *testing.T) *grpc.ClientConn {
	t.Helper()

	lis := bufconn.Listen(1024 * 1024)
	t.Cleanup(func() { _ = lis.Close() })

	log := slog.New(slog.DiscardHandler)
	srv := server.New(log)
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
