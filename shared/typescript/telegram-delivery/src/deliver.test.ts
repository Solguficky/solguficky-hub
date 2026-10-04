import { describe, expect, it, vi } from "vitest";
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
  RenderMessage,
  RenderResult,
  SendResult,
  TelegramRecipientResolver,
  TelegramRecipientResult,
} from "./port.js";

// Содержимое канала в тесте механики: пакету всё равно, что в нём лежит.
type Note = { kind: "note"; text: string };

const now = new Date("2026-09-26T10:00:00Z");
const policy: DeliveryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
};

function notification(
  overrides: Partial<DeliveryNotification<Note>> = {},
): DeliveryNotification<Note> {
  return {
    notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
    recipientId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    content: { kind: "note", text: "Настолки у Лёши" },
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
): NotificationSender<string> & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(result) };
}

// Сообщение — текст записки; рендер можно подменить отказом.
const renderText: RenderMessage<Note, string> = async (content) => ({
  kind: "ready",
  message: content.text,
});

function rendering(result: RenderResult<string>): RenderMessage<Note, string> {
  return vi.fn().mockResolvedValue(result);
}

function setup(
  options: {
    journal?: DeliveryJournal;
    recipients?: TelegramRecipientResolver;
    render?: RenderMessage<Note, string>;
    sender?: NotificationSender<string>;
  } = {},
) {
  const journal = options.journal ?? memoryJournal();
  const send = options.sender ?? sender();
  const deliver = createDeliverNotification({
    journal,
    recipients: options.recipients ?? recipients(),
    render: options.render ?? renderText,
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

  // Сообщение собирает рендер канала, а отправляется готовое: пакет текста не
  // знает. Повтор шиной после отметки второй раз не отправляет.
  it("sends the rendered message once", async () => {
    const journal = memoryJournal();
    const { deliver, send } = setup({ journal });
    await deliver(notification(), 1);
    await deliver(notification(), 2);
    expect(send.send).toHaveBeenCalledOnce();
    expect(send.send).toHaveBeenCalledWith({
      telegramUserId: 42n,
      message: "Настолки у Лёши",
    });
  });

  it("passes the recipient and the request id to the renderer", async () => {
    const render = rendering({ kind: "ready", message: "text" });
    const { deliver } = setup({ render });
    await deliver(notification({ requestId: "req-1" }), 1);
    expect(render).toHaveBeenCalledWith(
      { kind: "note", text: "Настолки у Лёши" },
      { recipientId: notification().recipientId, requestId: "req-1" },
    );
  });

  it("passes the request id to Identity", async () => {
    const resolver = recipients();
    const { deliver } = setup({ recipients: resolver });
    await deliver(notification({ requestId: "req-1" }), 1);
    expect(resolver.resolveTelegramUserId).toHaveBeenCalledWith(
      notification().recipientId,
      "req-1",
    );
  });

  // Получатель без права на предмет сообщения не получит его и позже: отказ
  // окончательный, Telegram не зовётся.
  it("drops a recipient the renderer finds ineligible", async () => {
    const journal = memoryJournal();
    const { deliver, send } = setup({
      journal,
      render: rendering({ kind: "ineligible" }),
    });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "drop",
      reason: "recipient_ineligible",
    });
    expect(send.send).not.toHaveBeenCalled();
    expect(journal.records.get(notification().notificationId)?.state).toBe(
      "dropped",
    );
  });

  // Отказ соседа, который повтор не изменит, снимается сразу, а не крутится
  // до исчерпания попыток.
  it("drops a notification the renderer cannot build for good", async () => {
    const { deliver, send } = setup({
      render: rendering({ kind: "rejected", cause: new Error("not found") }),
    });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "drop",
      reason: "render_rejected",
    });
    expect(send.send).not.toHaveBeenCalled();
  });

  it("retries when the renderer cannot reach a neighbour", async () => {
    const { deliver, send } = setup({
      render: rendering({ kind: "unavailable", cause: new Error("down") }),
    });
    await expect(deliver(notification(), 1)).resolves.toMatchObject({
      kind: "retry",
      reason: "render_unavailable",
      delayMs: 1_000,
    });
    expect(send.send).not.toHaveBeenCalled();
  });

  // Ветка другого канала общего потока — не отказ: журнал о ней молчит, и ни
  // Identity, ни Telegram не зовутся.
  it("acknowledges a branch of another channel without touching the journal", async () => {
    const journal = memoryJournal();
    const resolver = recipients();
    const { deliver, send } = setup({ journal, recipients: resolver });
    await expect(
      deliver(
        notification({ content: { kind: "foreign", type: "lotOutbid" } }),
        1,
      ),
    ).resolves.toEqual({ kind: "ack", outcome: "foreign" });
    expect(journal.records.size).toBe(0);
    expect(resolver.resolveTelegramUserId).not.toHaveBeenCalled();
    expect(send.send).not.toHaveBeenCalled();
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

  it("drops a type the channel cannot render instead of sending it", async () => {
    const { deliver, send } = setup();
    await expect(
      deliver(
        notification({
          content: { kind: "unrendered", type: "unknown" },
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
