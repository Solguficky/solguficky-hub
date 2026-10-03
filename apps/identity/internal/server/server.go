package server

import (
	"database/sql"
	"log/slog"
	"net"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
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

// Option настраивает сервер.
type Option func(*config)

type config struct {
	tracerProvider trace.TracerProvider
}

// WithTracerProvider задаёт провайдер серверных спанов. Без опции спаны идут в
// no-op провайдер: контекст входящего вызова всё равно переносится в ctx
// обработчика, но ничего не экспортируется.
func WithTracerProvider(tp trace.TracerProvider) Option {
	return func(c *config) { c.tracerProvider = tp }
}

// New собирает сервер. callers — таблица вызывающих из LoadCallers: сервер без
// неё не собирается, поэтому включённую проверку нельзя забыть на старте.
func New(log *slog.Logger, db *sql.DB, maintainerToken string, callers Callers, opts ...Option) *Server {
	cfg := config{tracerProvider: tracenoop.NewTracerProvider()}
	for _, opt := range opts {
		opt(&cfg)
	}
	if log == nil {
		log = slog.Default()
	}
	if db == nil {
		panic("identity: nil database")
	}

	srv := grpc.NewServer(
		grpc.StatsHandler(tracingHandler(cfg.tracerProvider)),
		grpc.ChainUnaryInterceptor(
			unaryRequestIDSpan(),
			unaryLogging(log),
			unaryCallerGate(callers),
			unaryRecovery(),
		),
		grpc.ChainStreamInterceptor(
			streamRequestIDSpan(),
			streamLogging(log),
			streamCallerGate(callers),
			streamRecovery(),
		),
	)
	identityv1.RegisterIdentityServiceServer(srv, identityService{db: db, log: log, maintainerToken: maintainerToken})

	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("", healthgrpc.HealthCheckResponse_SERVING)
	healthSrv.SetServingStatus(identityv1.IdentityService_ServiceDesc.ServiceName, healthgrpc.HealthCheckResponse_SERVING)
	healthgrpc.RegisterHealthServer(srv, readiness{Server: healthSrv, db: db})
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
