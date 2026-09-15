import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";

export type Metrics = {
  shutdown(): Promise<void>;
};

export function startMetrics(): Metrics {
  if (
    environment("OTEL_EXPORTER_OTLP_ENDPOINT") === undefined &&
    environment("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") === undefined
  ) {
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

function environment(name: string): string | undefined {
  return process.env[name];
}
