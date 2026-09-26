package server

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// clientDeadline — дедлайн вызова у бота. Отказ недоступной базы обязан прийти
// раньше него, иначе клиент видит свой DeadlineExceeded вместо Unavailable.
const clientDeadline = 3 * time.Second

// blackhole принимает TCP и молчит. Так выглядит база за прокси DCP, когда
// контейнер PostgreSQL остановлен: соединение устанавливается, ответа на
// startup нет. Без предела подключения вызов висел бы до дедлайна клиента.
func blackhole(t *testing.T) string {
	t.Helper()

	lis, err := new(net.ListenConfig).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	var (
		mu    sync.Mutex
		conns []net.Conn
	)
	go func() {
		for {
			conn, err := lis.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = lis.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, conn := range conns {
			_ = conn.Close()
		}
	})
	return "postgres://identity@" + lis.Addr().String() + "/identity?sslmode=disable"
}

// connectError — настоящий отказ подключения pgx. Собрать его руками нельзя: у
// ConnectError приватная причина, а его Error() без неё паникует.
func connectError(t *testing.T) error {
	t.Helper()

	db, err := migrations.Pool(blackhole(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	err = db.PingContext(t.Context())
	if _, ok := errors.AsType[*pgconn.ConnectError](err); !ok {
		t.Fatalf("ping blackhole: got %v, want *pgconn.ConnectError", err)
	}
	return err
}

func TestStoreUnavailableSeparatesConnectionFromQuery(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{name: "connect error", err: connectError(t), want: true},
		{name: "admin shutdown", err: &pgconn.PgError{Code: "57P01"}, want: true},
		{name: "cannot connect now", err: &pgconn.PgError{Code: "57P03"}, want: true},
		{name: "connection failure class", err: &pgconn.PgError{Code: "08006"}, want: true},
		{name: "bad pooled connection", err: driver.ErrBadConn, want: true},
		{name: "connection dropped mid-read", err: fmt.Errorf("read: %w", io.ErrUnexpectedEOF), want: true},
		{name: "unique violation", err: &pgconn.PgError{Code: "23505"}, want: false},
		{name: "undefined table", err: &pgconn.PgError{Code: "42P01"}, want: false},
		{name: "bare deadline", err: context.DeadlineExceeded, want: false},
		{name: "anything else", err: errors.New("boom"), want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := storeUnavailable(tc.err); got != tc.want {
				t.Fatalf("storeUnavailable(%v): got %v want %v", tc.err, got, tc.want)
			}
		})
	}
}

// Отказ подключения и дефект SQL различаются и кодом, и категорией: Unavailable
// обещает, что повтор может пройти, и дефекту SQL он не достаётся.
func TestUnaryLoggingStoreFailureByPhase(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		cause    error
		code     codes.Code
		category string
		text     string
	}{
		{
			name:     "unreachable",
			cause:    connectError(t),
			code:     codes.Unavailable,
			category: failureDependencyUnavailable,
			text:     "begin transaction: postgres unreachable",
		},
		{
			name:     "starting up",
			cause:    &pgconn.PgError{Code: "57P03"},
			code:     codes.Unavailable,
			category: failureDependencyUnavailable,
			text:     "begin transaction: postgres sqlstate 57P03",
		},
		{
			name:     "sql defect",
			cause:    &pgconn.PgError{Code: "23505"},
			code:     codes.Internal,
			category: failureUnexpected,
			text:     "begin transaction: postgres sqlstate 23505",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			logs := &capture{}
			info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
			_, err := unaryLogging(slog.New(logs))(t.Context(), nil, info,
				func(context.Context, any) (any, error) {
					return nil, internal("begin transaction", fmt.Errorf("begin: %w", tc.cause))
				})
			if status.Code(err) != tc.code {
				t.Fatalf("code: got %v want %s", err, tc.code)
			}

			rec := logs.sole(t)
			assertRecord(t, rec, slog.LevelError, "rpc failed")
			assertFrame(t, rec, frameWant{result: resultError, code: tc.code, operation: info.FullMethod})
			if got := attrValue(t, rec, "error_category").String(); got != tc.category {
				t.Fatalf("error_category: got %q want %q", got, tc.category)
			}
			if got := attrValue(t, rec, "error").String(); got != tc.text {
				t.Fatalf("error: got %q want %q", got, tc.text)
			}
		})
	}
}

// Истёк дедлайн самого вызова — это timeout, даже если в цепочке лежит отказ
// подключения: клиент уже получил свой DeadlineExceeded, и запись называет его.
func TestUnaryLoggingExpiredCallIsTimeout(t *testing.T) {
	t.Parallel()

	cause := connectError(t)
	ctx, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	defer cancel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	_, _ = unaryLogging(slog.New(logs))(ctx, nil, info,
		func(context.Context, any) (any, error) { return nil, internal("begin transaction", cause) })

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelWarn, "rpc failed")
	assertFrame(t, rec, frameWant{result: resultError, code: codes.DeadlineExceeded, operation: info.FullMethod})
	if got := attrValue(t, rec, "error_category").String(); got != failureTimeout {
		t.Fatalf("error_category: got %q want %q", got, failureTimeout)
	}
}

