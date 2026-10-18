import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createTracing, type Tracing } from "../src/core/tracing.js";

// Настоящий SDK трейсов с экспортом в память: спан попадает в `exporter`
// синхронно при `end()`, поэтому тест читает дерево сразу после update.
export function createRecordingTracing(): {
  tracing: Tracing;
  exporter: InMemorySpanExporter;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return {
    tracing: createTracing(provider.getTracer("test"), () =>
      provider.shutdown(),
    ),
    exporter,
  };
}
