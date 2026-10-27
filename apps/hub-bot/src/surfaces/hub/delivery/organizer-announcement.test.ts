import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionNoticeSchema,
  NotificationSchema,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import { inspectCall } from "../../../../testkit/screen-lint.js";
import { encodeAuctionCallback } from "../../../auction-ui/index.js";
import {
  createAnnouncementPhotos,
  wireAnnouncementButton,
  wireAnnouncementPhoto,
} from "../../../core/notifications/organizer-announcement.js";
import { createNotificationSender } from "../presentation/notification-message.js";
import { decodeNotification } from "./notification.js";

// Объявление аукциона (PER-765) участнику: факт `auction_notice` бот хаба
// разбирает, а отправитель шлёт фото лота правами получателя с текстом
// подписью и кнопкой следа на экран дерева; фото не прочиталось — текст.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
const photoId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1";
const recipientId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

function decoded() {
  const result = decodeNotification(
    toBinary(
      NotificationSchema,
      create(NotificationSchema, {
        notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
        recipientId,
        createdAt: "2026-10-27T10:00:00Z",
        type: {
          case: "auctionNotice",
          value: create(AuctionNoticeSchema, {
            auctionId,
            body: "Розыгрыш <открыт>",
            button: wireAnnouncementButton({ kind: "raffle" }),
            photo: wireAnnouncementPhoto({ lotId, photoId }),
          }),
        },
      }),
    ),
  );
  if (result.kind !== "ok") throw new Error(`decoded ${result.kind}`);
  return result.notification.content;
}

function sender(readable: boolean) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = {
    sendMessage: vi.fn(async (chat_id: number, text: string, other) => {
      calls.push({
        method: "sendMessage",
        payload: { chat_id, text, ...other },
      });
      return { message_id: 1 };
    }),
    sendPhoto: vi.fn(async (chat_id: number, _photo: unknown, other) => {
      calls.push({ method: "sendPhoto", payload: { chat_id, ...other } });
      return { message_id: 2, photo: [{ file_id: "f" }] };
    }),
    setMyCommands: vi.fn(),
    deleteMyCommands: vi.fn(),
  };
  const load = vi.fn(async () => {
    if (!readable) throw new Error("photo unavailable");
    return {
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "1",
    };
  });
  return {
    calls,
    load,
    send: createNotificationSender(
      api as never,
      undefined,
      undefined,
      "UTC",
      createAnnouncementPhotos(load, () => {}),
    ),
  };
}

describe("organizer announcement to a member", () => {
  it("decodes the fact with its button and photo", () => {
    expect(decoded()).toEqual({
      kind: "organizer-announcement",
      auctionId,
      text: "Розыгрыш <открыт>",
      button: { kind: "raffle" },
      photo: { lotId, photoId },
    });
  });

  it("sends the lot photo read with the rights of the recipient and a traced raffle button", async () => {
    const hub = sender(true);
    const content = decoded();
    if (content.kind !== "organizer-announcement") throw new Error("kind");
    await expect(
      hub.send.send({
        telegramUserId: 42n,
        message: { ...content, viewerId: recipientId },
      }),
    ).resolves.toEqual({ kind: "sent" });

    expect(hub.load).toHaveBeenCalledWith({ lotId, photoId }, recipientId);
    expect(hub.calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    expect(hub.calls[0]?.payload).toMatchObject({
      caption: "Розыгрыш <открыт>",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "К розыгрышу",
              callback_data: `v1:t:${encodeAuctionCallback({ kind: "raffle", auctionId }).slice(3)}`,
            },
          ],
        ],
      },
    });
    expect(
      hub.calls.flatMap((call) =>
        inspectCall("hub", call.method, call.payload),
      ),
    ).toEqual([]);
  });

  it("sends the text alone when the lot photo cannot be read", async () => {
    const hub = sender(false);
    const content = decoded();
    if (content.kind !== "organizer-announcement") throw new Error("kind");
    await hub.send.send({
      telegramUserId: 42n,
      message: { ...content, viewerId: recipientId },
    });

    expect(hub.calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(hub.calls[0]?.payload).toMatchObject({ text: "Розыгрыш <открыт>" });
  });
});
