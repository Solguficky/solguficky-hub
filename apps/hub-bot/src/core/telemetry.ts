import { metrics } from "@opentelemetry/api";
import type { Logger as OtlpLogger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import {
  defaultResource,
  detectResources,
  envDetector,
  type Resource,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { serviceName } from "./logging.js";
import { createTracing, noopTracing, type Tracing } from "./tracing.js";

export type Metrics = {
  shutdown(): Promise<void>;
};

export type Logs = {
  // Отсутствует без endpoint: логгер тогда пишет только в stdout.
  logger?: OtlpLogger;
  shutdown(): Promise<void>;
};

export function startMetrics(): Metrics {
  if (!otlpConfigured("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")) {
    return { shutdown: async () => {} };
  }

  const provider = new MeterProvider({
    resource: telemetryResource(),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  return { shutdown: () => provider.shutdown() };
}

// Логи уходят по OTLP при том же условии, что и метрики: Structured logs
// dashboard читает только OTLP, и без этого бот выпадает из фильтра по
// request_id.
export function startLogs(name: string): Logs {
  if (!otlpConfigured("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")) {
    return { shutdown: async () => {} };
  }

  const provider = new LoggerProvider({ resource: telemetryResource() });
  provider.addLogRecordProcessor(
    new BatchLogRecordProcessor(new OTLPLogExporter()),
  );
  return {
    logger: provider.getLogger(name),
    shutdown: () => provider.shutdown(),
  };
}

// Трейсы уходят по OTLP при том же условии, что логи и метрики. Без адреса
// трассировка no-op: бот работает и отвечает, спаны ничего не стоят.
export function startTraces(): Tracing {
  if (!otlpConfigured("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) {
    return noopTracing();
  }

  const provider = new BasicTracerProvider({
    resource: telemetryResource(),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  return createTracing(provider.getTracer(serviceName), () =>
    provider.shutdown(),
  );
}

// JS SDK сам не читает OTEL_SERVICE_NAME и OTEL_RESOURCE_ATTRIBUTES, которые
// выдаёт AppHost: без детектора сигналы ушли бы от unknown_service и не легли
// бы на ресурс hub-bot в dashboard. Ресурс один на логи, метрики и трейсы,
// иначе они снова разойдутся по разным ресурсам.
export function telemetryResource(): Resource {
  return defaultResource().merge(detectResources({ detectors: [envDetector] }));
}

function otlpConfigured(signalEndpoint: string): boolean {
  return (
    environment("OTEL_EXPORTER_OTLP_ENDPOINT") !== undefined ||
    environment(signalEndpoint) !== undefined
  );
}

// Пустое значение — то же, что отсутствие, как у Identity: иначе экспортёр
// поднимался бы с адресом по умолчанию и слал бы в пустоту.
function environment(name: string): string | undefined {
  const value = process.env[name];
  return value === "" ? undefined : value;
}
