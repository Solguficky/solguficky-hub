package server

import (
	"context"

	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc"
	"go.opentelemetry.io/contrib/instrumentation/google.golang.org/grpc/otelgrpc/filters"
	"go.opentelemetry.io/otel/attribute"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/stats"
)

// requestIDAttribute — ключ request_id в спане. Он совпадает с полем лога,
// чтобы трейс находился по тому же значению, что и запись границы.
const requestIDAttribute = "request_id"

// tracingHandler открывает серверный спан на каждый RPC, продолжая трейс из
// входящего traceparent. Stats handler срабатывает раньше interceptors, поэтому
// спан уже лежит в ctx, когда пишется запись границы, и мост логов ставит в неё
// trace_id.
//
// Пробы grpc.health.v1 не трассируются: их шлёт оркестратор каждые несколько
// секунд, и трейс вызова бота потерялся бы среди них. Метрики rpc.server.*
// инструментирования выключены: это инструментирование трейсов, и новые серии
// метрик вместе с ним не заводятся. Тела сообщений в спан не попадают: WithMessageEvents не включён,
// а запрос ResolveIdentity несёт Telegram user id и ник.
func tracingHandler(tp trace.TracerProvider) stats.Handler {
	return otelgrpc.NewServerHandler(
		otelgrpc.WithTracerProvider(tp),
		otelgrpc.WithPropagators(propagation.TraceContext{}),
		otelgrpc.WithMeterProvider(metricnoop.NewMeterProvider()),
		otelgrpc.WithFilter(filters.Not(filters.HealthCheck())),
	)
}

func unaryRequestIDSpan() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		annotateRequestID(ctx)
		return handler(ctx, req)
	}
}

func streamRequestIDSpan() grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, _ *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		annotateRequestID(ss.Context())
		return handler(srv, ss)
	}
}

// annotateRequestID пишет request_id вызывающего атрибутом серверного спана.
// Без заголовка атрибута нет: своего id сервис не рождает.
func annotateRequestID(ctx context.Context) {
	if id := requestID(ctx); id != "" {
		trace.SpanFromContext(ctx).SetAttributes(attribute.String(requestIDAttribute, id))
	}
}
