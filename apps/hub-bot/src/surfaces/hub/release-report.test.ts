import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../core/logging.js";
import {
  type ReleaseReportSchedule,
  releaseReportDelayMs,
  startReleaseNotesReport,
} from "./release-report.js";

function logger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message) => {
      warnings.push(message);
    },
    error: vi.fn(),
  };
}

function schedule(): ReleaseReportSchedule & {
  run: () => void;
  pending: boolean;
} {
  let queued: (() => void) | undefined;
  return {
    after(_delayMs, run) {
      queued = run;
      return {
        cancel() {
          queued = undefined;
        },
      };
    },
    get pending() {
      return queued !== undefined;
    },
    run() {
      const pending = queued;
      queued = undefined;
      pending?.();
    },
  };
}

describe("release notes report", () => {
  it("retries a failed report while the process stays up and stops after acceptance", async () => {
    const calls: string[][] = [];
    const clock = schedule();
    const report = vi.fn(async (recordIds: readonly string[]) => {
      calls.push([...recordIds]);
      return calls.length < 2
        ? { kind: "failed" as const, cause: new Error("unimplemented") }
        : { kind: "ok" as const };
    });
    const started = startReleaseNotesReport({
      recordIds: ["known", "second"],
      report,
      logger: logger(),
      schedule: clock,
      delayMs: releaseReportDelayMs,
    });

    await vi.waitFor(() => expect(clock.pending).toBe(true));
    expect(calls).toEqual([["known", "second"]]);
    clock.run();
    await vi.waitFor(() =>
      expect(calls).toEqual([
        ["known", "second"],
        ["known", "second"],
      ]),
    );
    clock.run();
    await Promise.resolve();
    expect(calls).toHaveLength(2);
    started.close();
  });

  it("does not wait for the report before the caller continues", async () => {
    let finish: (result: { kind: "failed"; cause: unknown }) => void = () => {};
    const clock = schedule();
    const started = startReleaseNotesReport({
      recordIds: ["known"],
      report: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      logger: logger(),
      schedule: clock,
    });
    started.close();
    finish({ kind: "failed", cause: new Error("unavailable") });
    await Promise.resolve();
    await Promise.resolve();
    clock.run();
    expect(clock).toBeDefined();
  });
});
