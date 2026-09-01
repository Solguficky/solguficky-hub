package server

import (
	"database/sql"
	"log/slog"
	"net"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

const ServiceName = "identity"

type Server struct {
	grpc   *grpc.Server
	health *health.Server
}

func New(log *slog.Logger, db *sql.DB) *Server {
	if log == nil {
		log = slog.Default()
	}
	if db == nil {
		panic("identity: nil database")
	}

	srv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			unaryLogging(log),
			unaryRecovery(),
		),
		grpc.ChainStreamInterceptor(
			streamLogging(log),
			streamRecovery(),
		),
	)
	identityv1.RegisterIdentityServiceServer(srv, identityService{db: db})

	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("", healthgrpc.HealthCheckResponse_SERVING)
	healthSrv.SetServingStatus(identityv1.IdentityService_ServiceDesc.ServiceName, healthgrpc.HealthCheckResponse_SERVING)
	healthgrpc.RegisterHealthServer(srv, healthSrv)
	reflection.Register(srv)

	return &Server{grpc: srv, health: healthSrv}
}

func (s *Server) Serve(lis net.Listener) error {
	return s.grpc.Serve(lis)
}

// GracefulStop сначала переводит health в NOT_SERVING и только потом сливает
// соединения: иначе балансировщик весь слив читает SERVING.
func (s *Server) GracefulStop() {
	s.health.Shutdown()
	s.grpc.GracefulStop()
}

func (s *Server) Stop() {
	s.grpc.Stop()
}