// Клиент отменил вызов, пока pgx подключался: это не недоступность базы и не
// отказ сервиса. Запись называет Canceled и категории не несёт, как у Meetups.
func TestUnaryLoggingCanceledCallIsNotAFailure(t *testing.T) {
	t.Parallel()

	cause := connectError(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	logs := &capture{}
	info := &grpc.UnaryServerInfo{FullMethod: resolveMethod}
	_, _ = unaryLogging(slog.New(logs))(ctx, nil, info,
		func(context.Context, any) (any, error) { return nil, internal("begin transaction", cause) })

	rec := logs.sole(t)
	assertRecord(t, rec, slog.LevelWarn, "rpc failed")
	if got := attrValue(t, rec, "grpc_code").String(); got != codes.Canceled.String() {
		t.Fatalf("grpc_code: got %q want %s", got, codes.Canceled)
	}
	rec.Attrs(func(a slog.Attr) bool {
		if a.Key == "error_category" {
			t.Fatalf("canceled call carries error_category %q", a.Value)
		}
		return true
	})
}

type fakePinger struct {
	mu    sync.Mutex
	err   error
	calls int
}

func (p *fakePinger) PingContext(context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	return p.err
}

func (p *fakePinger) set(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.err = err
}

func (p *fakePinger) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

func TestReadinessFollowsDatabase(t *testing.T) {
	t.Parallel()

	db := &fakePinger{}
	srv := New(slog.New(slog.DiscardHandler), new(sql.DB), "")
	probe := readiness{Server: srv.health, db: db}

	check := func(service string) healthgrpc.HealthCheckResponse_ServingStatus {
		t.Helper()
		resp, err := probe.Check(t.Context(), &healthgrpc.HealthCheckRequest{Service: service})
		if err != nil {
			t.Fatalf("check %q: %v", service, err)
		}
		return resp.GetStatus()
	}

	if got := check(ReadinessService); got != healthgrpc.HealthCheckResponse_SERVING {
		t.Fatalf("ready with database up: got %s", got)
	}

	db.set(errors.New("database down"))
	if got := check(ReadinessService); got != healthgrpc.HealthCheckResponse_NOT_SERVING {
		t.Fatalf("ready with database down: got %s", got)
	}
	pings := db.count()
	if got := check(""); got != healthgrpc.HealthCheckResponse_SERVING {
		t.Fatalf("liveness with database down: got %s", got)
	}
	if db.count() != pings {
		t.Fatal("liveness pinged the database")
	}

	db.set(nil)
	if got := check(ReadinessService); got != healthgrpc.HealthCheckResponse_SERVING {
		t.Fatalf("ready after database recovered: got %s", got)
	}

	srv.GracefulStop()
	pings = db.count()
	if got := check(ReadinessService); got != healthgrpc.HealthCheckResponse_NOT_SERVING {
		t.Fatalf("ready after stop: got %s", got)
	}
	if db.count() != pings {
		t.Fatal("stopped server still pinged the database")
	}
}

func TestReadinessRefusesWatch(t *testing.T) {
	t.Parallel()

	srv := New(slog.New(slog.DiscardHandler), new(sql.DB), "")
	probe := readiness{Server: srv.health, db: &fakePinger{}}
	err := probe.Watch(&healthgrpc.HealthCheckRequest{Service: ReadinessService}, nil)
	if status.Code(err) != codes.Unimplemented {
		t.Fatalf("watch readiness: got %v want %s", err, codes.Unimplemented)
	}
}

// dialUnreachable поднимает сервер на базе, которая принимает TCP и молчит, и
// отдаёт клиента к нему вместе с записями границы.
func dialUnreachable(t *testing.T) (*grpc.ClientConn, *capture) {
	t.Helper()

	db, err := migrations.Pool(blackhole(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	logs := &capture{}
	srv := New(slog.New(logs), db, "")
	lis := bufconn.Listen(1024 * 1024)
	t.Cleanup(func() { _ = lis.Close() })
	t.Cleanup(srv.Stop)
	go func() { _ = srv.Serve(lis) }()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, logs
}

// Критерий PER-361: недоступная база даёт клиенту Unavailable раньше его
// дедлайна, а не DeadlineExceeded.
func TestResolveIdentityFailsFastWhenDatabaseUnreachable(t *testing.T) {
	t.Parallel()

	conn, logs := dialUnreachable(t)
	ctx, cancel := context.WithTimeout(t.Context(), clientDeadline)
	defer cancel()

	started := time.Now()
	_, err := identityv1.NewIdentityServiceClient(conn).ResolveIdentity(ctx,
		&identityv1.ResolveIdentityRequest{TelegramUserId: 42})
	elapsed := time.Since(started)

	if status.Code(err) != codes.Unavailable {
		t.Fatalf("code: got %v want %s", err, codes.Unavailable)
	}
	if elapsed >= clientDeadline-500*time.Millisecond {
		t.Fatalf("refusal took %s, too close to the client deadline %s", elapsed, clientDeadline)
	}
	rec := logs.sole(t)
	if got := attrValue(t, rec, "error_category").String(); got != failureDependencyUnavailable {
		t.Fatalf("error_category: got %q want %q", got, failureDependencyUnavailable)
	}
	if got := attrValue(t, rec, "grpc_code").String(); got != codes.Unavailable.String() {
		t.Fatalf("grpc_code: got %q want %s", got, codes.Unavailable)
	}
}

func TestReadinessNotServingWhenDatabaseUnreachable(t *testing.T) {
	t.Parallel()

	conn, _ := dialUnreachable(t)
	ctx, cancel := context.WithTimeout(t.Context(), clientDeadline)
	defer cancel()

	resp, err := healthgrpc.NewHealthClient(conn).Check(ctx,
		&healthgrpc.HealthCheckRequest{Service: ReadinessService})
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if resp.GetStatus() != healthgrpc.HealthCheckResponse_NOT_SERVING {
		t.Fatalf("status: got %s want %s", resp.GetStatus(), healthgrpc.HealthCheckResponse_NOT_SERVING)
	}
}
