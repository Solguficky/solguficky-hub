import { describe, expect, it, vi } from "vitest";
import type {
  TelegramRecipientResolver,
  TelegramRecipientResult,
} from "../identity/port.js";
import {
  createDeliverNotification,
  type DeliveryPolicy,
  retryDelayMs,
} from "./deliver.js";
import type { DeliveryNotification } from "./notification.js";
import type {
  DeliveryJournal,
  DeliveryRecord,
  NotificationSender,
  SendResult,
} from "./port.js";

const now = new Date("2026-09-26T10:00:00Z");
const policy: DeliveryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
};

function notification(
  overrides: Partial<DeliveryNotification> = {},
): DeliveryNotification {
  return {
    notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
    recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    content: {
      kind: "meetup-published",
      meetup: {
        id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
        title: "Настолки у Лёши",
        venue: "Циферблат",
        kind: "",
        when: { kind: "no-date" },
      },
    },
    ...overrides,
  };
}

function memoryJournal(
  initial: Record<string, DeliveryRecord> = {},
): DeliveryJournal & { records: Map<string, DeliveryRecord> } {
  const records = new Map(Object.entries(initial));
  return {
    records,
    async read(id) {
      return { kind: "ok", record: records.get(id) };
    },
    async write(id, record) {
      records.set(id, record);
      return { kind: "ok" };
    },
  };
}

function recipients(
  result: TelegramRecipientResult = {
    kind: "resolved",
    telegramUserId: 42n,
  },
): TelegramRecipientResolver {
  return { resolveTelegramUserId: vi.fn().mockResolvedValue(result) };
}

function sender(
  result: SendResult = { kind: "sent" },
): NotificationSender & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(result) };
}

function setup(
  options: {
    journal?: DeliveryJournal;
    recipients?: TelegramRecipientResolver;
    sender?: NotificationSender;
  } = {},
) {
  const journal = options.journal ?? memoryJournal();
  const send = options.sender ?? sender();
  const deliver = createDeliverNotification({
    journal,
    recipients: options.recipients ?? recipients(),
    sender: send,
    policy,
    now: () => now,
  });
  return { deliver, journal, send };
}

