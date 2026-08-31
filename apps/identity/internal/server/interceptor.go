package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// panicError переносит панику от recovery к logging, не записывая её сам.
// Клиенту он представляется через GRPCStatus как Internal, а интерцептору
// логирования отдаёт исходное значение и стек. Так у записи об отказе
// остаётся единственный автор: logging.md требует логировать неожиданный
// отказ один раз на boundary.
type panicError struct {
	value any
	stack []byte
}

func (e *panicError) Error() string { return fmt.Sprintf("panic: %v", e.value) }

func (e *panicError) GRPCStatus() *status.Status { return status.New(codes.Internal, "internal") }

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

func unaryRecovery() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (resp any, err error) {
		defer func() {
			if rec := recover(); rec != nil {
				resp, err = nil, &panicError{value: rec, stack: debug.Stack()}
			}
		}()
		return handler(ctx, req)
	}
}

func streamRecovery() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
		defer func() {
			if rec := recover(); rec != nil {
				err = &panicError{value: rec, stack: debug.Stack()}
			}
		}()
		return handler(srv, ss)
	}
}

func logRPC(ctx context.Context, log *slog.Logger, method string, start time.Time, req any, err error) {
	attrs := []any{
		slog.String("service", ServiceName),
		slog.String("operation", method),
		slog.String("result", status.Code(err).String()),
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

	if panicErr, ok := errors.AsType[*panicError](err); ok {
		attrs = append(attrs,
			slog.String("error_category", "panic"),
			slog.Any("error", panicErr.value),
			slog.String("stack", string(panicErr.stack)),
		)
		log.ErrorContext(ctx, "rpc panic", attrs...)
		return
	}

	level := slog.LevelWarn
	category := "client_error"
	if serverFault(status.Code(err)) {
		level = slog.LevelError
		category = "server_error"
	}
	attrs = append(attrs, slog.String("error_category", category), slog.Any("error", err))
	log.Log(ctx, level, "rpc failed", attrs...)
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
