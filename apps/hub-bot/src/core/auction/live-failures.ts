import { countFailure } from "../failures.js";
import type { Logger } from "../logging.js";
import type { WatchFailure } from "./watch.js";

// Отказы карточек финала (PER-336) по каркасу logging.md: запись с операцией и
// классом отказа и счётчик `solguficky.failures`. Отказ потока и правки —
// сосед или Telegram недоступен; подписчик или правка, бросившие сами, —
// дефект кода.

export function reportWatchFailure(
  logger: Logger,
  cause: unknown,
  failure: WatchFailure,
): void {
  const category =
    failure === "stream" ? "dependency_unavailable" : "unexpected";
  countFailure(category);
  logger.warn("auction watch failed", {
    operation: "watch_auction",
    result: "error",
    error_category: category,
    error: messageOf(cause),
  });
}

export function reportLiveEditFailure(
  logger: Logger,
  error: string,
  category: "dependency_unavailable" | "unexpected" = "dependency_unavailable",
): void {
  countFailure(category);
  logger.warn("live lot card edit failed", {
    operation: "edit_live_card",
    result: "error",
    error_category: category,
    error,
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
