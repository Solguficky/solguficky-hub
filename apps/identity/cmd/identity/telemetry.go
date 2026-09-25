package main

import (
	"context"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
)

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

func otlpConfigured(signalEndpoint string) bool {
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv(signalEndpoint) != ""
}