describe("deliver notification", () => {
  it("sends a new notification and marks it delivered", async () => {
    const journal = memoryJournal();
    const { deliver, send } = setup({ journal });
    await expect(deliver(notification(), 1)).resolves.toEqual({
      kind: "ack",
      outcome: "delivered",
    });
    expect(send.send).toHaveBeenCalledWith(
      expect.objectContaining({ telegramUserId: 42n }),
    );
    expect(journal.records.get(notification().notificationId)?.state).toBe(
      "delivered",
    );
  });

  // Критерий приёмки: рестарт не отправляет уже доставленное второй раз.
  // Повторная выдача после рестарта приходит тем же notification_id.
  it("does not send again what the journal already marks delivered", async () => {
    const journal = memoryJournal();
    const first = setup({ journal });
    await first.deliver(notification(), 1);
    const restarted = setup({ journal });
    await expect(restarted.deliver(notification(), 2)).resolves.toEqual({
      kind: "ack",
      outcome: "already_delivered",
    });
    expect(restarted.send.send).not.toHaveBeenCalled();
  });

  it("acknowledges an already dropped notification without sending", async () => {
    const journal = memoryJournal({
      [notification().notificationId]: {
        state: "dropped",
        attempts: 1,
        reason: "bot_blocked",
        at: now.toISOString(),
      },
    });
    const { deliver, send } = setup({ journal });
    await expect(deliver(notification(), 2)).resolves.toMatchObject({
      kind: "ack",
      outcome: "already_dropped",
    });
    expect(send.send).not.toHaveBeenCalled();
  });

  it("retries a notification left in the retrying state", async () => {
    const journal = memoryJournal({
      [notification().notificationId]: {
        state: "retrying",
        attempts: 1,
        at: now.toISOString(),
      },
    });
    const { deliver, send } = setup({ journal });
    await expect(deliver(notification(), 2)).resolves.toMatchObject({
      kind: "ack",
      outcome: "delivered",
    });
    expect(send.send).toHaveBeenCalledOnce();
  });

  // Критерий приёмки: заблокировавший бота получатель не вызывает повторов.
  it("drops a recipient who blocked the bot without retrying", async () => {
    const journal = memoryJournal();
    const { deliver } = setup({
      journal,
      sender: sender({ kind: "bot-blocked", cause: new Error("403") }),
    });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "drop",
      reason: "bot_blocked",
    });
    expect(journal.records.get(notification().notificationId)).toMatchObject({
      state: "dropped",
      reason: "bot_blocked",
    });
  });

  // Критерий приёмки: временный отказ Telegram приводит к повтору, а не потере.
  it("retries a temporary Telegram failure with a growing delay", async () => {
    const journal = memoryJournal();
    const { deliver } = setup({
      journal,
      sender: sender({ kind: "unavailable", cause: new Error("502") }),
    });
    await expect(deliver(notification(), 2)).resolves.toMatchObject({
      kind: "retry",
      reason: "telegram_unavailable",
      delayMs: 2_000,
    });
    expect(journal.records.get(notification().notificationId)).toMatchObject({
      state: "retrying",
      attempts: 2,
    });
  });

  it("waits as long as Telegram asks on a rate limit", async () => {
    const { deliver } = setup({
      sender: sender({
        kind: "rate-limited",
        retryAfterMs: 30_000,
        cause: new Error("429"),
      }),
    });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "retry",
      reason: "telegram_rate_limited",
      delayMs: 30_000,
    });
  });

  it("stops retrying once the attempts are exhausted", async () => {
    const { deliver } = setup({
      sender: sender({ kind: "unavailable", cause: new Error("502") }),
    });
    await expect(deliver(notification(), 3)).resolves.toMatchObject({
      kind: "drop",
      reason: "attempts_exhausted",
    });
  });

  it("drops an unknown or blocked recipient without calling Telegram", async () => {
    for (const [result, reason] of [
      [{ kind: "not-found" }, "recipient_not_found"],
      [{ kind: "blocked" }, "recipient_blocked"],
    ] as const) {
      const { deliver, send } = setup({ recipients: recipients(result) });
      await expect(deliver(notification(), 1)).resolves.toMatchObject({
        kind: "drop",
        reason,
      });
      expect(send.send).not.toHaveBeenCalled();
    }
  });

  it("retries when Identity is unavailable", async () => {
    const { deliver, send } = setup({
      recipients: recipients({ kind: "unavailable", cause: new Error("down") }),
    });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "retry",
      reason: "identity_unavailable",
      delayMs: 1_000,
    });
    expect(send.send).not.toHaveBeenCalled();
  });

  it("drops a type the channel cannot render yet instead of sending it", async () => {
    const { deliver, send } = setup();
    await expect(
      deliver(
        notification({
          content: { kind: "unrendered", type: "meetupReminder" },
        }),
        1,
      ),
    ).resolves.toMatchObject({ kind: "drop", reason: "unrendered_type" });
    expect(send.send).not.toHaveBeenCalled();
  });

  it("drops a notification past its deadline", async () => {
    const { deliver, send } = setup();
    await expect(
      deliver(notification({ notAfter: new Date("2026-09-26T09:00:00Z") }), 1),
    ).resolves.toMatchObject({ kind: "drop", reason: "expired" });
    expect(send.send).not.toHaveBeenCalled();
  });

  // Без журнала нельзя отличить новое от доставленного: отправка вслепую и
  // есть дубль, от которого журнал защищает.
  it("retries instead of sending blind when the journal is unavailable", async () => {
    const journal: DeliveryJournal = {
      read: async () => ({ kind: "unavailable", cause: new Error("kv") }),
      write: async () => ({ kind: "unavailable", cause: new Error("kv") }),
    };
    const { deliver, send } = setup({ journal });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "retry",
      reason: "journal_unavailable",
    });
    expect(send.send).not.toHaveBeenCalled();
  });

  it("acknowledges a sent notification even when the mark does not land", async () => {
    const journal: DeliveryJournal = {
      read: async () => ({ kind: "ok", record: undefined }),
      write: async () => ({ kind: "unavailable", cause: new Error("kv") }),
    };
    const { deliver } = setup({ journal });
    await expect(deliver(notification(), 1)).resolves.toEqual({
      kind: "ack",
      outcome: "delivered",
      journalMissed: true,
    });
  });
});

describe("retryDelayMs", () => {
  it("doubles from the base and stops at the ceiling", () => {
    expect(
      [1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, policy)),
    ).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
  });
});
