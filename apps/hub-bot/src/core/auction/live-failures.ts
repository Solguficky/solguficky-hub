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

// Пульт ведущего (PER-566) перечитывается по потоку вне update: отказ чтения
// оставляет на экране последний пульт с пометкой обрыва.
export function reportLiveConsoleFailure(logger: Logger, error: string): void {
  countFailure("dependency_unavailable");
  logger.warn("live auction console refresh failed", {
    operation: "refresh_live_console",
    result: "error",
    error_category: "dependency_unavailable",
    error,
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Экраны, открытые до рестарта (PER-815): исход восстановления записи
// хранилища. Нечитаемый экран остаётся замёрзшим до первого нажатия, и запись
// об этом нужна, чтобы это было видно в логах.
export function reportLiveRestore(
  logger: Logger,
  screen: "console" | "floor",
  outcome: "restored" | "refused" | "unreadable",
): void {
  if (outcome === "unreadable") {
    countFailure("dependency_unavailable");
    logger.warn("live screen restore failed", {
      operation: "restore_live_screen",
      result: "error",
      error_category: "dependency_unavailable",
      error: `${screen}: unreadable`,
    });
    return;
  }
  logger.info("live screen restored", {
    operation: "restore_live_screen",
    result: "ok",
    screen,
    outcome,
  });
}

// Хранилище открытых живых экранов (PER-815) недоступно: экраны живут, пока
// жив процесс, и рестарт их снова теряет — запись нужна, чтобы это было видно.
export function reportLiveStoreFailure(
  logger: Logger,
  operation: "connect" | "save" | "remove" | "list",
  cause: unknown,
): void {
  countFailure("dependency_unavailable");
  logger.warn("live screen store failed", {
    operation: `live_screen_store_${operation}`,
    result: "error",
    error_category: "dependency_unavailable",
    error: messageOf(cause),
  });
}
