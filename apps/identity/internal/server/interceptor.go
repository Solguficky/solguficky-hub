package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
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
		logRPC(ctx, log, info.FullMethod, start, req, resp, err)
		return resp, err
	}
}

func streamLogging(log *slog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		start := time.Now()
		err := handler(srv, ss)
		logRPC(ss.Context(), log, info.FullMethod, start, nil, nil, err)
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

	failureAuthorization         = "authorization"
	failureInvariant             = "invariant"
	failureDependencyUnavailable = "dependency_unavailable"
	failureTimeout               = "timeout"
	failureUnexpected            = "unexpected"
)

var failureCounter = mustFailureCounter()

func mustFailureCounter() metric.Int64Counter {
	counter, err := otel.Meter("solguficky.failures").Int64Counter(
		"solguficky.failures",
		metric.WithDescription("Operations rejected or failed, grouped by failure category"),
	)
	if err != nil {
		panic(err)
	}
	return counter
}

func logRPC(ctx context.Context, log *slog.Logger, method string, start time.Time, req, resp any, err error) {
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
	if useCase := incomingUseCase(ctx, method); useCase != "" {
		attrs = append(attrs, slog.String("use_case", useCase))
	}
	// Запись границы называет человека только внутренним идентификатором:
	// Telegram user id и ник — персональные данные, а не ключ поиска (logging.md,
	// раздел «Персональные данные»). У отказа ResolveIdentity ответа нет, поэтому
	// там остаётся каркас с `request_id` — по нему запись и связывается с вызовом
	// бота.
	if id := loggedIdentityID(req, resp); id != "" {
		attrs = append(attrs, slog.String("identity_id", id))
	}
	if err == nil {
		log.DebugContext(ctx, "rpc completed", attrs...)
		return
	}

	if panicErr, ok := errors.AsType[*panicError](err); ok {
		countFailure(ctx, failureUnexpected)
		attrs = append(attrs,
			slog.String("error_category", failureUnexpected),
			slog.Any("error", panicErr.value),
			slog.String("stack", string(panicErr.stack)),
		)
		log.ErrorContext(ctx, "rpc panic", attrs...)
		return
	}

	level := slog.LevelWarn
	category := failureCategory(err)
	if serverFault(status.Code(err)) {
		level = slog.LevelError
	}
	countFailure(ctx, category)
	attrs = append(attrs, slog.String("error_category", category), slog.String("error", errorText(err)))
	log.Log(ctx, level, "rpc failed", attrs...)
}

// loggedIdentityID называет человека в записи границы. У ResolveIdentity
// идентификатор есть только в ответе. У ResolveTelegramUserId он приходит в
// запросе, а ответ несёт Telegram user id, которому в логе не место; запрос
// читается и на отказе, чтобы NOT_FOUND и FAILED_PRECONDITION связывались с
// профилем. CheckGlobalRole читается так же: его отказ NOT_FOUND должен
// называть профиль, а ответ несёт только вердикт. Строка из запроса — ввод вызывающего, поэтому в запись идёт только
// каноническая форма UUID: произвольный текст границу не проходит.
func loggedIdentityID(req, resp any) string {
	if resolved, ok := resp.(*identityv1.ResolveIdentityResponse); ok {
		return resolved.GetIdentityId()
	}
	var raw string
	switch lookup := req.(type) {
	case *identityv1.ResolveTelegramUserIdRequest:
		raw = lookup.GetIdentityId()
	case *identityv1.CheckGlobalRoleRequest:
		raw = lookup.GetIdentityId()
	default:
		return ""
	}
	if id, err := canonicalIdentityID(raw); err == nil {
		return id
	}
	return ""
}

func countFailure(ctx context.Context, category string) {
	failureCounter.Add(ctx, 1, metric.WithAttributes(
		attribute.String("service", ServiceName),
		attribute.String("error_category", category),
	))
}

func failureCategory(err error) string {
	if _, ok := errors.AsType[*internalError](err); ok {
		if errors.Is(err, context.DeadlineExceeded) {
			return failureTimeout
		}
		return failureDependencyUnavailable
	}
	switch status.Code(err) {
	case codes.PermissionDenied, codes.Unauthenticated:
		return failureAuthorization
	case codes.InvalidArgument, codes.FailedPrecondition, codes.Aborted, codes.AlreadyExists, codes.NotFound, codes.OutOfRange:
		return failureInvariant
	case codes.DeadlineExceeded:
		return failureTimeout
	case codes.Unavailable:
		return failureDependencyUnavailable
	default:
		return failureUnexpected
	}
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

func incomingUseCase(ctx context.Context, method string) string {
	if strings.HasPrefix(method, "/grpc.health.v1.Health/") {
		return ""
	}
	return incomingMetadata(ctx, "x-use-case")
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
