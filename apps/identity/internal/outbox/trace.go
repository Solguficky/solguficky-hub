package outbox

import (
	"context"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

const traceParentHeader = "traceparent"

// TraceParent — заголовок W3C traceparent спана из ctx либо пустая строка, если
// записываемого спана нет. Пропагатор фиксированный, а не глобальный: формат
// колонки задаёт схема, и от настройки процесса он зависеть не должен.
//
// Условие — записываемый спан, а не просто контекст в ctx. Без экспорта
// провайдер no-op своих спанов не открывает и оставляет в ctx контекст
// вызывающего, а спан, отброшенный сэмплером, в бэкенд не уходит. В обоих
// случаях ссылка указывала бы не на спан Identity или в пустоту, поэтому
// колонка остаётся NULL.
func TraceParent(ctx context.Context) string {
	if !trace.SpanFromContext(ctx).IsRecording() {
		return ""
	}
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	return carrier.Get(traceParentHeader)
}

// Link — ссылка на спан запроса, записавшего строку. false — строка записана
// вне спана или до появления колонки: публикация идёт без ссылки.
func (r Record) Link() (trace.Link, bool) {
	if r.TraceParent == "" {
		return trace.Link{}, false
	}
	carrier := propagation.MapCarrier{traceParentHeader: r.TraceParent}
	sc := trace.SpanContextFromContext(propagation.TraceContext{}.Extract(context.Background(), carrier))
	if !sc.IsValid() {
		return trace.Link{}, false
	}
	return trace.Link{SpanContext: sc}, true
}
