package server

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type capture struct {
	mu      sync.Mutex
	records []slog.Record
}

func (c *capture) Enabled(context.Context, slog.Level) bool { return true }

func (c *capture) Handle(_ context.Context, rec slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = append(c.records, rec.Clone())
	return nil
}

func (c *capture) WithAttrs([]slog.Attr) slog.Handler { return c }

func (c *capture) WithGroup(string) slog.Handler { return c }

// sole требует, чтобы вызов оставил ровно одну запись, и возвращает её. Именно
// счётчик, а не поиск по сообщению: logging.md разрешает одну запись на отказ,
// и лишняя запись должна валить тест, а не проходить мимо него.
func (c *capture) sole(t *testing.T) slog.Record {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.records) != 1 {
		got := make([]string, 0, len(c.records))
		for _, rec := range c.records {
			got = append(got, rec.Level.String()+" "+rec.Message)
		}
		t.Fatalf("records: got %d %v want 1", len(c.records), got)
	}
	return c.records[0]
}

func attrValue(t *testing.T, rec slog.Record, key string) slog.Value {
	t.Helper()

	var value slog.Value
	found := false
	rec.Attrs(func(a slog.Attr) bool {
		if a.Key == key {
			value, found = a.Value, true
			return false
		}
		return true
	})
	if !found {
		t.Fatalf("attribute %q missing from record %q", key, rec.Message)
	}
	return value
}

func assertRecord(t *testing.T, rec slog.Record, level slog.Level, message string) {
	t.Helper()

	if rec.Level != level || rec.Message != message {
		t.Fatalf("record: got %s %q want %s %q", rec.Level, rec.Message, level, message)
	}
}

const resolveMethod = "/identity.v1.IdentityService/ResolveIdentity"

type panicStream struct{ grpc.ServerStream }

func (panicStream) Context() context.Context { return context.Background() }

// chainUnary и chainStream собирают ту же пару и в том же порядке, что и New:
// logging снаружи, recovery внутри. Тест собранной цепочки отличает дефект
// композиции от дефекта отдельного интерцептора.
func chainUnary(log *slog.Logger, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
	return unaryLogging(log)(context.Background(), nil, info,
		func(ctx context.Context, req any) (any, error) {
			return unaryRecovery()(ctx, req, info, handler)
		})
}

func chainStream(log *slog.Logger, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
	return streamLogging(log)(nil, panicStream{}, info,
		func(srv any, ss grpc.ServerStream) error {
			return streamRecovery()(srv, ss, info, handler)
		})
}

func TestUnaryChainLogsPanicOnce(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}

	resp, err := chainUnary(slog.New(logs), info,
		func(context.Context, any) (any, error) { panic("boom") })
	if resp != nil {
		t.Fatalf("resp: got %v want nil", resp)
	}
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelError, "rpc panic")
	if got := attrValue(t, rec, "error_category").String(); got != "panic" {
		t.Fatalf("error_category: got %q want %q", got, "panic")
	}
	if got := attrValue(t, rec, "result").String(); got != codes.Internal.String() {
		t.Fatalf("result: got %q want %q", got, codes.Internal)
	}
	if got := attrValue(t, rec, "operation").String(); got != info.FullMethod {
		t.Fatalf("operation: got %q want %q", got, info.FullMethod)
	}
	if stack := attrValue(t, rec, "stack").String(); !strings.Contains(stack, "TestUnaryChainLogsPanicOnce") {
		t.Fatalf("stack does not reach the panicking frame: %q", stack)
	}
}

func TestStreamChainLogsPanicOnce(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.StreamServerInfo{FullMethod: "/grpc.health.v1.Health/Watch"}

	err := chainStream(slog.New(logs), info,
		func(any, grpc.ServerStream) error { panic("boom") })
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelError, "rpc panic")
	attrValue(t, rec, "stack")
}

func TestUnaryChainLogsInternalWithoutLeakingCause(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	cause := errors.New("postgres://user:pass@127.0.0.1:5432/identity")

	_, err := chainUnary(slog.New(logs), info,
		func(context.Context, any) (any, error) {
			return nil, internal(cause)
		})
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}
	if got := status.Convert(err).Message(); got != "internal" {
		t.Fatalf("message: got %q want %q", got, "internal")
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelError, "rpc failed")
	if got := attrValue(t, rec, "error").String(); !strings.Contains(got, cause.Error()) {
		t.Fatalf("log error: got %q want to contain %q", got, cause.Error())
	}
}

func TestUnaryChainLogsFailureOnce(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}

	_, err := chainUnary(slog.New(logs), info,
		func(context.Context, any) (any, error) {
			return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
		})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
	}
	assertRecord(t, logs.sole(t), slog.LevelWarn, "rpc failed")
}

