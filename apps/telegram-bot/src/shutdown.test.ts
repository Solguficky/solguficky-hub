import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "./logging.js";
import { createShutdown } from "./shutdown.js";

type LogRecord = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: LogFields;
};

function createCapturingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: LogRecord["level"]): Logger[LogRecord["level"]] =>
    (message, fields) => {
      records.push({ level, message, fields: fields ?? {} });
    };
  return {
    records,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdown", () => {
  it("remembers a signal before start without closing resources", async () => {
    const { logger, records } = createCapturingLogger();
    const botStop = vi.fn(async () => {});
    const close = vi.fn();
    const shutdown = createShutdown({
      bot: { isRunning: () => false, stop: botStop },
      resources: { close },
      logger,
      timeoutMs: 40,
      exit: () => {
        throw new Error("exit should not run");
      },
    });
    await shutdown.request("SIGTERM");
    expect(shutdown.requested).toBe(true);
    expect(botStop).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(records[0]?.message).toBe("shutdown signal received");
    await shutdown.complete();
    expect(close).toHaveBeenCalledOnce();
    expect(botStop).not.toHaveBeenCalled();
  });

  it("stops a running bot before closing resources", async () => {
    const { logger } = createCapturingLogger();
    const order: string[] = [];
    const shutdown = createShutdown({
      bot: {
        isRunning: () => true,
        stop: async () => {
          order.push("stop");
        },
      },
      resources: {
        close() {
          order.push("close");
        },
      },
      logger,
      timeoutMs: 40,
      exit: () => {
        throw new Error("exit should not run");
      },
    });
    await shutdown.request("SIGINT");
    expect(order).toEqual(["stop", "close"]);
    await shutdown.complete();
    expect(order).toEqual(["stop", "close"]);
  });

  it("stops later if the first signal arrived before the bot was running", async () => {
    const { logger } = createCapturingLogger();
    let running = false;
    const botStop = vi.fn(async () => {
      running = false;
    });
    const close = vi.fn();
    const shutdown = createShutdown({
      bot: { isRunning: () => running, stop: botStop },
      resources: { close },
      logger,
      timeoutMs: 40,
      exit: () => {
        throw new Error("exit should not run");
      },
    });
    await shutdown.request("SIGTERM");
    expect(botStop).not.toHaveBeenCalled();
    running = true;
    await shutdown.request("SIGTERM");
    expect(botStop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not start a second shutdown while the first is in flight", async () => {
    const { logger } = createCapturingLogger();
    let release: (() => void) | undefined;
    const botStop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const close = vi.fn();
    const shutdown = createShutdown({
      bot: { isRunning: () => true, stop: botStop },
      resources: { close },
      logger,
      timeoutMs: 1_000,
      exit: () => {
        throw new Error("exit should not run");
      },
    });
    const first = shutdown.request("SIGTERM");
    const second = shutdown.request("SIGINT");
    expect(botStop).toHaveBeenCalledOnce();
    release?.();
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("exits when stop hangs past the timeout", async () => {
    vi.useFakeTimers();
    const { logger, records } = createCapturingLogger();
    const exit = vi.fn();
    const shutdown = createShutdown({
      bot: {
        isRunning: () => true,
        stop: () => new Promise<void>(() => {}),
      },
      resources: { close: () => {} },
      logger,
      timeoutMs: 40,
      exit,
    });
    void shutdown.request("SIGTERM");
    await vi.advanceTimersByTimeAsync(40);
    expect(exit).toHaveBeenCalledWith(1);
    expect(records.some((record) => record.level === "error")).toBe(true);
  });
});
