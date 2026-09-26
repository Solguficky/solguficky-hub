import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterEach, describe, expect, it } from "vitest";
// Статический импорт, как в main.ts: модуль вычисляется раньше, чем
// startMetrics ставит глобальный провайдер.
import { countFailure } from "./failures.js";

afterEach(() => {
  metrics.disable();
});

function startCollecting(): PeriodicExportingMetricReader {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 60_000,
  });
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
  return reader;
}

describe("countFailure", () => {
  it("reaches a meter provider installed after the module was imported", async () => {
    countFailure("invariant");
    const reader = startCollecting();

    countFailure("visibility");

    const { resourceMetrics } = await reader.collect();
    const counter = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "solguficky.failures");
    expect(counter?.dataPoints).toEqual([
      expect.objectContaining({
        value: 1,
        attributes: { service: "telegram-bot", error_category: "visibility" },
      }),
    ]);
  });
});
