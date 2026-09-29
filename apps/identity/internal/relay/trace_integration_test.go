//go:build integration

package relay_test

import (
	"context"
	"database/sql"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/relay"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// Событие, записанное внутри запроса, публикуется спаном со ссылкой на трейс
// этого запроса. Запросы тика к базе вне спана публикации следа не оставляют, а
// отметка публикации — дочерний спан публикации.
func TestPublishSpanLinksToTheRequestThatWroteTheEvent(t *testing.T) {
	t.Parallel()

	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	db := tracedDB(t, provider)

	ctx, request := provider.Tracer("test").Start(t.Context(), "request")
	registerInRequest(ctx, t, db, "0198f2a4-7c1e-7d3a-9b21-4f8e12ab4101")
	request.End()
	requestSpans := len(recorder.Ended())

	report := mustTick(t, relay.New(db, &fakePublisher{}, discard(), 0, relay.WithTracerProvider(provider)))
	if report.Published != 1 {
		t.Fatalf("tick: %+v", report)
	}

	tickSpans := recorder.Ended()[requestSpans:]
	publish := producerSpan(t, tickSpans)
	links := publish.Links()
	if len(links) != 1 || links[0].SpanContext.TraceID() != request.SpanContext().TraceID() {
		t.Fatalf("publish links: got %v want the request trace %s", links, request.SpanContext().TraceID())
	}
	for _, span := range tickSpans {
		if span.SpanContext().TraceID() != publish.SpanContext().TraceID() {
			t.Fatalf("tick span %q outside the publish trace: queries without a parent must not be traced", span.Name())
		}
	}
	if len(tickSpans) < 2 {
		t.Fatalf("tick spans: got %d, want the publish span and its publication mark", len(tickSpans))
	}
}

func tracedDB(t *testing.T, provider trace.TracerProvider) *sql.DB {
	t.Helper()
	db, err := migrations.Open(t.Context(), testdb.DSN(t), migrations.WithTracerProvider(provider))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return db
}

// registerInRequest регистрирует профиль так, как это делает RPC: изменение и
// событие одной транзакцией внутри спана запроса.
func registerInRequest(ctx context.Context, t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9501)`, identityID); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.ProfileRegistered, ""); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func producerSpan(t *testing.T, spans []sdktrace.ReadOnlySpan) sdktrace.ReadOnlySpan {
	t.Helper()
	for _, span := range spans {
		if span.SpanKind() == trace.SpanKindProducer {
			return span
		}
	}
	t.Fatalf("no publish span among %d spans", len(spans))
	return nil
}
