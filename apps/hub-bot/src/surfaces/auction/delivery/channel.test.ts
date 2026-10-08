import { create, toBinary } from "@bufbuild/protobuf";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { NotificationSchema } from "../../../../gen/notifications/v1/notifications_pb.js";
import {
  createDeliverNotification,
  type DeliveryJournal,
  type DeliveryMessage,
  type DeliveryRecord,
  handleDeliveryMessage,
  type TelegramRecipientResolver,
} from "../../../core/delivery/index.js";
import type { Logger } from "../../../core/logging.js";
import {
  createNotificationSender,
  createRenderMessage,
  parseTraceCallback,
} from "./message.js";
import { decodeNotification } from "./notification.js";

// Канал бота аукциона целиком, кроме шины: байты факта, разбор этого бота,
// механика пакета доставки, текст и отправитель. Шину и KV с рестартом
// проверяет L1 бота хаба на той же механике пакета.

const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function outbid(id: number, recipient = 42) {
  return lotFact(id, recipient, "lotOutbid");
}

function lotFact(
  id: number,
  recipient: number,
  branch: "lotOutbid" | "lotProxyRaised",
) {
  return {
    data: toBinary(
      NotificationSchema,
      create(NotificationSchema, {
        notificationId: `0198f2a4-7c1e-7d3a-9b21-${String(id).padStart(12, "0")}`,
        recipientId: `0198f2a4-7c1e-7d3a-9b21-${String(recipient).padStart(12, "0")}`,
        createdAt: "2026-10-04T10:00:00Z",
        type: {
          case: branch,
          value: {
            lotId,
            currentPrice: { minorUnits: 150_000n, currency: "RUB" },
          },
        },
      }),
    ),
    info: { deliveryCount: 1 },
    ack: vi.fn(),
    nak: vi.fn(),
    term: vi.fn(),
  };
}

function memoryJournal(): DeliveryJournal {
  const records = new Map<string, DeliveryRecord>();
  return {
    async read(id) {
      return { kind: "ok", record: records.get(id) };
    },
    async write(id, record) {
      records.set(id, record);
      return { kind: "ok" };
    },
  };
}

// Telegram id получателя — последние цифры его identity_id: так тест видит,
// кому ушло сообщение.
const recipients: TelegramRecipientResolver = {
  async resolveTelegramUserId(identityId) {
    return {
      kind: "resolved",
      telegramUserId: BigInt(Number(identityId.slice(-12))),
    };
  },
};

function channel(
  journal: DeliveryJournal,
  sendMessage: ReturnType<typeof vi.fn>,
) {
  const deliver = createDeliverNotification({
    journal,
    recipients,
    render: createRenderMessage(
      { hasAuctionRight: async () => true, lotTitle: async () => "Кружка" },
      () => {},
    ),
    sender: createNotificationSender({ sendMessage } as never),
  });
  return (message: DeliveryMessage) =>
    handleDeliveryMessage(message, {
      decode: decodeNotification,
      deliver,
      logger: silent,
      countFailure: () => {},
      recordOutcome: () => {},
    });
}

describe("auction delivery channel", () => {
  // Критерий приёмки: факт перебития доходит сообщением с кнопкой на карточку.
  it("delivers an outbid fact as a message with the lot button", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const message = outbid(1);
    await channel(memoryJournal(), sendMessage)(message);
    expect(message.ack).toHaveBeenCalledOnce();
    const [chatId, text, options] = sendMessage.mock.calls[0] ?? [];
    expect(chatId).toBe(42);
    expect(text).toContain("«Кружка» перебили");
    const button = options.reply_markup.inline_keyboard[0][0];
    expect(button.text).toBe("К лоту");
    expect(parseTraceCallback(button.callback_data)).toContain(":lot:");
  });

  // Критерий приёмки: рестарт не доставляет уже доставленный факт повторно.
  // Повторная выдача после рестарта — тот же факт новому экземпляру канала с
  // тем же журналом.
  it("does not deliver a delivered fact again after a restart", async () => {
    const journal = memoryJournal();
    const sendMessage = vi.fn().mockResolvedValue({});
    await channel(journal, sendMessage)(outbid(1));
    const redelivered = outbid(1);
    await channel(journal, sendMessage)(redelivered);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(redelivered.ack).toHaveBeenCalledOnce();
  });

  // Критерий приёмки PER-473: автоставка лидера, ответившая сопернику, даёт
  // два факта одного события — перебитому и лидеру; каждый доходит своим
  // сообщением с «К лоту» и только один раз, сколько бы шина его ни выдавала.
  it("delivers the outbid to the rival and the proxy raise to the leader once each", async () => {
    const journal = memoryJournal();
    const sendMessage = vi.fn().mockResolvedValue({});
    const handle = channel(journal, sendMessage);
    await handle(lotFact(1, 41, "lotOutbid"));
    await handle(lotFact(2, 42, "lotProxyRaised"));
    await handle(lotFact(1, 41, "lotOutbid"));
    await handle(lotFact(2, 42, "lotProxyRaised"));

    expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([41, 42]);
    const [, rivalText] = sendMessage.mock.calls[0] ?? [];
    const [, leaderText, leaderOptions] = sendMessage.mock.calls[1] ?? [];
    expect(rivalText).toContain("перебили");
    expect(leaderText).toContain("Твоя автоставка на «Кружка»");
    const button = leaderOptions.reply_markup.inline_keyboard[0][0];
    expect(button.text).toBe("К лоту");
    expect(parseTraceCallback(button.callback_data)).toContain(":lot:");
  });

  // Критерий приёмки: заблокировавший бот человек не ломает следующие факты.
  it("drops a fact for a person who blocked the bot and delivers the next", async () => {
    const blocked = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked" },
      "sendMessage",
      {},
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(blocked)
      .mockResolvedValue({});
    const handle = channel(memoryJournal(), sendMessage);
    const first = outbid(1, 41);
    const second = outbid(2, 42);
    await handle(first);
    await handle(second);
    expect(first.term).toHaveBeenCalledWith("bot_blocked");
    expect(first.nak).not.toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([41, 42]);
  });
});
