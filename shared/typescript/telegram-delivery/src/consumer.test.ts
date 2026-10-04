import { describe, expect, it, vi } from "vitest";
import {
  type DeliveryHandlerDeps,
  type DeliveryMessage,
  handleDeliveryMessage,
} from "./consumer.js";
import type { DeliverNotification, DeliveryDecision } from "./deliver.js";
import {
  type DecodeNotification,
  malformed,
  type OtherBranch,
} from "./notification.js";
import type { DeliveryLogger, FailureCategory } from "./observe.js";

type Note = { kind: "note" };

// Байты сообщения в тесте — UTF-8 вида канала: разбор Protobuf остаётся боту,
// а механике важен только исход разбора.
const decode: DecodeNotification<Note> = (data) => {
  const kind = new TextDecoder().decode(data);
  if (kind === "") return malformed("notification body");
  const content: Note | OtherBranch =
    kind === "note" ? { kind: "note" } : { kind: "foreign", type: kind };
  return {
    kind: "ok",
    notification: {
      notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
      recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      content,
    },
  };
};

function deps(
  overrides: Partial<DeliveryHandlerDeps<Note>> & {
    deliver: DeliverNotification<Note>;
  },
): DeliveryHandlerDeps<Note> & {
  failures: FailureCategory[];
  outcomes: string[];
} {
  const failures: FailureCategory[] = [];
  const outcomes: string[] = [];
  return {
    decode,
    logger: silentLogger(),
    countFailure: (category) => {
      failures.push(category);
    },
    recordOutcome: (outcome) => {
      outcomes.push(outcome);
    },
    failures,
    outcomes,
    ...overrides,
  };
}

function silentLogger(): DeliveryLogger & { entries: string[] } {
  const entries: string[] = [];
  const push = (message: string) => {
    entries.push(message);
  };
  return { entries, debug: push, info: push, warn: push, error: push };
}

function message(
  data: Uint8Array = new TextEncoder().encode("note"),
  deliveryCount = 1,
) {
  return {
    data,
    info: { deliveryCount },
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  } satisfies DeliveryMessage;
}

function deciding(decision: DeliveryDecision): DeliverNotification<Note> {
  return vi.fn().mockResolvedValue(decision);
}

describe("handleDeliveryMessage", () => {
  it("acknowledges a settled notification", async () => {
    const msg = message();
    await handleDeliveryMessage(
      msg,
      deps({
        deliver: deciding({ kind: "ack", outcome: "delivered" }),
        logger: silentLogger(),
      }),
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("asks the bus to redeliver after the decided delay", async () => {
    const msg = message();
    await handleDeliveryMessage(
      msg,
      deps({
        deliver: deciding({
          kind: "retry",
          reason: "telegram_unavailable",
          delayMs: 5_000,
        }),
        logger: silentLogger(),
      }),
    );
    expect(msg.nak).toHaveBeenCalledWith(5_000);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("terminates a dropped notification so the bus stops redelivering it", async () => {
    const msg = message();
    const logger = silentLogger();
    await handleDeliveryMessage(
      msg,
      deps({
        deliver: deciding({ kind: "drop", reason: "bot_blocked" }),
        logger,
      }),
    );
    expect(msg.term).toHaveBeenCalledWith("bot_blocked");
    expect(logger.entries).toContain("notification dropped");
  });

  // Принятый, но не нарисованный тип — дефект канала: автор видел «принято», а
  // получатель ничего не получил. Доставку он не роняет, но оператор его видит.
  it("reports an unrendered type as an error and still settles it", async () => {
    const msg = message();
    const levels: string[] = [];
    const leveled = (level: string) => (text: string) => {
      levels.push(`${level}:${text}`);
    };
    await handleDeliveryMessage(
      msg,
      deps({
        deliver: deciding({ kind: "drop", reason: "unrendered_type" }),
        logger: {
          debug: leveled("debug"),
          info: leveled("info"),
          warn: leveled("warn"),
          error: leveled("error"),
        },
      }),
    );
    expect(msg.term).toHaveBeenCalledWith("unrendered_type");
    expect(levels).toEqual(["error:notification dropped"]);
  });

  it("passes the bus delivery count as the attempt number", async () => {
    const deliver = deciding({ kind: "ack", outcome: "delivered" });
    await handleDeliveryMessage(
      message(undefined, 4),
      deps({
        deliver,
        logger: silentLogger(),
      }),
    );
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 4);
  });

  it("terminates bytes that are not a notification without deciding", async () => {
    const msg = message(new Uint8Array());
    const deliver = deciding({ kind: "ack", outcome: "delivered" });
    const logger = silentLogger();
    await handleDeliveryMessage(msg, deps({ deliver, logger }));
    expect(msg.term).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.entries).toContain("notification malformed");
  });

  // Дефект юзкейса не теряет сообщение молча: оно повторяется, пока попытки
  // не кончились, и снимается после.
  it("retries a failure of the use case until the attempts run out", async () => {
    const policy = { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 1_000 };
    const deliver: DeliverNotification<Note> = vi
      .fn()
      .mockRejectedValue(new Error("bug"));
    const first = message(undefined, 1);
    await handleDeliveryMessage(
      first,
      deps({
        deliver,
        logger: silentLogger(),
        policy,
      }),
    );
    expect(first.nak).toHaveBeenCalledWith(1_000);
    const last = message(undefined, 2);
    await handleDeliveryMessage(
      last,
      deps({
        deliver,
        logger: silentLogger(),
        policy,
      }),
    );
    expect(last.term).toHaveBeenCalledOnce();
  });

  it("counts the outcome and an expected drop as a failure category", async () => {
    const handled = deps({
      deliver: deciding({ kind: "drop", reason: "bot_blocked" }),
    });
    await handleDeliveryMessage(message(), handled);
    expect(handled.outcomes).toEqual(["bot_blocked"]);
    expect(handled.failures).toEqual(["authorization"]);
  });

  // Ветка другого канала — штатная жизнь общего потока: подтверждается, в
  // счётчике видна, а сбоем и предупреждением не считается.
  it("acknowledges a branch of another channel quietly", async () => {
    const levels: string[] = [];
    const leveled = (level: string) => (text: string) => {
      levels.push(`${level}:${text}`);
    };
    const msg = message(new TextEncoder().encode("lotOutbid"));
    const handled = deps({
      deliver: deciding({ kind: "ack", outcome: "foreign" }),
      logger: {
        debug: leveled("debug"),
        info: leveled("info"),
        warn: leveled("warn"),
        error: leveled("error"),
      },
    });
    await handleDeliveryMessage(msg, handled);
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(levels).toEqual(["debug:notification for another channel"]);
    expect(handled.outcomes).toEqual(["foreign"]);
    expect(handled.failures).toEqual([]);
  });
});