func TestUnaryChainLogsSuccessOnce(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}

	_, err := chainUnary(slog.New(logs), info,
		func(context.Context, any) (any, error) { return &identityv1.ResolveIdentityResponse{}, nil })
	if err != nil {
		t.Fatal(err)
	}
	assertRecord(t, logs.sole(t), slog.LevelDebug, "rpc completed")
}

func TestStreamLoggingRecordsOutcome(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		err     error
		level   slog.Level
		message string
		result  codes.Code
	}{
		{name: "success", err: nil, level: slog.LevelDebug, message: "rpc completed", result: codes.OK},
		{
			name:    "unknown service",
			err:     status.Error(codes.NotFound, "unknown service"),
			level:   slog.LevelWarn,
			message: "rpc failed",
			result:  codes.NotFound,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logs := &capture{}
			info := &grpc.StreamServerInfo{FullMethod: "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo"}
			err := streamLogging(slog.New(logs))(nil, panicStream{}, info,
				func(any, grpc.ServerStream) error { return tc.err })
			if status.Code(err) != tc.result {
				t.Fatalf("code: got %v want %s", err, tc.result)
			}

			rec := logs.sole(t)
			assertRecord(t, rec, tc.level, tc.message)
			if got := attrValue(t, rec, "operation").String(); got != info.FullMethod {
				t.Fatalf("operation: got %q want %q", got, info.FullMethod)
			}
		})
	}
}

func TestUnaryLoggingLevelByCode(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		code     codes.Code
		level    slog.Level
		category string
	}{
		{name: "invalid argument", code: codes.InvalidArgument, level: slog.LevelWarn, category: "client_error"},
		{name: "unknown health service", code: codes.NotFound, level: slog.LevelWarn, category: "client_error"},
		{name: "failed precondition", code: codes.FailedPrecondition, level: slog.LevelWarn, category: "client_error"},
		{name: "internal", code: codes.Internal, level: slog.LevelError, category: "server_error"},
		{name: "unavailable", code: codes.Unavailable, level: slog.LevelError, category: "server_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logs := &capture{}
			info := &grpc.UnaryServerInfo{FullMethod: "/grpc.health.v1.Health/Check"}
			_, err := unaryLogging(slog.New(logs))(t.Context(), nil, info,
				func(context.Context, any) (any, error) { return nil, status.Error(tc.code, "failed") })
			if status.Code(err) != tc.code {
				t.Fatalf("code: got %v want %s", err, tc.code)
			}

			rec := logs.sole(t)
			assertRecord(t, rec, tc.level, "rpc failed")
			if got := attrValue(t, rec, "error_category").String(); got != tc.category {
				t.Fatalf("error_category: got %q want %q", got, tc.category)
			}
			if got := attrValue(t, rec, "result").String(); got != tc.code.String() {
				t.Fatalf("result: got %q want %q", got, tc.code)
			}
		})
	}
}

func TestUnaryLoggingRecordsSuccess(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	ctx := metadata.NewIncomingContext(t.Context(), metadata.Pairs("x-request-id", "req-42"))

	_, err := unaryLogging(slog.New(logs))(ctx, &identityv1.ResolveIdentityRequest{TelegramUserId: 7}, info,
		func(context.Context, any) (any, error) {
			time.Sleep(2 * time.Millisecond)
			return &identityv1.ResolveIdentityResponse{}, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelDebug, "rpc completed")
	if got := attrValue(t, rec, "duration_us").Int64(); got < 1000 {
		t.Fatalf("duration_us: got %d want >= 1000", got)
	}
	if got := attrValue(t, rec, "request_id").String(); got != "req-42" {
		t.Fatalf("request_id: got %q want %q", got, "req-42")
	}
	if got := attrValue(t, rec, "telegram_user_id").Int64(); got != 7 {
		t.Fatalf("telegram_user_id: got %d want 7", got)
	}
}

func TestRequestIDFromMetadata(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		md   metadata.MD
		want string
	}{
		{name: "no incoming metadata", md: nil, want: ""},
		{name: "x-request-id", md: metadata.Pairs("x-request-id", "req-1"), want: "req-1"},
		{name: "x-correlation-id", md: metadata.Pairs("x-correlation-id", "corr-1"), want: "corr-1"},
		{name: "request id wins", md: metadata.Pairs("x-correlation-id", "corr-1", "x-request-id", "req-1"), want: "req-1"},
		{name: "empty value falls through", md: metadata.Pairs("x-request-id", "", "x-correlation-id", "corr-1"), want: "corr-1"},
		{name: "header case is normalised", md: metadata.Pairs("X-Request-Id", "req-1"), want: "req-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			ctx := t.Context()
			if tc.md != nil {
				ctx = metadata.NewIncomingContext(ctx, tc.md)
			}
			if got := requestID(ctx); got != tc.want {
				t.Fatalf("requestID: got %q want %q", got, tc.want)
			}
		})
	}
}
