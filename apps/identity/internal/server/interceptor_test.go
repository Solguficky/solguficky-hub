package server

import (
	"context"
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

func (c *capture) only(t *testing.T, msg string) slog.Record {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()

	var found []slog.Record
	for _, rec := range c.records {
		if rec.Message == msg {
			found = append(found, rec)
		}
	}
	if len(found) != 1 {
		t.Fatalf("records with message %q: got %d want 1", msg, len(found))
	}
	return found[0]
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

type panicStream struct{ grpc.ServerStream }

func (panicStream) Context() context.Context { return context.Background() }

func TestUnaryRecoveryConvertsPanicToInternalWithStack(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: "/identity.v1.IdentityService/ResolveIdentity"}

	resp, err := unaryRecovery(slog.New(logs))(t.Context(), nil, info,
		func(context.Context, any) (any, error) { panic("boom") })
	if resp != nil {
		t.Fatalf("resp: got %v want nil", resp)
	}
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}

	rec := logs.only(t, "rpc panic")
	if rec.Level != slog.LevelError {
		t.Fatalf("level: got %s want %s", rec.Level, slog.LevelError)
	}
	stack := attrValue(t, rec, "stack").String()
	if !strings.Contains(stack, "TestUnaryRecoveryConvertsPanicToInternalWithStack") {
		t.Fatalf("stack does not reach the panicking frame: %q", stack)
	}
}

func TestStreamRecoveryConvertsPanicToInternal(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.StreamServerInfo{FullMethod: "/grpc.health.v1.Health/Watch"}

	err := streamRecovery(slog.New(logs))(nil, panicStream{}, info,
		func(any, grpc.ServerStream) error { panic("boom") })
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}
	attrValue(t, logs.only(t, "rpc panic"), "stack")
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

			rec := logs.only(t, "rpc failed")
			if rec.Level != tc.level {
				t.Fatalf("level: got %s want %s", rec.Level, tc.level)
			}
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
	info := &grpc.UnaryServerInfo{FullMethod: "/identity.v1.IdentityService/ResolveIdentity"}
	ctx := metadata.NewIncomingContext(t.Context(), metadata.Pairs("x-request-id", "req-42"))

	_, err := unaryLogging(slog.New(logs))(ctx, &identityv1.ResolveIdentityRequest{TelegramUserId: 7}, info,
		func(context.Context, any) (any, error) {
			time.Sleep(2 * time.Millisecond)
			return &identityv1.ResolveIdentityResponse{}, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	rec := logs.only(t, "rpc completed")
	if rec.Level != slog.LevelDebug {
		t.Fatalf("level: got %s want %s", rec.Level, slog.LevelDebug)
	}

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
