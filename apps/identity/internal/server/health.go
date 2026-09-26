package server

import (
	"context"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

// readinessTimeout ограничивает пинг базы в пробе готовности. Он меньше дедлайна
// пробы AppHost в три секунды: иначе вместо NOT_SERVING проба получила бы
// DeadlineExceeded и назвала бы причину хуже.
const readinessTimeout = 2 * time.Second

// ReadinessService — имя, под которым проба спрашивает готовность. Пустое имя
// отвечает liveness: процесс обслуживает gRPC, база не проверяется. Имя
// сервиса отвечает readiness: сервис может выполнить доменный вызов, то есть
// его база отвечает.
var ReadinessService = identityv1.IdentityService_ServiceDesc.ServiceName

// pinger — то, что проба готовности спрашивает о базе. Интерфейс, а не
// *sql.DB, чтобы unit-тест пробы обходился без PostgreSQL.
type pinger interface {
	PingContext(ctx context.Context) error
}

// readiness вычисляет готовность по запросу Check, а не фоновым циклом: так
// статус не отстаёт от базы на период опроса и не нужен жизненный цикл
// горутины. Статичные статусы, в том числе NOT_SERVING после Shutdown, остаются
// у встроенного health.Server и отдаются как есть.
type readiness struct {
	*health.Server
	db pinger
}

func (r readiness) Check(ctx context.Context, req *healthgrpc.HealthCheckRequest) (*healthgrpc.HealthCheckResponse, error) {
	resp, err := r.Server.Check(ctx, req)
	if err != nil || req.GetService() != ReadinessService || resp.GetStatus() != healthgrpc.HealthCheckResponse_SERVING {
		return resp, err
	}
	ping, cancel := context.WithTimeout(ctx, readinessTimeout)
	defer cancel()
	if err := r.db.PingContext(ping); err != nil {
		return &healthgrpc.HealthCheckResponse{Status: healthgrpc.HealthCheckResponse_NOT_SERVING}, nil
	}
	return resp, nil
}

// Watch на имени готовности отказывает честно: встроенный сервер разослал бы
// статичный SERVING, который о базе ничего не знает.
func (r readiness) Watch(req *healthgrpc.HealthCheckRequest, stream healthgrpc.Health_WatchServer) error {
	if req.GetService() == ReadinessService {
		return status.Error(codes.Unimplemented, "readiness is computed on Check; Watch is not supported for it")
	}
	return r.Server.Watch(req, stream)
}
