package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/jackc/pgx/v5/pgconn"
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

type internalError struct {
	op  string
	err error
}

func internal(op string, err error) error {
	if err == nil {
		return nil
	}
	return &internalError{op: op, err: err}
}

func (e *internalError) Error() string { return e.op + ": " + e.err.Error() }

func (e *internalError) Unwrap() error { return e.err }

func (e *internalError) GRPCStatus() *status.Status { return status.New(codes.Internal, "internal") }

// logText отдаёт границе текст без значений строки. PostgreSQL печатает в
// message и detail то, на чём отказ произошёл, — для профиля это ник Telegram,
// а logging.md запрещает пускать пользовательский ввод в лог, включая поле
// error. Операция, SQLSTATE и имя ограничения отвечают, что именно случилось,
// и пользовательских данных не несут.
func (e *internalError) logText() string {
	var pgErr *pgconn.PgError
	if !errors.As(e.err, &pgErr) {
		return e.Error()
	}
	text := e.op + ": postgres sqlstate " + pgErr.Code
	if pgErr.ConstraintName != "" {
		text += ", constraint " + pgErr.ConstraintName
	}
	return text
}

// errorText выбирает текст отказа для записи границы: собственные статусы
// сервиса пишутся как есть, отказ хранилища — санитизированным.
func errorText(err error) string {
	if internalErr, ok := errors.AsType[*internalError](err); ok {
		return internalErr.logText()
	}
	return err.Error()
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
		slog.String("result", rpcResult(err)),
		slog.String("grpc_code", status.Code(err).String()),
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
	attrs = append(attrs, slog.String("error_category", category), slog.String("error", errorText(err)))
	log.Log(ctx, level, "rpc failed", attrs...)
}

// rpcResult держит `result` двузначным: logging.md требует в нём только `ok`
// либо `error`, а код транспорта — в собственном поле `grpc_code`. Иначе запрос
// «все отказы среза» собирается перечислением словаря кодов, разного у каждого
// транспорта.
func rpcResult(err error) string {
	if err == nil {
		return "ok"
	}
	return "error"
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
