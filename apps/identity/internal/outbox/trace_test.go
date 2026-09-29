package outbox_test

import (
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// Контекст спана, записанный в строку, возвращается ссылкой на тот же спан.
func TestTraceParentRoundTripsToLink(t *testing.T) {
	t.Parallel()

	ctx, span := sdktrace.NewTracerProvider().Tracer("test").Start(t.Context(), "rpc")
	defer span.End()

	record := outbox.Record{TraceParent: outbox.TraceParent(ctx)}
	link, ok := record.Link()
	if !ok {
		t.Fatalf("link from %q: missing", record.TraceParent)
	}
	if link.SpanContext.TraceID() != span.SpanContext().TraceID() ||
		link.SpanContext.SpanID() != span.SpanContext().SpanID() {
		t.Fatalf("link: got %s/%s want %s/%s",
			link.SpanContext.TraceID(), link.SpanContext.SpanID(),
			span.SpanContext().TraceID(), span.SpanContext().SpanID())
	}
}

// Вне спана колонка остаётся пустой, а строка без контекста или с мусором
// публикуется без ссылки, а не отказом.
func TestNoSpanMeansNoLink(t *testing.T) {
	t.Parallel()

	if got := outbox.TraceParent(t.Context()); got != "" {
		t.Fatalf("traceparent outside span: got %q", got)
	}
	for _, value := range []string{"", "not-a-traceparent", "00-00000000000000000000000000000000-0000000000000000-01"} {
		if _, ok := (outbox.Record{TraceParent: value}).Link(); ok {
			t.Fatalf("link from %q: want none", value)
		}
	}
}

// Контекст вызывающего без своего записываемого спана — экспорт выключен или
// сэмплер отбросил спан — в колонку не попадает: ссылка вела бы не на спан
// Identity.
func TestTraceParentNeedsARecordingSpan(t *testing.T) {
	t.Parallel()

	remote := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    trace.TraceID{0x4b, 0xf9},
		SpanID:     trace.SpanID{0x00, 0xf0},
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
	callerOnly := trace.ContextWithRemoteSpanContext(t.Context(), remote)
	if got := outbox.TraceParent(callerOnly); got != "" {
		t.Fatalf("caller context only: got %q want empty", got)
	}

	unsampled := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.NeverSample()))
	ctx, span := unsampled.Tracer("test").Start(t.Context(), "rpc")
	defer span.End()
	if got := outbox.TraceParent(ctx); got != "" {
		t.Fatalf("unsampled span: got %q want empty", got)
	}
}
