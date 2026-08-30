package server

import (
	"context"
	"log/slog"
	"runtime/debug"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/reflection"
	"google.golang.org/grpc/status"
)

const ServiceName = "identity"

func New(log *slog.Logger) *grpc.Server {
	if log == nil {
		log = slog.Default()
	}

	srv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			unaryLogging(log),
			unaryRecovery(log),
		),
		grpc.ChainStreamInterceptor(
			streamLogging(log),
			streamRecovery(log),
		),
	)
	identityv1.RegisterIdentityServiceServer(srv, identityService{})

	healthSrv := health.NewServer()
	healthSrv.SetServingStatus("", healthgrpc.HealthCheckResponse_SERVING)
	healthSrv.SetServingStatus(identityv1.IdentityService_ServiceDesc.ServiceName, healthgrpc.HealthCheckResponse_SERVING)
	healthgrpc.RegisterHealthServer(srv, healthSrv)
	reflection.Register(srv)

	return srv
}

func unaryLogging(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		logRPC(ctx, log, info.FullMethod, start, req, err)
		return resp, err
	}
}

func streamLogging(log *slog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		start := time.Now()
		err := handler(srv, ss)
		logRPC(ss.Context(), log, info.FullMethod, start, nil, err)
		return err
	}
}

func unaryRecovery(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				logPanic(ctx, log, info.FullMethod, rec)
				err = status.Error(codes.Internal, "internal")
			}
		}()
		return handler(ctx, req)
	}
}

func streamRecovery(log *slog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
		defer func() {
			if rec := recover(); rec != nil {
				logPanic(ss.Context(), log, info.FullMethod, rec)
				err = status.Error(codes.Internal, "internal")
			}
		}()
		return handler(srv, ss)
	}
}

func logRPC(ctx context.Context, log *slog.Logger, method string, start time.Time, req any, err error) {
	code := status.Code(err)
	attrs := []any{
		slog.String("service", ServiceName),
		slog.String("operation", method),
		slog.String("result", code.String()),
		slog.Int64("duration_us", time.Since(start).Microseconds()),
	}
	if id := requestID(ctx); id != "" {
		attrs = append(attrs, slog.String("request_id", id))
	}
	if resolve, ok := req.(*identityv1.ResolveIdentityRequest); ok {
		attrs = append(attrs, slog.Int64("telegram_user_id", resolve.GetTelegramUserId()))
	}
	if err == nil {
		log.DebugContext(ctx, "rpc completed", attrs...)
		return
	}

	level := slog.LevelWarn
	category := "client_error"
	if serverFault(code) {
		level = slog.LevelError
		category = "server_error"
	}
	attrs = append(attrs, slog.String("error_category", category))
	log.Log(ctx, level, "rpc failed", attrs...)
}

func logPanic(ctx context.Context, log *slog.Logger, method string, rec any) {
	log.ErrorContext(ctx, "rpc panic",
		slog.String("service", ServiceName),
		slog.String("operation", method),
		slog.String("error_category", "panic"),
		slog.Any("error", rec),
		slog.String("stack", string(debug.Stack())),
	)
}

func serverFault(code codes.Code) bool {
	switch code {
	case codes.Internal, codes.Unknown, codes.Unavailable, codes.DataLoss:
		return true
	default:
		return false
	}
}

func requestID(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	for _, key := range []string{"x-request-id", "x-correlation-id"} {
		values := md.Get(key)
		if len(values) > 0 && values[0] != "" {
			return values[0]
		}
	}
	return ""
}
