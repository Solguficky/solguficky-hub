package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/jackc/pgx/v5/pgconn"
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

func hasAttr(rec slog.Record, key string) bool {
	found := false
	rec.Attrs(func(a slog.Attr) bool {
		if a.Key == key {
			found = true
			return false
		}
		return true
	})
	return found
}

func assertNoAttr(t *testing.T, rec slog.Record, key string) {
	t.Helper()
	rec.Attrs(func(a slog.Attr) bool {
		if a.Key == key {
			t.Fatalf("attribute %q present with %q, want omitted", key, a.Value)
			return false
		}
		return true
	})
}

type frameWant struct {
	result    string
	code      codes.Code
	operation string
	requestID string
	useCase   string
}

func assertFrame(t *testing.T, rec slog.Record, want frameWant) {
	t.Helper()
	assertRequiredAttrs(t, rec, want)
	assertCoreAttrs(t, rec, want)
	assertOptionalAttr(t, rec, "request_id", want.requestID)
	assertOptionalAttr(t, rec, "use_case", want.useCase)
	assertOutcomeAttrs(t, rec, want.result)
}

func assertRequiredAttrs(t *testing.T, rec slog.Record, want frameWant) {
	t.Helper()
	required := []string{"service", "operation", "result", "duration_us", "grpc_code"}
	if want.result == resultError {
		required = append(required, "error_category", "error")
	}
	for _, key := range required {
		if !hasAttr(rec, key) {
			t.Fatalf("attribute %q missing from record %q", key, rec.Message)
		}
	}
}

func assertCoreAttrs(t *testing.T, rec slog.Record, want frameWant) {
	t.Helper()
	if got := attrValue(t, rec, "service").String(); got != ServiceName {
		t.Fatalf("service: got %q want %q", got, ServiceName)
	}
	if got := attrValue(t, rec, "operation").String(); got != want.operation {
		t.Fatalf("operation: got %q want %q", got, want.operation)
	}
	if got := attrValue(t, rec, "result").String(); got != want.result {
		t.Fatalf("result: got %q want %q", got, want.result)
	}
	if got := attrValue(t, rec, "grpc_code").String(); got != want.code.String() {
		t.Fatalf("grpc_code: got %q want %q", got, want.code)
	}
}

func assertOptionalAttr(t *testing.T, rec slog.Record, key, want string) {
	t.Helper()
	if want == "" {
		assertNoAttr(t, rec, key)
		return
	}
	if got := attrValue(t, rec, key).String(); got != want {
		t.Fatalf("%s: got %q want %q", key, got, want)
	}
}

func assertOutcomeAttrs(t *testing.T, rec slog.Record, result string) {
	t.Helper()
	if result == resultOK {
		assertNoAttr(t, rec, "error_category")
		assertNoAttr(t, rec, "error")
		assertNoAttr(t, rec, "stack")
		return
	}
	if rec.Message != "rpc panic" {
		assertNoAttr(t, rec, "stack")
	}
}

func assertRecord(t *testing.T, rec slog.Record, level slog.Level, message string) {
	t.Helper()

	if rec.Level != level || rec.Message != message {
		t.Fatalf("record: got %s %q want %s %q", rec.Level, rec.Message, level, message)
	}
}

const resolveMethod = "/identity.v1.IdentityService/ResolveIdentity"

const resolvedIdentityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd"

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
	assertFrame(t, rec, frameWant{result: resultError, code: codes.Internal, operation: info.FullMethod})
	if got := attrValue(t, rec, "error_category").String(); got != failureUnexpected {
		t.Fatalf("error_category: got %q want %q", got, failureUnexpected)
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
	assertFrame(t, rec, frameWant{result: resultError, code: codes.Internal, operation: info.FullMethod})
	if stack := attrValue(t, rec, "stack").String(); !strings.Contains(stack, "TestStreamChainLogsPanicOnce") {
		t.Fatalf("stack does not reach the panicking frame: %q", stack)
	}
}

