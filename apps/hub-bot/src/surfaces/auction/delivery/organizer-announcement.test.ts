import { create, toBinary } from "@bufbuild/protobuf";
import { GrammyError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionNoticeSchema,
  NotificationSchema,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import { inspectCall } from "../../../../testkit/screen-lint.js";
import { parseAuctionCallback } from "../../../auction-ui/index.js";
import { createMediaChat } from "../../../core/media-chat.js";
import {
  createAnnouncementPhotos,
  wireAnnouncementButton,
  wireAnnouncementPhoto,
  wireAnnouncementPost,
} from "../../../core/notifications/organizer-announcement.js";
import {
  createNotificationSender,
  createRenderMessage,
  parseTraceCallback,
} from "./message.js";
import {
  type AuctionNotificationContent,
  decodeNotification,
} from "./notification.js";

// Объявление аукциона (PER-765) гостю: факт `auction_notice` бот аукциона
// разбирает, рисует простым текстом с кнопкой следа и отправляет с фото лота,
// прочитанным правами получателя; фото не прочиталось — уходит текст.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";
const photoId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1";
const recipientId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

function fact(withPhoto: boolean) {
  return toBinary(
    NotificationSchema,
    create(NotificationSchema, {
      notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000001",
      recipientId,
      createdAt: "2026-10-27T10:00:00Z",
      type: {
        case: "auctionNotice",
        value: create(AuctionNoticeSchema, {
          auctionId,
          body: "Ваза <ждёт> ставок & внимания",
          button: wireAnnouncementButton({ kind: "lot", lotId }),
          ...(withPhoto
            ? { photo: wireAnnouncementPhoto({ lotId, photoId }) }
            : {}),
        }),
      },
    }),
  );
}

async function delivered(withPhoto: boolean, readable: boolean) {
  const decoded = decodeNotification(fact(withPhoto));
  if (decoded.kind !== "ok") throw new Error(`decoded ${decoded.kind}`);
  const reads = { holdsPlaceBids: vi.fn(), lotInfo: vi.fn() };
  const rendered = await createRenderMessage(reads, () => {})(
    decoded.notification.content as AuctionNotificationContent,
    { recipientId },
  );
  if (rendered.kind !== "ready") throw new Error(`rendered ${rendered.kind}`);
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
  };
  const load = vi.fn(async () => {
    if (!readable) throw new Error("photo unavailable");
    return {
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "1",
    };
  });
  const sender = createNotificationSender(
    api as never,
    createAnnouncementPhotos(load, () => {}),
  );
  const result = await sender.send({
    telegramUserId: 42n,
    message: rendered.message,
  });
  return { result, calls, reads, load };
}

