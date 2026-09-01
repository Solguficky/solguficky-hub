package server

import (
	"database/sql"
	"log/slog"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
)

func TestNewPanicsOnNilDB(t *testing.T) {
	t.Parallel()

	defer func() {
		if recover() == nil {
			t.Fatal("New(nil db): got no panic")
		}
	}()
	New(slog.New(slog.DiscardHandler), nil)
}

func TestGracefulStopMarksHealthNotServing(t *testing.T) {
	t.Parallel()

	srv := New(slog.New(slog.DiscardHandler), new(sql.DB))
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
