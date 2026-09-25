import { metrics } from "@opentelemetry/api";
import type { Logger as OtlpLogger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import {
  defaultResource,
  detectResources,
  envDetector,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

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

  // JS SDK сам не читает OTEL_SERVICE_NAME и OTEL_RESOURCE_ATTRIBUTES, которые
  // выдаёт AppHost: без детектора записи ушли бы от unknown_service и не
  // легли бы на ресурс telegram-bot в dashboard.
  const provider = new LoggerProvider({
    resource: defaultResource().merge(
      detectResources({ detectors: [envDetector] }),
    ),
  });
  provider.addLogRecordProcessor(
    new BatchLogRecordProcessor(new OTLPLogExporter()),
  );
  return {
    logger: provider.getLogger(name),
    shutdown: () => provider.shutdown(),
  };
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
