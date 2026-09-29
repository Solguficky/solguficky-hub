package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

// startTelemetry поднимает метрики и трейсы и возвращает провайдер трейсов для
// сборки процесса вместе с закрытием обоих. Отказ уже записан в лог.
func startTelemetry(ctx context.Context, log *slog.Logger) (trace.TracerProvider, func(), error) {
	metrics, err := startMetrics(ctx)
	if err != nil {
		log.Error("metrics setup failed", "service", server.ServiceName, "error", err)
		return nil, nil, err
	}
	traces, err := startTraces(ctx)
	if err != nil {
		log.Error("traces setup failed", "service", server.ServiceName, "error", err)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		shutdownProvider(shutdownCtx, log, "metrics", metrics)
		return nil, nil, err
	}
	return traces, func() {
		// Один предел на оба провайдера: последовательные пределы складывались бы
		// и растягивали остановку сверх того, что ждёт оркестратор.
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		shutdownProvider(shutdownCtx, log, "traces", traces)
		shutdownProvider(shutdownCtx, log, "metrics", metrics)
	}, nil
}

func shutdownProvider(ctx context.Context, log *slog.Logger, signal string, provider metricsProvider) {
	if err := provider.Shutdown(ctx); err != nil {
		log.Error(signal+" shutdown failed", "service", server.ServiceName, "error", err)
	}
}

type metricsProvider interface {
	Shutdown(context.Context) error
}

type noopMetricsProvider struct{}

func (noopMetricsProvider) Shutdown(context.Context) error { return nil }

func startMetrics(ctx context.Context) (metricsProvider, error) {
	if !otlpConfigured("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") {
		return noopMetricsProvider{}, nil
	}

	exporter, err := otlpmetricgrpc.New(ctx)
	if err != nil {
		return nil, err
	}
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exporter)))
	otel.SetMeterProvider(provider)
	return provider, nil
}

// startLogs включает отправку логов по OTLP при том же условии, что и метрики.
// Без endpoint возвращает nil, и логгер пишет только в stdout.
func startLogs(ctx context.Context) (*sdklog.LoggerProvider, error) {
	if !otlpConfigured("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") {
		return nil, nil
	}

	exporter, err := otlploggrpc.New(ctx)
	if err != nil {
		return nil, err
	}
	return sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter))), nil
}

// tracesProvider — провайдер трейсов процесса вместе с его закрытием.
type tracesProvider interface {
	trace.TracerProvider
	Shutdown(context.Context) error
}

type noopTracesProvider struct{ tracenoop.TracerProvider }

func (noopTracesProvider) Shutdown(context.Context) error { return nil }

// startTraces включает экспорт трейсов по OTLP при том же условии, что метрики и
// логи. Без endpoint провайдер no-op: сервис работает, спаны ничего не стоят.
// Глобальный пропагатор не ставится: сервер и outbox берут W3C TraceContext
// явно, а глобального никто в процессе не читает.
func startTraces(ctx context.Context) (tracesProvider, error) {
	return newTracesProvider(ctx, otlpConfigured("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))
}

// newTracesProvider отделён от чтения окружения, чтобы негативный путь
// проверялся без t.Setenv, несовместимого с t.Parallel.
func newTracesProvider(ctx context.Context, exportConfigured bool) (tracesProvider, error) {
	if !exportConfigured {
		return noopTracesProvider{}, nil
	}

	exporter, err := otlptracegrpc.New(ctx)
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter))
	otel.SetTracerProvider(provider)
	return provider, nil
}

func otlpConfigured(signalEndpoint string) bool {
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv(signalEndpoint) != ""
}
