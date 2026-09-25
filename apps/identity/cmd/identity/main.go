package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/relay"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	otellog "go.opentelemetry.io/otel/log"
	"google.golang.org/grpc"
)

var errDatabaseURLMissing = errors.New("IDENTITY_DATABASE_URL is not set")

const shutdownTimeout = 15 * time.Second

func main() {
	os.Exit(run())
}

func run() int {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log, closeLogs, logsErr := setupLogging(ctx)
	// Провайдер логов закрывается последним: defer исполняются в обратном
	// порядке, и записи об остановке остальных частей успевают уйти.
	defer closeLogs()
	slog.SetDefault(log)
	if logsErr != nil {
		log.Error("logs setup failed", "service", server.ServiceName, "error", logsErr)
		return 1
	}

	addr := os.Getenv("IDENTITY_GRPC_ADDR")
	if addr == "" {
		addr = ":50051"
	}

	metrics, err := startMetrics(ctx)
	if err != nil {
		log.Error("metrics setup failed", "service", server.ServiceName, "error", err)
		return 1
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := metrics.Shutdown(shutdownCtx); err != nil {
			log.Error("metrics shutdown failed", "service", server.ServiceName, "error", err)
		}
	}()

	db, err := openStore(ctx)
	if err != nil {
		log.Error("store setup failed", "service", server.ServiceName, "error", err)
		return 1
	}
	defer func() { _ = db.Close() }()
	log.Info("migrations applied", "service", server.ServiceName)

	lis, err := (&net.ListenConfig{}).Listen(ctx, "tcp", addr)
	if err != nil {
		log.Error("listen failed", "service", server.ServiceName, "addr", addr, "error", err)
		return 1
	}

	stopRelay, err := startRelay(ctx, log, db)
	if err != nil {
		log.Error("relay setup failed", "service", server.ServiceName, "error", err)
		return 1
	}
	defer stopRelay()

	srv := server.New(log, db, os.Getenv("IDENTITY_MAINTAINER_TOKEN"))
	errCh := make(chan error, 1)
	go func() {
		log.Info("identity listening", "service", server.ServiceName, "addr", lis.Addr().String())
		errCh <- srv.Serve(lis)
	}()

	select {
	case <-ctx.Done():
		log.Info("shutdown signal received",
			"service", server.ServiceName, "timeout", shutdownTimeout.String())
		stopWithin(log, srv, shutdownTimeout)
		// Serve уже вернулся: и GracefulStop, и Stop его завершают. Читать
		// errCh обязательно — при готовности обоих case select выбирает ветку
		// псевдослучайно, поэтому отказ листенера, совпавший с сигналом, иначе
		// потерялся бы, и процесс отчитался бы кодом 0.
		if serveErr := <-errCh; !serveDone(serveErr) {
			log.Error("serve failed", "service", server.ServiceName, "error", serveErr)
			return 1
		}
	case serveErr := <-errCh:
		if !serveDone(serveErr) {
			log.Error("serve failed", "service", server.ServiceName, "error", serveErr)
			return 1
		}
	}

	return 0
}

// stopWithin сливает соединения сервера и, если слив не уложился в timeout,
// обрывает их.
func stopWithin(log *slog.Logger, srv *server.Server, timeout time.Duration) {
	stopped := make(chan struct{})
	go func() {
		srv.GracefulStop()
		close(stopped)
	}()
	select {
	case <-stopped:
		log.Info("graceful shutdown complete", "service", server.ServiceName)
	case <-time.After(timeout):
		log.Error("graceful shutdown timed out, forcing stop",
			"service", server.ServiceName, "timeout", timeout.String())
		srv.Stop()
	}
}

// serveDone отличает штатное завершение Serve от собственного отказа сервера.
func serveDone(err error) bool {
	return err == nil || errors.Is(err, grpc.ErrServerStopped)
}

func openStore(ctx context.Context) (*sql.DB, error) {
	dsn, err := databaseURL()
	if err != nil {
		return nil, err
	}
	db, err := migrations.Open(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := migrations.Apply(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// startRelay запускает публикацию outbox в JetStream. Без IDENTITY_NATS_URL
// релей не запускается: сервис работает, а события копятся в очереди и уйдут,
// когда адрес появится. Недоступная при старте шина старт не валит — клиент
// переподключается сам, а тики до связи отказываются и пишутся в лог.
//
// Возвращённая функция останавливает релей, дожидается последнего тика и
// закрывает соединение. Отмена своя и от сигнала не зависит: релей работает, пока
// gRPC сливает запросы, и публикует закоммиченное ими, а при отказе листенера
// сигнала нет вовсе, и без своей отмены ожидание тика не кончилось бы.
func startRelay(ctx context.Context, log *slog.Logger, db *sql.DB) (func(), error) {
	url := os.Getenv("IDENTITY_NATS_URL")
	if url == "" {
		log.Info("outbox dispatch unconfigured, events accumulate",
			"service", server.ServiceName, "dispatch", "unconfigured")
		return func() {}, nil
	}

	nc, err := nats.Connect(url,
		nats.Name(server.ServiceName),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1))
	if err != nil {
		return nil, fmt.Errorf("connect nats: %w", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("jetstream context: %w", err)
	}

	publisher := relay.NewJetStreamPublisher(js, relay.DefaultAckTimeout)
	relayCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})
	go func() {
		defer close(done)
		relay.New(db, publisher, log, relay.DefaultBatch).Run(relayCtx, relay.DefaultInterval)
	}()
	log.Info("outbox dispatch started", "service", server.ServiceName, "dispatch", "jetstream")

	return func() {
		cancel()
		<-done
		nc.Close()
	}, nil
}

func databaseURL() (string, error) {
	dsn := os.Getenv("IDENTITY_DATABASE_URL")
	if dsn == "" {
		return "", errDatabaseURLMissing
	}
	return dsn, nil
}

// setupLogging собирает логгер процесса. Отказ OTLP-провайдера возвращается
// вместе с логгером на stdout, чтобы о нём было чем написать.
func setupLogging(ctx context.Context) (*slog.Logger, func(), error) {
	level, levelErr := logLevel()
	logs, logsErr := startLogs(ctx)
	var provider otellog.LoggerProvider
	closeLogs := func() {}
	if logs != nil {
		provider = logs
		closeLogs = func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
			defer cancel()
			_ = logs.Shutdown(shutdownCtx)
		}
	}
	log := newLogger(os.Stdout, level, provider)
	if levelErr != nil {
		log.Warn("invalid IDENTITY_LOG_LEVEL, falling back to info",
			"service", server.ServiceName, "error", levelErr)
	}
	return log, closeLogs, logsErr
}

func logLevel() (slog.Level, error) {
	raw := os.Getenv("IDENTITY_LOG_LEVEL")
	if raw == "" {
		return slog.LevelInfo, nil
	}
	var level slog.Level
	if err := level.UnmarshalText([]byte(raw)); err != nil {
		return slog.LevelInfo, err
	}
	return level, nil
}
