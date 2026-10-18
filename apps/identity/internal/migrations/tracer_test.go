package migrations

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

const insertSQL = `
INSERT INTO profiles (telegram_user_id, nickname) VALUES ($1, $2)`

func newRecordedTracer() (*queryTracer, *tracetest.SpanRecorder, *sdktrace.TracerProvider) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	return newQueryTracer(provider), recorder, provider
}

// Запрос внутри спана RPC даёт дочерний спан с текстом запроса и без его
// параметров: в них Telegram user id и ник.
func TestQueryInsideSpanRecordsChildWithoutArguments(t *testing.T) {
	t.Parallel()

	tracer, recorder, provider := newRecordedTracer()
	parentCtx, parent := provider.Tracer("test").Start(t.Context(), "rpc")

	ctx := tracer.TraceQueryStart(parentCtx, nil, pgx.TraceQueryStartData{
		SQL: insertSQL, Args: []any{int64(424242), "secret_nick"},
	})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("ended spans: got %d want 1 (the parent must stay open)", len(spans))
	}
	span := spans[0]
	if span.Name() != "INSERT" || span.Parent().SpanID() != parent.SpanContext().SpanID() {
		t.Fatalf("span: got %q under %s", span.Name(), span.Parent().SpanID())
	}
	for _, kv := range span.Attributes() {
		if value := kv.Value.String(); value == "424242" || value == "secret_nick" {
			t.Fatalf("attribute %s carries a query argument: %s", kv.Key, value)
		}
	}
	if !parent.IsRecording() {
		t.Fatal("query end closed the parent span")
	}
	parent.End()
}

// Вне спана запрос следа не оставляет: тик релея и миграции ходят в базу по
// таймеру, и каждый их запрос иначе стал бы отдельным трейсом.
func TestQueryOutsideSpanRecordsNothing(t *testing.T) {
	t.Parallel()

	tracer, recorder, _ := newRecordedTracer()
	ctx := tracer.TraceQueryStart(context.Background(), nil, pgx.TraceQueryStartData{SQL: insertSQL})
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{})

	if spans := recorder.Ended(); len(spans) != 0 {
		t.Fatalf("spans: got %d want 0", len(spans))
	}
}

// Отказ пишется кодом SQLSTATE, а не текстом: Detail ошибки PostgreSQL
// повторяет значения строки.
func TestQueryFailureRecordsSQLStateOnly(t *testing.T) {
	t.Parallel()

	tracer, recorder, provider := newRecordedTracer()
	parentCtx, parent := provider.Tracer("test").Start(t.Context(), "rpc")
	defer parent.End()

	ctx := tracer.TraceQueryStart(parentCtx, nil, pgx.TraceQueryStartData{SQL: insertSQL})
	pgErr := &pgconn.PgError{Code: "23505", Message: "duplicate key", Detail: "Key (nickname)=(secret_nick) already exists."}
	tracer.TraceQueryEnd(ctx, nil, pgx.TraceQueryEndData{Err: errors.Join(pgErr)})

	span := recorder.Ended()[0]
	if span.Status().Code != codes.Error || span.Status().Description != "23505" {
		t.Fatalf("status: got %v %q", span.Status().Code, span.Status().Description)
	}
	if len(span.Events()) != 0 {
		t.Fatalf("events: got %d want 0 — the error text must not be recorded", len(span.Events()))
	}
}
