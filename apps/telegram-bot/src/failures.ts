import { type Counter, type MeterProvider, metrics } from "@opentelemetry/api";

export const failureCategories = [
  "authorization",
  "invariant",
  "dependency_unavailable",
  "timeout",
  "visibility",
  "unexpected",
] as const;

export type FailureCategory = (typeof failureCategories)[number];

// У metrics API нет прокси-провайдера, как у трассировки: счётчик, созданный
// при импорте модуля, раньше startMetrics, навсегда остался бы no-op. Поэтому
// он привязывается к текущему глобальному провайдеру и пересоздаётся, когда
// провайдер сменился.
let bound: { provider: MeterProvider; counter: Counter } | undefined;

function failures(): Counter {
  const provider = metrics.getMeterProvider();
  if (bound?.provider !== provider) {
    bound = {
      provider,
      counter: provider
        .getMeter("solguficky.failures")
        .createCounter("solguficky.failures", {
          description:
            "Operations rejected or failed, grouped by failure category",
        }),
    };
  }
  return bound.counter;
}

export function countFailure(category: FailureCategory): void {
  failures().add(1, { service: "telegram-bot", error_category: category });
}