describe("organizer announcement to a guest", () => {
  it("sends the lot photo with the text as its caption and a traced lot button", async () => {
    const { result, calls, reads, load } = await delivered(true, true);

    expect(result).toEqual({ kind: "sent" });
    expect(reads.holdsPlaceBids).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith({ lotId, photoId }, recipientId);
    expect(calls.map((call) => call.method)).toEqual(["sendPhoto"]);
    const payload = calls[0]?.payload as {
      caption: string;
      reply_markup: {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
    };
    expect(payload.caption).toBe("Ваза <ждёт> ставок & внимания");
    const button = payload.reply_markup.inline_keyboard[0]?.[0];
    expect(button?.text).toBe("К лоту");
    const inner = parseTraceCallback(button?.callback_data ?? "");
    const parsed = parseAuctionCallback(inner ?? "");
    expect(parsed.ok && parsed.intent).toEqual({ kind: "lot", lotId, page: 0 });
    expect(
      calls.flatMap((call) =>
        inspectCall("auction", call.method, call.payload),
      ),
    ).toEqual([]);
  });

  it("sends the text alone when the lot photo cannot be read", async () => {
    const { result, calls } = await delivered(true, false);

    expect(result).toEqual({ kind: "sent" });
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({
      text: "Ваза <ждёт> ставок & внимания",
    });
  });

  it("sends the text without a photo when the fact names none", async () => {
    const { calls, load } = await delivered(false, true);

    expect(load).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  });

  it.each([
    ["predictions", { kind: "prediction", auctionId, round: "catalog" }],
    ["chronicle", { kind: "day-chronicle", auctionId }],
  ] as const)("opens the %s screen from a trace", async (kind, intent) => {
    const decoded = decodeNotification(
      toBinary(
        NotificationSchema,
        create(NotificationSchema, {
          notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000002",
          recipientId,
          createdAt: "2026-10-27T10:00:00Z",
          type: {
            case: "auctionNotice",
            value: create(AuctionNoticeSchema, {
              auctionId,
              body: "Текст",
              button: wireAnnouncementButton({ kind }),
            }),
          },
        }),
      ),
    );
    if (decoded.kind !== "ok") throw new Error("not decoded");
    const rendered = await createRenderMessage(
      { holdsPlaceBids: vi.fn(), lotInfo: vi.fn() },
      () => {},
    )(decoded.notification.content as AuctionNotificationContent, {
      recipientId,
    });
    if (rendered.kind !== "ready") throw new Error("not rendered");
    const data = rendered.message.rows?.[0]?.[0]?.callback_data ?? "";
    const parsed = parseAuctionCallback(parseTraceCallback(data) ?? "");
    expect(parsed.ok && parsed.intent).toEqual(intent);
  });

  // Своё фото или видео (PER-776): гость получает копию поста чата медиа с
  // текстом подписью и кнопкой; пост пропал — текст и запись об отказе.
  it.each([
    ["the post with the text as its caption", undefined],
    [
      "the text alone when the post is gone",
      { code: 400, description: "Bad Request: message to copy not found" },
    ],
    [
      "the text alone when the bot is out of the channel",
      {
        code: 403,
        description: "Forbidden: bot is not a member of the channel chat",
      },
    ],
  ])("sends %s", async (_name, refused) => {
    const present = refused === undefined;
    const channelId = -1001234567890;
    const decoded = decodeNotification(
      toBinary(
        NotificationSchema,
        create(NotificationSchema, {
          notificationId: "0198f2a4-7c1e-7d3a-9b21-000000000003",
          recipientId,
          createdAt: "2026-10-27T10:00:00Z",
          type: {
            case: "auctionNotice",
            value: create(AuctionNoticeSchema, {
              auctionId,
              body: "Смотри ролик",
              button: wireAnnouncementButton({ kind: "auction" }),
              photo: wireAnnouncementPost(42),
            }),
          },
        }),
      ),
    );
    if (decoded.kind !== "ok") throw new Error("not decoded");
    const rendered = await createRenderMessage(
      { holdsPlaceBids: vi.fn(), lotInfo: vi.fn() },
      () => {},
    )(decoded.notification.content as AuctionNotificationContent, {
      recipientId,
    });
    if (rendered.kind !== "ready") throw new Error("not rendered");
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const api = {
      sendMessage: vi.fn(async (chat_id: number, text: string, other) => {
        calls.push({
          method: "sendMessage",
          payload: { chat_id, text, ...other },
        });
        return { message_id: 1 };
      }),
      sendPhoto: vi.fn(),
      copyMessage: vi.fn(
        async (
          chat_id: number,
          from_chat_id: number,
          message_id: number,
          other,
        ) => {
          if (refused !== undefined) {
            throw new GrammyError(
              "refused",
              {
                ok: false,
                error_code: refused.code,
                description: refused.description,
              },
              "copyMessage",
              {},
            );
          }
          calls.push({
            method: "copyMessage",
            payload: { chat_id, from_chat_id, message_id, ...other },
          });
          return { message_id: 3 };
        },
      ),
    };
    const warn = vi.fn();
    const sender = createNotificationSender(
      api as never,
      createAnnouncementPhotos(vi.fn(), () => {}),
      createMediaChat({ channelId, logger: { warn } }),
    );

    expect(
      await sender.send({ telegramUserId: 42n, message: rendered.message }),
    ).toEqual({ kind: "sent" });
    expect(api.sendPhoto).not.toHaveBeenCalled();
    if (present) {
      expect(calls.map((call) => call.method)).toEqual(["copyMessage"]);
      expect(calls[0]?.payload).toMatchObject({
        chat_id: 42,
        from_chat_id: channelId,
        message_id: 42,
        caption: "Смотри ролик",
      });
      expect(warn).not.toHaveBeenCalled();
    } else {
      expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
      expect(warn).toHaveBeenCalledWith("media chat post not shown", {
        error_category: "dependency_unavailable",
        error: refused?.description,
        media_post_id: 42,
      });
    }
    const button = (
      calls[0]?.payload as
        | { reply_markup?: { inline_keyboard: { text: string }[][] } }
        | undefined
    )?.reply_markup?.inline_keyboard[0]?.[0];
    expect(button?.text).toBe("К аукциону");
    expect(
      calls.flatMap((call) =>
        inspectCall("auction", call.method, call.payload),
      ),
    ).toEqual([]);
  });
});
