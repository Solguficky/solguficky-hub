package server_test

import (
	"context"
	"database/sql"
	"log/slog"
	"net"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"
)

const (
	callerTraceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	callerSpanID  = "00f067aa0ba902b7"
	callerParent  = "00-" + callerTraceID + "-" + callerSpanID + "-01"
)

// Вызов с traceparent продолжает трейс вызывающего, а не начинает новый:
// серверный спан лежит в том же трейсе дочерним к спану клиента и несёт
// request_id, по которому его находят из записи границы.
func TestServerSpanContinuesCallerTraceWithRequestID(t *testing.T) {
	t.Parallel()

	recorder, conn := newTracedConn(t)
	ctx := metadata.AppendToOutgoingContext(t.Context(),
		"traceparent", callerParent, "x-request-id", "req-42")
	// Пустой запрос отвергается валидацией до базы; спан пишется и на отказе.
	_, _ = identityv1.NewIdentityServiceClient(conn).ResolveIdentity(ctx, &identityv1.ResolveIdentityRequest{})

	span := onlyServerSpan(t, recorder)
	if got := span.SpanContext().TraceID().String(); got != callerTraceID {
		t.Fatalf("trace id: got %s want %s", got, callerTraceID)
	}
	if got := span.Parent().SpanID().String(); got != callerSpanID || !span.Parent().IsRemote() {
		t.Fatalf("parent: got %s remote=%v want %s remote", got, span.Parent().IsRemote(), callerSpanID)
	}
	if got := attribute(span, "request_id"); got != "req-42" {
		t.Fatalf("request_id: got %q want req-42", got)
	}
}

// Без x-request-id атрибута нет: своего id сервис не рождает.
func TestServerSpanWithoutRequestIDHasNoAttribute(t *testing.T) {
	t.Parallel()

	recorder, conn := newTracedConn(t)
	_, _ = identityv1.NewIdentityServiceClient(conn).ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{})

	if got := attribute(onlyServerSpan(t, recorder), "request_id"); got != "" {
		t.Fatalf("request_id: got %q want none", got)
	}
}

// Пробы health спанов не рождают: оркестратор шлёт их каждые несколько секунд.
// Проверка идёт по начатым спанам: спан начинается до обработчика, то есть до
// ответа клиенту, и после ответа его отсутствие окончательно. Завершённые спаны
// сервер закрывает уже после ответа, и их пустой список ничего не доказывал бы.
func TestHealthCheckIsNotTraced(t *testing.T) {
	t.Parallel()

	recorder, conn := newTracedConn(t)
	ctx := metadata.AppendToOutgoingContext(t.Context(), "traceparent", callerParent)
	if _, err := healthgrpc.NewHealthClient(conn).Check(ctx, &healthgrpc.HealthCheckRequest{}); err != nil {
		t.Fatal(err)
	}

	if spans := recorder.Started(); len(spans) != 0 {
		t.Fatalf("spans: got %d want 0", len(spans))
	}
}

// onlyServerSpan ждёт завершённый серверный спан: сервер закрывает его после
// того, как ответ ушёл клиенту, поэтому сразу после вызова его может не быть.
func onlyServerSpan(t *testing.T, recorder *tracetest.SpanRecorder) sdktrace.ReadOnlySpan {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var server []sdktrace.ReadOnlySpan
		for _, span := range recorder.Ended() {
			if span.SpanKind() == trace.SpanKindServer {
				server = append(server, span)
			}
		}
		if len(server) > 1 {
			t.Fatalf("server spans: got %d want 1", len(server))
		}
		if len(server) == 1 {
			return server[0]
		}
		if time.Now().After(deadline) {
			t.Fatal("server span was not recorded")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func attribute(span sdktrace.ReadOnlySpan, key string) string {
	for _, kv := range span.Attributes() {
		if string(kv.Key) == key {
			return kv.Value.AsString()
		}
	}
	return ""
}

func newTracedConn(t *testing.T) (*tracetest.SpanRecorder, *grpc.ClientConn) {
	t.Helper()

	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))

	lis := bufconn.Listen(1024 * 1024)
	t.Cleanup(func() { _ = lis.Close() })

	srv := server.New(slog.New(slog.DiscardHandler), new(sql.DB), "", server.NewTestCallers(t, ""), server.WithTracerProvider(provider))
	t.Cleanup(srv.Stop)
	go func() {
		_ = srv.Serve(lis)
	}()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		server.PresentDeclaredCaller(),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return recorder, conn
}
