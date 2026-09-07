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

// logText отдаёт границе операцию и распознанную причину, но не текст самой
// ошибки. Драйвер печатает в нём то, на чём отказ произошёл: PostgreSQL — значения
// строки (для профиля это ник Telegram), уровень соединения — адрес и строку
// подключения с паролем. logging.md запрещает и пользовательский ввод, и
// connection strings с секретами, а перечислить заранее всё, что окажется в
// произвольной внутренней ошибке, нельзя. Поэтому текст не пересказывается:
// граница печатает то, что распознала.
func (e *internalError) logText() string {
	return e.op + ": " + causeText(e.err)
}

// causeText называет причину отказа хранилища значениями, которые сервис задал
// сам. У PostgreSQL это SQLSTATE и имя ограничения: они отвечают, что именно
// случилось, и пользовательских данных не несут. Отмена и дедлайн распознаются
// отдельно, потому что отличают чужой отказ от своего. Остальное сводится к типу
// корневой ошибки — он называет слой, на котором отказ родился, и состоит из
// имён пакета и типа, а не из данных.
func causeText(err error) string {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		text := "postgres sqlstate " + pgErr.Code
		if pgErr.ConstraintName != "" {
			text += ", constraint " + pgErr.ConstraintName
		}
		return text
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline exceeded"
	case errors.Is(err, context.Canceled):
		return "canceled"
	default:
		return fmt.Sprintf("%T", rootCause(err))
	}
}

func rootCause(err error) error {
	for {
		next := errors.Unwrap(err)
		if next == nil {
			return err
		}
		err = next
	}
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
		logRPC(ctx, log, info.FullMethod, start, resp, err)
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

const (
	resultOK    = "ok"
	resultError = "error"
)

func logRPC(ctx context.Context, log *slog.Logger, method string, start time.Time, resp any, err error) {
	result := resultOK
	if err != nil {
		result = resultError
	}
	attrs := []any{
		slog.String("service", ServiceName),
		slog.String("operation", method),
		slog.String("result", result),
		slog.Int64("duration_us", time.Since(start).Microseconds()),
		slog.String("grpc_code", status.Code(err).String()),
	}
	if id := requestID(ctx); id != "" {
		attrs = append(attrs, slog.String("request_id", id))
	}
	if useCase := incomingMetadata(ctx, "x-use-case"); useCase != "" {
		attrs = append(attrs, slog.String("use_case", useCase))
	}
	// Запись границы берёт идентификатор из ответа, а не из запроса: Telegram
	// user id и ник — персональные данные, а не ключ поиска, и внутри продукта
	// человека называет только внутренний идентификатор (logging.md, раздел
	// «Персональные данные»). У отказа ответа нет, поэтому там остаётся каркас
	// с `request_id` — по нему запись и связывается с вызовом бота.
	if resolved, ok := resp.(*identityv1.ResolveIdentityResponse); ok && resolved.GetIdentityId() != "" {
		attrs = append(attrs, slog.String("identity_id", resolved.GetIdentityId()))
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

func serverFault(code codes.Code) bool {
	switch code {
	case codes.Internal, codes.Unknown, codes.Unavailable, codes.DataLoss:
		return true
	default:
		return false
	}
}

func requestID(ctx context.Context) string {
	return incomingMetadata(ctx, "x-request-id", "x-correlation-id")
}

func incomingMetadata(ctx context.Context, keys ...string) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	for _, key := range keys {
		values := md.Get(key)
		if len(values) > 0 && values[0] != "" {
			return values[0]
		}
	}
	return ""
}
