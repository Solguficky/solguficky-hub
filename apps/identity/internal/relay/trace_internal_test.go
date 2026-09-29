package relay

import (
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const requestTraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

func recordedRelay() (*Relay, *tracetest.SpanRecorder) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	return New(nil, nil, nil, 0, WithTracerProvider(provider)), recorder
}

// Спан публикации — корень своего трейса со ссылкой на спан запроса, а не его
// потомок: даже если тик идёт внутри чужого спана, трейс запроса он не продолжает.
func TestPublishSpanLinksToRequestTrace(t *testing.T) {
	t.Parallel()

	r, recorder := recordedRelay()
	outerCtx, outer := sdktrace.NewTracerProvider().Tracer("test").Start(t.Context(), "outer")
	defer outer.End()

	_, span := r.startPublishSpan(outerCtx, outbox.Record{
		EventID: "e1", Occasion: outbox.RoleGranted, TraceParent: requestTraceParent,
	})
	span.End()

	got := recorder.Ended()[0]
	if got.Parent().IsValid() {
		t.Fatalf("parent: got %s, want a root span", got.Parent().SpanID())
	}
	if got.SpanKind() != trace.SpanKindProducer || got.Name() != "publish events.identity.role_granted" {
		t.Fatalf("span: got %s %q", got.SpanKind(), got.Name())
	}
	links := got.Links()
	if len(links) != 1 ||
		links[0].SpanContext.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		links[0].SpanContext.SpanID().String() != "00f067aa0ba902b7" {
		t.Fatalf("links: got %v", links)
	}
}

// Строка без контекста трассировки публикуется со спаном без ссылки.
func TestPublishSpanWithoutTraceParentHasNoLink(t *testing.T) {
	t.Parallel()

	r, recorder := recordedRelay()
	_, span := r.startPublishSpan(t.Context(), outbox.Record{EventID: "e1", Occasion: outbox.ProfileRegistered})
	span.End()

	if links := recorder.Ended()[0].Links(); len(links) != 0 {
		t.Fatalf("links: got %d want 0", len(links))
	}
}
