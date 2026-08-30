package server

import (
	"context"
	"log/slog"
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

func New(log *slog.Logger) *grpc.Server {
	if log == nil {
		log = slog.Default()
	}

	srv := grpc.NewServer(
		grpc.ChainUnaryInterceptor(
			recoveryInterceptor(log),
			loggingInterceptor(log),
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

func loggingInterceptor(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		code := status.Code(err)
		attrs := []any{
			slog.String("service", "identity"),
			slog.String("operation", info.FullMethod),
			slog.String("result", code.String()),
			slog.Int64("duration_ms", time.Since(start).Milliseconds()),
		}
		if id := requestID(ctx); id != "" {
			attrs = append(attrs, slog.String("request_id", id))
		}
		if resolve, ok := req.(*identityv1.ResolveIdentityRequest); ok {
			attrs = append(attrs, slog.Int64("telegram_user_id", resolve.GetTelegramUserId()))
		}
		if err != nil {
			attrs = append(attrs, slog.String("error_category", code.String()))
			if code == codes.InvalidArgument {
				log.WarnContext(ctx, "rpc failed", attrs...)
			} else {
				log.ErrorContext(ctx, "rpc failed", attrs...)
			}
			return resp, err
		}
		log.DebugContext(ctx, "rpc completed", attrs...)
		return resp, err
	}
}

func recoveryInterceptor(log *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				log.ErrorContext(ctx, "rpc panic",
					slog.String("service", "identity"),
					slog.String("operation", info.FullMethod),
					slog.String("error_category", "panic"),
					slog.Any("error", rec),
				)
				err = status.Error(codes.Internal, "internal")
			}
		}()
		return handler(ctx, req)
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