func TestUnaryChainLogsInternalWithoutLeakingCause(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	cause := errors.New("postgres://user:pass@127.0.0.1:5432/identity")

	_, err := chainUnary(slog.New(logs), info,
		func(context.Context, any) (any, error) {
			return nil, internal("open store", cause)
		})
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}
	if got := status.Convert(err).Message(); got != "internal" {
		t.Fatalf("message: got %q want %q", got, "internal")
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelError, "rpc failed")
	assertFrame(t, rec, frameWant{result: resultError, code: codes.Internal, operation: info.FullMethod})
	logged := attrValue(t, rec, "error").String()
	for _, secret := range []string{"postgres://", "user:pass", "127.0.0.1:5432"} {
		if strings.Contains(logged, secret) {
			t.Fatalf("error carries the connection string into the log: %q", logged)
		}
	}
	if !strings.Contains(logged, "open store") {
		t.Fatalf("error drops the operation, leaving the failure unreadable: %q", logged)
	}
}

// Отмена и дедлайн отличают чужой отказ от своего, поэтому граница называет их,
// а не сводит к типу корневой ошибки вместе с остальным.
func TestUnaryLoggingNamesRecognizedCauses(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		cause error
		want  string
	}{
		{name: "deadline", cause: context.DeadlineExceeded, want: "list roles: deadline exceeded"},
		{name: "canceled", cause: context.Canceled, want: "list roles: canceled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logs := &capture{}
			info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
			_, err := unaryLogging(slog.New(logs))(t.Context(), nil, info,
				func(context.Context, any) (any, error) {
					return nil, internal("list roles", fmt.Errorf("query: %w", tc.cause))
				})
			if status.Code(err) != codes.Internal {
				t.Fatalf("code: got %v want %s", err, codes.Internal)
			}

			if got := attrValue(t, logs.sole(t), "error").String(); got != tc.want {
				t.Fatalf("error: got %q want %q", got, tc.want)
			}
		})
	}
}

func TestUnaryLoggingRedactsPostgresRowValues(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	pgErr := &pgconn.PgError{
		Code:           "23514",
		Message:        `new row for relation "profiles" violates check constraint`,
		Detail:         `Failing row contains (0198f2a4, 515151, solgufik_nickname, pending).`,
		ConstraintName: "profiles_access_status_check",
	}

	_, err := unaryLogging(slog.New(logs))(t.Context(), nil, info,
		func(context.Context, any) (any, error) {
			return nil, internal("upsert profile", pgErr)
		})
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}

	rec := logs.sole(t)
	logged := attrValue(t, rec, "error").String()
	if strings.Contains(logged, "solgufik_nickname") {
		t.Fatalf("error carries the failing row into the log: %q", logged)
	}
	for _, want := range []string{"upsert profile", "23514", "profiles_access_status_check"} {
		if !strings.Contains(logged, want) {
			t.Fatalf("error drops %q, leaving the failure unreadable: %q", want, logged)
		}
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
	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelWarn, "rpc failed")
	assertFrame(t, rec, frameWant{result: resultError, code: codes.InvalidArgument, operation: info.FullMethod})
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
	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelDebug, "rpc completed")
	assertFrame(t, rec, frameWant{result: resultOK, code: codes.OK, operation: info.FullMethod})
}

