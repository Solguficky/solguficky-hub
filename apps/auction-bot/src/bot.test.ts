import {
  encodeAuctionCallback,
  type LotImagePort,
  type LotView,
} from "@solguficky/auction-bot-ui";
import type { Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import { createBot } from "./bot.js";
import type { PortsFactory } from "./clients.js";
import { entryCallback } from "./faq.js";
import { createLogger, type Logger } from "./logging.js";
import { createPhotoCache, type PhotoCache } from "./photo-cache.js";

const botInfo: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: "stub",
  username: "stub_auction_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const lotId = "01926f3c-8b7a-7cde-8f00-0123456789ab";
const from = { id: 42, is_bot: false, first_name: "Person" };
const privateChat = { id: 42, type: "private" as const, first_name: "Person" };

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeBot(
  ports: PortsFactory,
  options: {
    logger?: Logger;
    refuse?: Record<string, string>;
    // Отказ только на первом вызове метода: повтор проходит.
    refuseOnce?: Record<string, string>;
    auctionId?: string;
    photos?: PhotoCache;
  } = {},
) {
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    ports,
    logger: options.logger ?? silent,
    timeZone: "Europe/Moscow",
    ...(options.auctionId === undefined
      ? {}
      : { auctionId: options.auctionId }),
    ...(options.photos === undefined ? {} : { photos: options.photos }),
    botInfo,
  });
  const calls: Array<{ method: string; payload: unknown }> = [];
  // Результат зависит от метода, фикстура его не знает: единственное
  // ослабление типа в тесте. Отказ Bot API задаётся описанием по методу.
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    const once = options.refuseOnce?.[method];
    if (once !== undefined && options.refuseOnce !== undefined) {
      delete options.refuseOnce[method];
      return Promise.resolve({ ok: false, error_code: 400, description: once });
    }
    const description = options.refuse?.[method];
    if (description !== undefined) {
      return Promise.resolve({ ok: false, error_code: 400, description });
    }
    // Отправка фото отвечает сообщением с размерами: из него бот берёт
    // `file_id` наибольшего размера. Тип результата зависит от метода, и
    // фикстура его не знает — то же ослабление, что у ответа `true` ниже.
    if (method === "sendPhoto" || method === "editMessageMedia") {
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 8,
          date: 0,
          chat: privateChat,
          photo: [
            { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
            { file_id: "large", file_unique_id: "l", width: 800, height: 800 },
          ],
        } as never,
      });
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(recorder);
  return { bot, calls };
}

const auctionId = "01926f3c-8b7a-7cde-8f00-0123456789ac";

function portsWith(
  overrides: {
    lot?: Partial<LotView>;
    image?: LotImagePort["getLotImage"];
  } = {},
): PortsFactory {
  return () => ({
    identity: {
      resolveIdentity: async () => ({
        identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
        globalRoles: ["public"],
        blocked: false,
      }),
    },
    auction: {
      getLot: async () => ({
        lotId,
        auctionId,
        version: 1,
        card: { title: "Кружка", description: "" },
        status: { kind: "unsold" },
        ...overrides.lot,
      }),
      listAuctionLots: async () => ({ lots: [], nextPageToken: "" }),
      getDisplayNames: async () => ({}),
    },
    faq: {
      acknowledged: async () => true,
      acknowledge: async () => {},
    },
    image: {
      getLotImage:
        overrides.image ??
        (async () => ({
          content: new Uint8Array([1, 2, 3]),
          mediaType: "image/jpeg",
          version: "img-1",
        })),
    },
  });
}

const publicPorts = portsWith();
const withImage = {
  card: { title: "Кружка", description: "", image: { version: "img-1" } },
};

function startUpdate(message: NonNullable<Update["message"]>): Update {
  return { update_id: 1, message };
}

