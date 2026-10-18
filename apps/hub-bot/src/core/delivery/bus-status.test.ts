import { describe, expect, it } from "vitest";
import { type BusStatus, watchBusStatus } from "./bus-status.js";
import type {
  DeliveryLogFields,
  DeliveryLogger,
  FailureCategory,
} from "./observe.js";

type Entry = {
  level: string;
  message: string;
  fields: DeliveryLogFields | undefined;
};

function recordingLogger(): DeliveryLogger & { entries: Entry[] } {
  const entries: Entry[] = [];
  const at =
    (level: string) =>
    (message: string, fields?: DeliveryLogFields): void => {
      entries.push({ level, message, fields });
    };
  return {
    entries,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

const failures: FailureCategory[] = [];

function observing(logger: DeliveryLogger) {
  return {
    logger,
    countFailure: (category: FailureCategory) => {
      failures.push(category);
    },
  };
}

async function* statuses(...types: string[]): AsyncIterable<BusStatus> {
  for (const type of types) {
    yield { type };
  }
}

describe("watchBusStatus", () => {
  it("reports a lost bus once however many reconnect attempts follow", async () => {
    const logger = recordingLogger();
    await watchBusStatus(
      statuses(
        "disconnect",
        "reconnecting",
        "reconnecting",
        "disconnect",
        "reconnecting",
      ),
      observing(logger),
    );
    expect(logger.entries).toEqual([
      {
        level: "warn",
        message: "bus connection lost",
        fields: {
          operation: "nats.connection",
          result: "error",
          duration_us: 0,
          error_category: "dependency_unavailable",
          error: "connection to NATS lost; reconnecting",
        },
      },
    ]);
    expect(failures.at(-1)).toBe("dependency_unavailable");
  });

  it("reports the restored bus with the outage length as its duration", async () => {
    const logger = recordingLogger();
    const moments = [1_000, 61_500];
    await watchBusStatus(
      statuses("disconnect", "reconnecting", "reconnect"),
      observing(logger),
      () => moments.shift() ?? 0,
    );
    expect(logger.entries.map((entry) => entry.level)).toEqual([
      "warn",
      "info",
    ]);
    expect(logger.entries[1]).toEqual({
      level: "info",
      message: "bus connection restored",
      fields: {
        operation: "nats.connection",
        result: "ok",
        duration_us: 60_500_000,
      },
    });
  });

  it("reports each separate outage", async () => {
    const logger = recordingLogger();
    await watchBusStatus(
      statuses("disconnect", "reconnect", "disconnect", "reconnect"),
      observing(logger),
    );
    expect(logger.entries.map((entry) => entry.message)).toEqual([
      "bus connection lost",
      "bus connection restored",
      "bus connection lost",
      "bus connection restored",
    ]);
  });

  it("stays silent on status events unrelated to losing the bus", async () => {
    const logger = recordingLogger();
    await watchBusStatus(
      statuses("reconnect", "ping", "update"),
      observing(logger),
    );
    expect(logger.entries).toEqual([]);
  });
});
