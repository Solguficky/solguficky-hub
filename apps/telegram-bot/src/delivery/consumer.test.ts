import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { NotificationSchema } from "../../gen/notifications/v1/notifications_pb.js";
import type { Logger } from "../logging.js";
import { type DeliveryMessage, handleDeliveryMessage } from "./consumer.js";
import type { DeliverNotification, DeliveryDecision } from "./deliver.js";

function silentLogger(): Logger & { entries: string[] } {
  const entries: string[] = [];
  const push = (message: string) => {
    entries.push(message);
  };
  return { entries, debug: push, info: push, warn: push, error: push };
}

function message(
  data: Uint8Array = toBinary(
    NotificationSchema,
    create(NotificationSchema, {
      notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
      recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      createdAt: "2026-09-26T10:00:00Z",
      type: { case: "meetupReminder", value: {} },
    }),
  ),
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

function deciding(decision: DeliveryDecision): DeliverNotification {
  return vi.fn().mockResolvedValue(decision);
}

describe("handleDeliveryMessage", () => {
  it("acknowledges a settled notification", async () => {
    const msg = message();
    await handleDeliveryMessage(msg, {
      deliver: deciding({ kind: "ack", outcome: "delivered" }),
      logger: silentLogger(),
    });
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.nak).not.toHaveBeenCalled();
  });

  it("asks the bus to redeliver after the decided delay", async () => {
    const msg = message();
    await handleDeliveryMessage(msg, {
      deliver: deciding({
        kind: "retry",
        reason: "telegram_unavailable",
        delayMs: 5_000,
      }),
      logger: silentLogger(),
    });
    expect(msg.nak).toHaveBeenCalledWith(5_000);
    expect(msg.ack).not.toHaveBeenCalled();
  });

  it("terminates a dropped notification so the bus stops redelivering it", async () => {
    const msg = message();
    const logger = silentLogger();
    await handleDeliveryMessage(msg, {
      deliver: deciding({ kind: "drop", reason: "bot_blocked" }),
      logger,
    });
    expect(msg.term).toHaveBeenCalledWith("bot_blocked");
    expect(logger.entries).toContain("notification dropped");
  });

  it("passes the bus delivery count as the attempt number", async () => {
    const deliver = deciding({ kind: "ack", outcome: "delivered" });
    await handleDeliveryMessage(message(undefined, 4), {
      deliver,
      logger: silentLogger(),
    });
    expect(deliver).toHaveBeenCalledWith(expect.anything(), 4);
  });

  it("terminates bytes that are not a notification without deciding", async () => {
    const msg = message(new Uint8Array([0xff, 0xff, 0xff]));
    const deliver = deciding({ kind: "ack", outcome: "delivered" });
    const logger = silentLogger();
    await handleDeliveryMessage(msg, { deliver, logger });
    expect(msg.term).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.entries).toContain("notification malformed");
  });

  // Дефект юзкейса не теряет сообщение молча: оно повторяется, пока попытки
  // не кончились, и снимается после.
  it("retries a failure of the use case until the attempts run out", async () => {
    const policy = { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 1_000 };
    const deliver: DeliverNotification = vi
      .fn()
      .mockRejectedValue(new Error("bug"));
    const first = message(undefined, 1);
    await handleDeliveryMessage(first, {
      deliver,
      logger: silentLogger(),
      policy,
    });
    expect(first.nak).toHaveBeenCalledWith(1_000);
    const last = message(undefined, 2);
    await handleDeliveryMessage(last, {
      deliver,
      logger: silentLogger(),
      policy,
    });
    expect(last.term).toHaveBeenCalledOnce();
  });
});
