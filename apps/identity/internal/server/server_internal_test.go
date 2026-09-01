package server

import (
	"log/slog"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
)

// Белый ящик: после GracefulStop сервер соединений не принимает, поэтому
// увидеть NOT_SERVING снаружи по сети уже нельзя, и health опрашивается
// напрямую.
func TestGracefulStopMarksHealthNotServing(t *testing.T) {
	t.Parallel()

	srv := New(slog.New(slog.DiscardHandler), nil, 0)
	names := []string{"", identityv1.IdentityService_ServiceDesc.ServiceName}

	assertStatus := func(when string, want healthgrpc.HealthCheckResponse_ServingStatus) {
		t.Helper()
		for _, name := range names {
			resp, err := srv.health.Check(t.Context(), &healthgrpc.HealthCheckRequest{Service: name})
			if err != nil {
				t.Fatalf("check %q %s: %v", name, when, err)
			}
			if resp.GetStatus() != want {
				t.Fatalf("status %q %s: got %s want %s", name, when, resp.GetStatus(), want)
			}
		}
	}

	assertStatus("before stop", healthgrpc.HealthCheckResponse_SERVING)
	srv.GracefulStop()
	assertStatus("after stop", healthgrpc.HealthCheckResponse_NOT_SERVING)
}