func TestStreamLoggingRecordsOutcome(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		err     error
		level   slog.Level
		message string
		result  string
		code    codes.Code
	}{
		{name: "success", err: nil, level: slog.LevelDebug, message: "rpc completed", result: resultOK, code: codes.OK},
		{
			name:    "unknown service",
			err:     status.Error(codes.NotFound, "unknown service"),
			level:   slog.LevelWarn,
			message: "rpc failed",
			result:  resultError,
			code:    codes.NotFound,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logs := &capture{}
			info := &grpc.StreamServerInfo{FullMethod: "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo"}
			err := streamLogging(slog.New(logs))(nil, panicStream{}, info,
				func(any, grpc.ServerStream) error { return tc.err })
			if status.Code(err) != tc.code {
				t.Fatalf("code: got %v want %s", err, tc.code)
			}

			rec := logs.sole(t)
			assertRecord(t, rec, tc.level, tc.message)
			assertFrame(t, rec, frameWant{result: tc.result, code: tc.code, operation: info.FullMethod})
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
		{name: "invalid argument", code: codes.InvalidArgument, level: slog.LevelWarn, category: failureInvariant},
		{name: "unknown health service", code: codes.NotFound, level: slog.LevelWarn, category: failureInvariant},
		{name: "failed precondition", code: codes.FailedPrecondition, level: slog.LevelWarn, category: failureInvariant},
		{name: "permission denied", code: codes.PermissionDenied, level: slog.LevelWarn, category: failureAuthorization},
		{name: "deadline exceeded", code: codes.DeadlineExceeded, level: slog.LevelWarn, category: failureTimeout},
		{name: "internal", code: codes.Internal, level: slog.LevelError, category: failureUnexpected},
		{name: "unavailable", code: codes.Unavailable, level: slog.LevelError, category: failureDependencyUnavailable},
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
			assertFrame(t, rec, frameWant{result: resultError, code: tc.code, operation: info.FullMethod})
			if got := attrValue(t, rec, "error_category").String(); got != tc.category {
				t.Fatalf("error_category: got %q want %q", got, tc.category)
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
			return &identityv1.ResolveIdentityResponse{IdentityId: resolvedIdentityID}, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelDebug, "rpc completed")
	assertFrame(t, rec, frameWant{
		result:    resultOK,
		code:      codes.OK,
		operation: info.FullMethod,
		requestID: "req-42",
	})
	// Наблюдаемое свойство здесь — что граница записала длительность, а не то,
	// сколько она заняла: порог по часам машины запрещён testing-strategy.md.
	if got := attrValue(t, rec, "duration_us").Int64(); got < 0 {
		t.Fatalf("duration_us: got %d want >= 0", got)
	}
	if got := attrValue(t, rec, "identity_id").String(); got != resolvedIdentityID {
		t.Fatalf("identity_id: got %q want %q", got, resolvedIdentityID)
	}
}

func TestUnaryLoggingKeepsTelegramFieldsOutOfTheRecord(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	username := "solgufik_nickname"

	_, err := unaryLogging(slog.New(logs))(t.Context(),
		&identityv1.ResolveIdentityRequest{TelegramUserId: 515151, TelegramUsername: &username}, info,
		func(context.Context, any) (any, error) {
			return &identityv1.ResolveIdentityResponse{IdentityId: resolvedIdentityID}, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	rec := logs.sole(t)
	assertNoAttr(t, rec, "telegram_user_id")
	assertNoAttr(t, rec, "telegram_username")
	if got := attrValue(t, rec, "identity_id").String(); got != resolvedIdentityID {
		t.Fatalf("identity_id: got %q want %q", got, resolvedIdentityID)
	}

	rec.Attrs(func(a slog.Attr) bool {
		if strings.Contains(a.Value.String(), username) {
			t.Fatalf("attribute %q carries the telegram username: %q", a.Key, a.Value.String())
		}
		return true
	})
}

func TestUnaryLoggingOmitsIdentityIDWhenResolveFails(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}

	_, err := unaryLogging(slog.New(logs))(t.Context(),
		&identityv1.ResolveIdentityRequest{TelegramUserId: 515151}, info,
		func(context.Context, any) (any, error) {
			return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
		})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
	}

	rec := logs.sole(t)
	assertNoAttr(t, rec, "identity_id")
	assertNoAttr(t, rec, "telegram_user_id")
}

func TestUnaryLoggingRecordsUseCaseWhenPresent(t *testing.T) {
	t.Parallel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	ctx := metadata.NewIncomingContext(t.Context(), metadata.Pairs(
		"x-request-id", "req-42",
		"x-use-case", "start",
	))

	_, err := unaryLogging(slog.New(logs))(ctx, &identityv1.ResolveIdentityRequest{TelegramUserId: 7}, info,
		func(context.Context, any) (any, error) {
			return &identityv1.ResolveIdentityResponse{}, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelDebug, "rpc completed")
	assertFrame(t, rec, frameWant{
		result:    resultOK,
		code:      codes.OK,
		operation: info.FullMethod,
		requestID: "req-42",
		useCase:   "start",
	})
}

func TestUnaryLoggingOmitsEmptyUseCase(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		md   metadata.MD
	}{
		{name: "absent", md: nil},
		{name: "empty value", md: metadata.Pairs("x-use-case", "")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logs := &capture{}
			info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
			ctx := t.Context()
			if tc.md != nil {
				ctx = metadata.NewIncomingContext(ctx, tc.md)
			}

			_, err := unaryLogging(slog.New(logs))(ctx, nil, info,
				func(context.Context, any) (any, error) {
					return &identityv1.ResolveIdentityResponse{}, nil
				})
			if err != nil {
				t.Fatal(err)
			}

			rec := logs.sole(t)
			assertFrame(t, rec, frameWant{result: resultOK, code: codes.OK, operation: info.FullMethod})
		})
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
