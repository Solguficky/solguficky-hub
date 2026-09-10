import { metrics } from "@opentelemetry/api";

export const failureCategories = [
  "authorization",
  "invariant",
  "dependency_unavailable",
  "timeout",
  "visibility",
  "unexpected",
] as const;

export type FailureCategory = (typeof failureCategories)[number];

const failures = metrics
  .getMeter("solguficky.failures")
  .createCounter("solguficky.failures", {
    description: "Operations rejected or failed, grouped by failure category",
  });

export function countFailure(category: FailureCategory): void {
  failures.add(1, { service: "telegram-bot", error_category: category });
}
