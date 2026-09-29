import { metrics } from "@opentelemetry/api";
import type { MeterProviderOptions } from "@opentelemetry/sdk-metrics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMetrics, startTraces, telemetryResource } from "./telemetry.js";

// Провайдер настоящий, записываются только его опции: так тест видит ровно
// то, с чем startMetrics его создал, и падает, если ресурс снова пропадёт.
const meterProviderOptions = vi.hoisted(() => [] as MeterProviderOptions[]);

vi.mock("@opentelemetry/sdk-metrics", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@opentelemetry/sdk-metrics")>();
  class RecordingMeterProvider extends original.MeterProvider {
    constructor(options: MeterProviderOptions = {}) {
      super(options);
      meterProviderOptions.push(options);
    }
  }
  return { ...original, MeterProvider: RecordingMeterProvider };
});

// Экспортёр без сети: иначе shutdown ждал бы недоступного collector'а.
vi.mock("@opentelemetry/exporter-metrics-otlp-grpc", () => ({
  OTLPMetricExporter: class {
    export(_metrics: unknown, done: (result: { code: number }) => void) {
      done({ code: 0 });
    }
    forceFlush() {
      return Promise.resolve();
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-grpc", () => ({
  OTLPTraceExporter: class {
    export(_spans: unknown, done: (result: { code: number }) => void) {
      done({ code: 0 });
    }
    forceFlush() {
      return Promise.resolve();
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

beforeEach(() => {
  meterProviderOptions.length = 0;
  vi.stubEnv("OTEL_SERVICE_NAME", "telegram-bot");
  vi.stubEnv(
    "OTEL_RESOURCE_ATTRIBUTES",
    "service.instance.id=bot-1,deployment.environment=local",
  );
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
  vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "");
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  metrics.disable();
});

describe("telemetryResource", () => {
  it("takes service.name and attributes from the AppHost environment", async () => {
    const resource = telemetryResource();
    await resource.waitForAsyncAttributes?.();

    expect(resource.attributes).toMatchObject({
      "service.name": "telegram-bot",
      "service.instance.id": "bot-1",
      "deployment.environment": "local",
    });
  });
});

describe("startMetrics", () => {
  it("creates the meter provider on the telegram-bot resource", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317");

    const started = startMetrics();

    expect(meterProviderOptions).toHaveLength(1);
    expect(meterProviderOptions[0]?.resource?.attributes).toMatchObject({
      "service.name": "telegram-bot",
      "service.instance.id": "bot-1",
    });
    await started.shutdown();
  });

  it("does not start metrics without an OTLP endpoint", () => {
    startMetrics();

    expect(meterProviderOptions).toHaveLength(0);
  });
});

describe("startTraces", () => {
  it("records spans on the telegram-bot resource with an OTLP endpoint", async () => {
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317");

    const tracing = startTraces();
    const span = tracing.tracer.startSpan("update");

    expect(span.isRecording()).toBe(true);
    expect(
      (span as unknown as { resource: { attributes: object } }).resource
        .attributes,
    ).toMatchObject({ "service.name": "telegram-bot" });
    span.end();
    await tracing.shutdown();
  });

  it("records nothing without an OTLP endpoint", () => {
    const tracing = startTraces();

    expect(tracing.tracer.startSpan("update").isRecording()).toBe(false);
  });
});