describe("auction bot", () => {
  it("keeps completion across bot instances and permits reopening FAQ", async () => {
    let acknowledged = false;
    const ports: PortsFactory = (requestId) => ({
      ...publicPorts(requestId),
      faq: {
        acknowledged: async () => acknowledged,
        acknowledge: async () => {
          acknowledged = true;
        },
      },
    });
    const first = makeBot(ports);
    const start = startUpdate({
      message_id: 1,
      date: 0,
      chat: privateChat,
      from,
      text: "/start",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
    });
    await first.bot.handleUpdate(start);
    expect(first.calls[0]?.payload).toMatchObject({
      text: expect.stringContaining("Что продаём"),
    });
    expect(acknowledged).toBe(false);
    const press = (action: "menu" | "faq"): Update => ({
      update_id: 2,
      callback_query: {
        id: "entry-cb",
        from,
        chat_instance: "ci",
        data: entryCallback(action),
        message: { message_id: 7, date: 0, chat: privateChat, text: "old" },
      },
    });
    await first.bot.handleUpdate(press("menu"));
    expect(acknowledged).toBe(true);
    const restarted = makeBot(ports);
    await restarted.bot.handleUpdate(start);
    expect(restarted.calls[0]?.payload).toMatchObject({
      text: expect.stringContaining("Выберите раздел"),
    });
    await restarted.bot.handleUpdate(press("faq"));
    expect(restarted.calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Что продаём"),
    });
  });

  it("answers /start with the menu for a returning admitted participant", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendMessage");
    expect(calls[0]?.payload).toMatchObject({
      chat_id: 42,
      text: expect.stringContaining("Аукцион"),
    });
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [{ text: "Аукционы", callback_data: expect.any(String) }],
          [{ text: "Правила и FAQ", callback_data: expect.any(String) }],
        ],
      },
    });
  });

  it("stays silent in a group", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: { id: -100, type: "group", title: "Group" },
        from,
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls).toEqual([]);
  });

  it("answers the press before calling services and edits the screen through the gateway", async () => {
    const order: string[] = [];
    const ports = vi.fn<PortsFactory>((requestId) => {
      const base = publicPorts(requestId);
      return {
        identity: {
          resolveIdentity: async (user) => {
            order.push("identity");
            return base.identity.resolveIdentity(user);
          },
        },
        auction: base.auction,
        faq: base.faq,
        image: base.image,
      };
    });
    const { bot, calls } = makeBot(ports);
    const recorder: Transformer = (prev, method, payload, signal) => {
      order.push(method);
      return prev(method, payload, signal);
    };
    bot.api.config.use(recorder);
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
        message: {
          message_id: 7,
          date: 0,
          chat: privateChat,
          text: "old",
        },
      },
    } as Update);
    expect(order.indexOf("answerCallbackQuery")).toBeLessThan(
      order.indexOf("identity"),
    );
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      text: expect.stringContaining("Кружка"),
      reply_markup: {
        inline_keyboard: [
          [{ text: "Обновить", callback_data: expect.any(String) }],
          [{ text: "К лотам", callback_data: expect.any(String) }],
          [{ text: "Правила и FAQ", callback_data: expect.any(String) }],
          [{ text: "В меню", callback_data: expect.any(String) }],
        ],
      },
    });
    expect(ports).toHaveBeenCalledWith(expect.any(String));
  });

  it("sends a new message when the pressed message cannot be edited", async () => {
    const { bot, calls } = makeBot(publicPorts, {
      refuse: { editMessageText: "Bad Request: message can't be edited" },
    });
    await bot.handleUpdate(lotPress());
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload).toMatchObject({
      chat_id: 42,
      text: expect.stringContaining("Кружка"),
    });
  });

  // Пункт меню «Аукционы» при названном аукционе открывает его ленту.
  it("opens the feed from the menu when the auction is configured", async () => {
    const listAuctionLots = vi.fn(async () => ({
      lots: [],
      nextPageToken: "",
    }));
    const ports: PortsFactory = (requestId) => {
      const base = portsWith()(requestId);
      return { ...base, auction: { ...base.auction, listAuctionLots } };
    };
    const { bot, calls } = makeBot(ports, { auctionId });
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    expect(listAuctionLots).toHaveBeenCalledWith(
      expect.objectContaining({ auctionId, pageToken: "" }),
    );
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      text: expect.stringContaining("Лотов пока нет."),
    });
  });

  it("keeps the catalog closed in the menu without a configured auction", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      text: expect.stringContaining("Каталог пока не открыт"),
    });
  });

  // Текст не превращается в фото: карточка с изображением уходит новым
  // сообщением, а лента, с которой её открыли, удаляется.
  it("replaces a text message with the photo card and caches its file", async () => {
    const photos = createPhotoCache();
    const getLotImage = vi.fn(async () => ({
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "img-1",
    }));
    const { bot, calls } = makeBot(
      portsWith({ lot: withImage, image: getLotImage }),
      { photos },
    );
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "sendPhoto",
      "deleteMessage",
    ]);
    expect(calls[1]?.payload).toMatchObject({
      caption: expect.stringContaining("Кружка"),
    });
    expect(photos.get({ lotId, version: "img-1" })).toBe("large");
    expect(getLotImage).toHaveBeenCalledTimes(1);
  });

  it("edits a photo card in place from the cache without loading bytes", async () => {
    const photos = createPhotoCache();
    photos.set({ lotId, version: "img-1" }, "cached-file");
    const getLotImage = vi.fn();
    const { bot, calls } = makeBot(
      portsWith({ lot: withImage, image: getLotImage }),
      { photos },
    );
    await bot.handleUpdate(lotPress({ photo: true }));
    const edit = calls.find((call) => call.method === "editMessageMedia");
    expect(edit?.payload).toMatchObject({
      media: { type: "photo", media: "cached-file" },
    });
    expect(getLotImage).not.toHaveBeenCalled();
    expect(calls.map((call) => call.method)).not.toContain("deleteMessage");
  });

  it("uploads again once when Telegram forgets a cached file", async () => {
    const photos = createPhotoCache();
    photos.set({ lotId, version: "img-1" }, "forgotten");
    const { bot, calls } = makeBot(portsWith({ lot: withImage }), {
      photos,
      refuseOnce: { editMessageMedia: "Bad Request: wrong file identifier" },
    });
    await bot.handleUpdate(lotPress({ photo: true }));
    const edits = calls.filter((call) => call.method === "editMessageMedia");
    expect(edits).toHaveLength(2);
    // Второй раз уходят байты, и в кэш ложится свежий `file_id`.
    expect(edits[1]?.payload).not.toMatchObject({
      media: { media: "forgotten" },
    });
    expect(photos.get({ lotId, version: "img-1" })).toBe("large");
  });

  // Telegram отверг сами байты: карточка уходит текстом, а не пропадает.
  it("falls back to the text card when Telegram rejects the uploaded photo", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const { bot, calls } = makeBot(portsWith({ lot: withImage }), {
      logger,
      refuse: { sendPhoto: "Bad Request: IMAGE_PROCESS_FAILED" },
    });
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "sendPhoto",
      "editMessageText",
    ]);
    expect(
      lines.some((line) => line.includes("lot image rejected by Telegram")),
    ).toBe(true);
  });

  // Сейчас Auction отвечает на GetLotImage `UNIMPLEMENTED`: карточка остаётся
  // текстом, а не превращается в «недоступно».
  it("shows the card as text when the image cannot be loaded", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const { bot, calls } = makeBot(
      portsWith({
        lot: withImage,
        image: async () => {
          throw new Error("UNIMPLEMENTED");
        },
      }),
      { logger },
    );
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(lines.some((line) => line.includes("lot image unavailable"))).toBe(
      true,
    );
  });

  it("replaces a photo card with the text feed and drops the photo", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(
      lotPress({
        photo: true,
        data: encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
      }),
    );
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "sendMessage",
      "deleteMessage",
    ]);
  });

  it("logs the frame of the update without Telegram identifiers", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const { bot } = makeBot(publicPorts, { logger });
    await bot.handleUpdate(lotPress());
    const record = JSON.parse(lines.at(-1) ?? "{}");
    expect(record).toMatchObject({
      service: "auction-bot",
      operation: "callback",
      result: "ok",
      screen: "auction",
      request_id: expect.any(String),
      duration_us: expect.any(Number),
      identity_id: "01926f3c-8b7a-7cde-8f00-00000000000a",
    });
    expect(lines.join("")).not.toContain('"42"');
    expect(lines.join("")).not.toContain("v1:auc");
  });
});

// Нажатие кнопки в сообщении бота: текстовом или с фото.
function lotPress(options: { photo?: boolean; data?: string } = {}): Update {
  const base = { message_id: 7, date: 0, chat: privateChat };
  return {
    update_id: 3,
    callback_query: {
      id: "cb",
      from,
      chat_instance: "ci",
      data:
        options.data ?? encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
      message: options.photo
        ? {
            ...base,
            photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
            caption: "old",
          }
        : { ...base, text: "old" },
    },
  } as Update;
}
