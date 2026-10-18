package migrations

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel/codes"
	semconv "go.opentelemetry.io/otel/semconv/v1.41.0"
	"go.opentelemetry.io/otel/trace"
)

// tracerName — имя инструментирования в спанах PostgreSQL.
const tracerName = "github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"

// queryTracer открывает спан на запрос к PostgreSQL, но только внутри уже
// открытого спана. Корневых спанов он не рождает: тик релея, пробы health и
// миграции на старте ходят в базу по таймеру, и каждый их запрос иначе стал бы
// отдельным трейсом, за которыми трейс запроса не найти.
//
// Параметры запроса в спан не пишутся: в них Telegram user id и ники, а это
// персональные данные (logging.md). Текст запроса пишется — он параметризован и
// значений не несёт. Отказ пишется кодом SQLSTATE, а не текстом ошибки: Detail
// ошибки PostgreSQL повторяет значения строки.
type queryTracer struct {
	tracer trace.Tracer
}

// querySpanKey — ключ спана запроса, открытого TraceQueryStart.
type querySpanKey struct{}

func newQueryTracer(tp trace.TracerProvider) *queryTracer {
	return &queryTracer{tracer: tp.Tracer(tracerName)}
}

func (t *queryTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !trace.SpanContextFromContext(ctx).IsValid() {
		return ctx
	}
	operation := operationName(data.SQL)
	ctx, span := t.tracer.Start(ctx, operation,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.DBSystemNamePostgreSQL,
			semconv.DBOperationName(operation),
			semconv.DBQueryText(strings.TrimSpace(data.SQL)),
		))
	return context.WithValue(ctx, querySpanKey{}, span)
}

func (*queryTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	// Спан берётся по своему ключу, а не SpanFromContext: без родителя старт
	// спана не открыл, и в ctx лежит чужой спан вызывающего — закрыть его здесь
	// значило бы оборвать RPC на первом же запросе.
	span, ok := ctx.Value(querySpanKey{}).(trace.Span)
	if !ok {
		return
	}
	if data.Err != nil {
		code := errorCode(data.Err)
		span.SetAttributes(semconv.ErrorTypeKey.String(code))
		span.SetStatus(codes.Error, code)
	}
	span.End()
}

// operationName — первое слово запроса: SELECT, INSERT, begin. Имя спана по
// нему держит кардинальность низкой, а текст целиком лежит атрибутом.
func operationName(sql string) string {
	fields := strings.Fields(sql)
	if len(fields) == 0 {
		return "postgresql"
	}
	return strings.ToUpper(fields[0])
}

// errorCode — SQLSTATE ошибки PostgreSQL либо имя типа прочего отказа.
func errorCode(err error) string {
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok {
		return pgErr.Code
	}
	return semconv.ErrorType(err).Value.AsString()
}
