import type { Logger } from "../../core/logging.js";

export const releaseReportDelayMs = 5 * 60 * 1000;

export type ReleaseReport = (
  recordIds: readonly string[],
) => Promise<{ kind: "ok" } | { kind: "failed"; cause: unknown }>;

export type ReleaseReportSchedule = {
  after(delayMs: number, run: () => void): { cancel(): void };
};

export function releaseReportSchedule(): ReleaseReportSchedule {
  return {
    after(delayMs, run) {
      const timer = setTimeout(run, delayMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      return { cancel: () => clearTimeout(timer) };
    },
  };
}

export function startReleaseNotesReport(input: {
  recordIds: readonly string[];
  report: ReleaseReport;
  logger: Logger;
  schedule?: ReleaseReportSchedule;
  delayMs?: number;
}): { close(): void } {
  const schedule = input.schedule ?? releaseReportSchedule();
  const delayMs = input.delayMs ?? releaseReportDelayMs;
  let stopped = false;
  let running = false;
  let pending: { cancel(): void } | undefined;

  const attempt = (): void => {
    if (stopped || running) return;
    running = true;
    void input
      .report(input.recordIds)
      .then(
        (result) => result,
        (cause: unknown) => ({ kind: "failed" as const, cause }),
      )
      .then((result) => {
        running = false;
        if (stopped || result.kind === "ok") return;
        input.logger.warn("release notes report failed", {
          error_category: "dependency_unavailable",
          error:
            result.cause instanceof Error
              ? result.cause.message
              : String(result.cause),
          release_notes: input.recordIds.length,
        });
        pending = schedule.after(delayMs, attempt);
      });
  };

  attempt();
  return {
    close() {
      stopped = true;
      pending?.cancel();
      pending = undefined;
    },
  };
}
