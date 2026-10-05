import { Code, ConnectError } from "@connectrpc/connect";
import {
  type EntryPort,
  encodeAuctionCallback,
  type LotImagePort,
  type LotView,
} from "@solguficky/auction-bot-ui";
import { HttpError, InputFile, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../gen/identity/v1/roles_pb.js";
import { inspectCall, reportViolations } from "../testkit/screen-lint.js";
import { createBot } from "./bot.js";
import {
  type AuctionRpc,
  createPorts,
  type IdentityRpc,
  type PortsFactory,
} from "./clients.js";
import { traceLotCallback } from "./delivery/message.js";
import { deniedTexts } from "./entry-screen.js";
import { entryCallback } from "./faq.js";
import { createLogger, type Logger } from "./logging.js";
import { createPhotoCache, type PhotoCache } from "./photo-cache.js";
import {
  actionBudgetMs,
  pressWatchdogMs,
  typingAfterMs,
  typingEveryMs,
} from "./waiting.js";

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

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeBot(
  ports: PortsFactory,
  options: {
    logger?: Logger;
    refuse?: Record<string, string>;
    // Отказ только на первом вызове метода: повтор проходит.
    refuseOnce?: Record<string, string>;
    auctionId?: string;
    photos?: PhotoCache;
    presentation?: "rich" | "plain";
    // Обрыв соединения на первом вызове метода.
    dropOnce?: string;
  } = {},
) {
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    ...(options.presentation === undefined
      ? {}
      : { presentation: options.presentation }),
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
    // Каждый экран сверяется с каталогом и дизайн-кодом в момент отправки;
    // найденное снимает хук набора (`testkit/lint-setup.ts`).
    reportViolations(inspectCall(method, payload));
    if (options.dropOnce === method) {
      delete options.dropOnce;
      return Promise.reject(
        new HttpError("Network request failed", new Error("socket hang up")),
      );
    }
    const once = options.refuseOnce?.[method];
    if (once !== undefined && options.refuseOnce !== undefined) {
      delete options.refuseOnce[method];
      return Promise.resolve({ ok: false, error_code: 400, description: once });
    }
    const description = options.refuse?.[method];
    if (description !== undefined) {
      return Promise.resolve({ ok: false, error_code: 400, description });
    }
    // Rich-сообщение и его правка отвечают сообщением: блок фото несёт
    // размеры, из которых бот берёт `file_id` наибольшего. Тип результата
    // зависит от метода, и фикстура его не знает — то же ослабление, что у
    // ответа `true` ниже.
    const rich = (payload as { rich_message?: { media?: unknown[] } })
      .rich_message;
    if (rich !== undefined) {
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 8,
          date: 0,
          chat: privateChat,
          rich_message: {
            blocks: rich.media === undefined ? [] : [photoBlock],
          },
        } as never,
      });
    }
    return Promise.resolve({ ok: true, result: true as never });
  };
  bot.api.config.use(recorder);
  return { bot, calls };
}

const auctionId = "01926f3c-8b7a-7cde-8f00-0123456789ac";

const photoBlock = {
  type: "photo",
  photo: [
    { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
    { file_id: "large", file_unique_id: "l", width: 800, height: 800 },
  ],
};

function portsWith(
  overrides: {
    lot?: Partial<LotView>;
    image?: LotImagePort["getLotImage"];
    entry?: EntryPort["requestRole"];
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
    entry: {
      requestRole:
        overrides.entry ??
        (async () => ({
          identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
          globalRoles: ["public"],
          outcome: "already-held",
        })),
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

  it("answers /start with a channel or a foreign payload like a plain /start", async () => {
    const answer = async (text: string) => {
      const { bot, calls } = makeBot(publicPorts);
      await bot.handleUpdate(
        startUpdate({
          message_id: 1,
          date: 0,
          chat: privateChat,
          from,
          text,
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        }),
      );
      return calls.map((call) => call.payload);
    };
    const plain = await answer("/start");
    for (const text of [
      "/start s_tg_ads",
      "/start s_",
      "/start m_AZLzpLXGfY6fChssPU5fYA",
      "/start not a payload",
    ]) {
      expect(await answer(text)).toEqual(plain);
    }
  });

  // Код канала — недоверенный хвост `s_<код>`: до Identity он едет как пришёл,
  // а payload без префикса кода не несёт (ADR-060, пункты 17–18).
  it.each([
    ["/start s_tg_ads", { sourceCode: "tg_ads" }],
    ["/start s_", { sourceCode: "" }],
    ["/start m_AZLzpLXGfY6fChssPU5fYA", {}],
    ["/start", {}],
  ])(
    "enters on %s with the public circle and the first name",
    async (text, code) => {
      const requestRole = vi.fn<EntryPort["requestRole"]>(async () => ({
        identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
        globalRoles: [],
        outcome: "pending",
      }));
      const { bot, calls } = makeBot(portsWith({ entry: requestRole }));
      await bot.handleUpdate(
        startUpdate({
          message_id: 1,
          date: 0,
          chat: privateChat,
          from,
          text,
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        }),
      );
      expect(requestRole).toHaveBeenCalledExactlyOnceWith({
        user: { telegramUserId: 42 },
        requestedRole: "public",
        firstName: "Person",
        ...code,
      });
      expect(calls.map((call) => call.payload)).toMatchObject([
        { text: deniedTexts["not-admitted"] },
      ]);
    },
  );

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

  it("answers the press with the result after the services and edits the screen through the gateway", async () => {
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
        entry: base.entry,
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
    expect(order.indexOf("answerCallbackQuery")).toBeGreaterThan(
      order.indexOf("identity"),
    );
    expect(order.indexOf("answerCallbackQuery")).toBe(
      order.indexOf("editMessageText") - 1,
    );
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      rich_message: { html: expect.stringContaining("Кружка") },
      reply_markup: {
        inline_keyboard: [
          [{ text: "Обновить", callback_data: expect.any(String) }],
          [{ text: "К лотам", callback_data: expect.any(String) }],
          [{ text: "Правила и FAQ", callback_data: expect.any(String) }],
          [{ text: "В меню", callback_data: expect.any(String) }],
        ],
      },
    });
    expect(ports).toHaveBeenCalledWith(expect.any(String), expect.any(Number));
  });

  it("sends a new message when the pressed message cannot be edited", async () => {
    const { bot, calls } = makeBot(publicPorts, {
      refuse: { editMessageText: "Bad Request: message can't be edited" },
    });
    await bot.handleUpdate(lotPress());
    const sent = calls.find((call) => call.method === "sendRichMessage");
    expect(sent?.payload).toMatchObject({
      chat_id: 42,
      rich_message: { html: expect.stringContaining("Кружка") },
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

  // Лента и карточка делят одно сообщение: нажатие на лот правит ленту в
  // rich-карточку с загруженным фото, «‹ Лоты» правит её обратно в текст.
  it("edits the feed into the photo card and back without deleting", async () => {
    const photos = createPhotoCache();
    const description = "Роспись. ".repeat(250);
    const getLotImage = vi.fn(async () => ({
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "img-1",
    }));
    const { bot, calls } = makeBot(
      portsWith({
        lot: { card: { ...withImage.card, description } },
        image: getLotImage,
      }),
      { photos },
    );
    await bot.handleUpdate(lotPress());
    await bot.handleUpdate(
      lotPress({
        rich: true,
        data: encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
      }),
    );
    // Загрузка доставляет карточку: ответ на нажатие уходит с её концом.
    expect(calls.map((call) => call.method)).toEqual([
      "editMessageText",
      "answerCallbackQuery",
      "answerCallbackQuery",
      "editMessageText",
    ]);
    const card = calls[0]?.payload as {
      rich_message: { html: string; media: { media: { media: unknown } }[] };
    };
    // Описание длиннее предела подписи к фото приходит целиком, фото — под ним.
    expect(description.length).toBeGreaterThan(1024);
    expect(card.rich_message.html).toContain(description.trim());
    expect(card.rich_message.html).toMatch(
      /<img src="tg:\/\/photo\?id=lot"\/>$/,
    );
    expect(card.rich_message.media[0]?.media.media).toBeInstanceOf(InputFile);
    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "file",
      fileId: "large",
    });
    expect(calls[3]?.payload).toMatchObject({
      text: expect.stringContaining("Лотов пока нет."),
    });
    expect(calls[3]?.payload).not.toHaveProperty("rich_message");
  });

  it("shows the card again from the cached file without loading bytes", async () => {
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
    await bot.handleUpdate(lotPress());
    expect(getLotImage).toHaveBeenCalledTimes(1);
    const edits = calls.filter((call) => call.method === "editMessageText");
    expect(edits[1]?.payload).toMatchObject({
      rich_message: { media: [{ id: "lot", media: { media: "large" } }] },
    });
  });

  // Кнопка «К лоту» под уведомлением (PER-328): карточка приходит новым
  // сообщением, а уведомление не правится и не удаляется (дизайн-код,
  // «Доставка»).
  it("opens the lot under a notification as a new message and keeps it", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: traceLotCallback(lotId) }));
    // Порядок ответа на нажатие задаёт правило ожидания; здесь важно только,
    // что карточка ушла новым сообщением, а уведомление не тронуто.
    expect(
      calls.map((call) => call.method).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["answerCallbackQuery", "sendRichMessage"]);
    expect(calls[1]?.payload).toMatchObject({
      rich_message: { html: expect.stringContaining("Кружка") },
    });
  });

  // След, который эта сборка уже не читает, отвечает «устарело» новым
  // сообщением: уведомление под ним всё равно не затирается.
  it("keeps the notification under a trace it cannot read", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: "v1:t:v0:auc:lot:gone:0" }));
    const methods = calls.map((call) => call.method);
    expect(methods).not.toContain("editMessageText");
    expect(methods).not.toContain("editMessageReplyMarkup");
    expect(methods).not.toContain("deleteMessage");
    expect(methods).toContain("sendMessage");
  });

  it("keeps the notification whole when the lot card carries a photo", async () => {
    const { bot, calls } = makeBot(portsWith({ lot: withImage }));
    await bot.handleUpdate(lotPress({ data: traceLotCallback(lotId) }));
    expect(
      calls.map((call) => call.method).sort((a, b) => a.localeCompare(b)),
    ).toEqual(["answerCallbackQuery", "sendRichMessage"]);
  });

  it("uploads again once when Telegram forgets a cached file", async () => {
    const photos = createPhotoCache();
    photos.set({ lotId, version: "img-1" }, "forgotten");
    const { bot, calls } = makeBot(portsWith({ lot: withImage }), {
      photos,
      refuseOnce: { editMessageText: "Bad Request: wrong file identifier" },
    });
    await bot.handleUpdate(lotPress());
    const edits = calls.filter((call) => call.method === "editMessageText");
    expect(edits).toHaveLength(2);
    // Второй раз уходят байты, и в кэш ложится свежий `file_id`.
    expect(edits[1]?.payload).not.toMatchObject({
      rich_message: { media: [{ media: { media: "forgotten" } }] },
    });
    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "file",
      fileId: "large",
    });
  });

  // Telegram отверг сами байты: сообщение прежнее, и та же правка уходит без
  // фото. Эта версия изображения больше не загружается.
  it("edits the card without the photo Telegram rejected and stops uploading it", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const photos = createPhotoCache();
    const getLotImage = vi.fn(async () => ({
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "img-1",
    }));
    const { bot, calls } = makeBot(
      portsWith({ lot: withImage, image: getLotImage }),
      {
        logger,
        photos,
        refuseOnce: { editMessageText: "Bad Request: IMAGE_PROCESS_FAILED" },
      },
    );
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.method)).toEqual([
      "editMessageText",
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[2]?.payload).not.toMatchObject({
      rich_message: { media: expect.anything() },
    });
    expect(
      lines.some((line) => line.includes("lot image rejected by Telegram")),
    ).toBe(true);
    await bot.handleUpdate(lotPress());
    expect(getLotImage).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)?.payload).not.toMatchObject({
      rich_message: { media: expect.anything() },
    });
  });

  // Отказ, который повторился и без фото, — не про изображение: лимит,
  // права или разметка. Версия не помечается, экран не подменяется.
  it("does not mark the photo when the edit fails without it too", async () => {
    const photos = createPhotoCache();
    const { bot } = makeBot(portsWith({ lot: withImage }), {
      photos,
      refuse: { editMessageText: "Too Many Requests: retry after 5" },
    });
    await expect(bot.handleUpdate(lotPress())).rejects.toThrow(
      "Too Many Requests",
    );
    expect(photos.get({ lotId, version: "img-1" })).toBeUndefined();
  });

  // Новое сообщение после обрыва не повторяется: Telegram мог его принять,
  // и повтор прислал бы второе. Update при этом пишется отказом, а не успехом.
  it("does not send the card twice when a new message upload drops", async () => {
    const { bot, calls } = makeBot(portsWith({ lot: withImage }), {
      dropOnce: "sendRichMessage",
    });
    await expect(bot.handleUpdate(lotPress({ photo: true }))).rejects.toThrow(
      "Network request failed",
    );
    expect(
      calls.filter((call) => call.method === "sendRichMessage"),
    ).toHaveLength(1);
  });

  // Обрыв соединения отметки не оставляет: следующее открытие грузит снова.
  it("shows the card without the photo when the upload connection drops", async () => {
    const photos = createPhotoCache();
    const getLotImage = vi.fn(async () => ({
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "img-1",
    }));
    const { bot, calls } = makeBot(
      portsWith({ lot: withImage, image: getLotImage }),
      { photos, dropOnce: "editMessageText" },
    );
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.method)).toEqual([
      "editMessageText",
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[2]?.payload).not.toMatchObject({
      rich_message: { media: expect.anything() },
    });
    expect(photos.get({ lotId, version: "img-1" })).toBeUndefined();
    await bot.handleUpdate(lotPress());
    expect(getLotImage).toHaveBeenCalledTimes(2);
  });

  // Изображение может не загрузиться — сбой GetLotImage: карточка остаётся
  // без фото, а не превращается в «недоступно».
  it("shows the card without a photo when the image cannot be loaded", async () => {
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
    expect(calls[1]?.payload).toMatchObject({
      rich_message: { html: expect.stringContaining("<h1>Кружка</h1>") },
    });
    expect(calls[1]?.payload).not.toMatchObject({
      rich_message: { media: expect.anything() },
    });
    expect(lines.some((line) => line.includes("lot image unavailable"))).toBe(
      true,
    );
  });

  // Правка не прошла не из-за изображения: новое сообщение загрузку не
  // повторяет и идёт без фото, раз в кэше его нет.
  it("sends a new card without uploading again when the edit is refused", async () => {
    const getLotImage = vi.fn(async () => ({
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: "img-1",
    }));
    const { bot, calls } = makeBot(
      portsWith({ lot: withImage, image: getLotImage }),
      { refuse: { editMessageText: "Bad Request: message can't be edited" } },
    );
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.method)).toEqual([
      "editMessageText",
      "answerCallbackQuery",
      "sendRichMessage",
    ]);
    expect(calls[2]?.payload).not.toMatchObject({
      rich_message: { media: expect.anything() },
    });
    expect(getLotImage).toHaveBeenCalledTimes(1);
  });

  // Сообщение-фото от прежней версии бота в текст не правится: экран приходит
  // новым сообщением, у фото снимается клавиатура, удаления нет.
  it("answers under a legacy photo message with a new message", async () => {
    const photos = createPhotoCache();
    photos.set({ lotId, version: "img-1" }, "cached-file");
    const { bot, calls } = makeBot(portsWith({ lot: withImage }), { photos });
    await bot.handleUpdate(lotPress({ photo: true }));
    await bot.handleUpdate(
      lotPress({
        photo: true,
        data: encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
      }),
    );
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "sendRichMessage",
      "editMessageReplyMarkup",
      "answerCallbackQuery",
      "sendMessage",
      "editMessageReplyMarkup",
    ]);
    expect(calls[1]?.payload).toMatchObject({
      rich_message: { media: [{ media: { media: "cached-file" } }] },
    });
  });

  it("sends the plain card as an HTML message without a photo", async () => {
    const getLotImage = vi.fn();
    const { bot, calls } = makeBot(
      portsWith({ lot: withImage, image: getLotImage }),
      { presentation: "plain" },
    );
    await bot.handleUpdate(lotPress());
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      parse_mode: "HTML",
      text: expect.stringMatching(/^<b>Кружка<\/b>/),
    });
    expect(edit?.payload).not.toHaveProperty("rich_message");
    expect(getLotImage).not.toHaveBeenCalled();
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

// Правило ожидания дизайн-кода на собранном боте. Сервис здесь — обещание,
// которое отвечает по фальшивым таймерам: так видно, что человек получает
// между нажатием и результатом.
describe("waiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const methods = (calls: ReadonlyArray<{ method: string }>) =>
    calls.map((call) => call.method);
  const withoutTyping = (calls: ReadonlyArray<{ method: string }>) =>
    methods(calls).filter((method) => method !== "sendChatAction");

  // Порты, у которых Auction отдаёт лот через `delayMs` либо когда скажет тест.
  function slowLot(delayMs?: number) {
    let respond: () => void = () => undefined;
    const ports: PortsFactory = (requestId, deadlineAt) => {
      const base = publicPorts(requestId, deadlineAt);
      return {
        ...base,
        auction: {
          ...base.auction,
          getLot: (request) =>
            new Promise((resolve) => {
              respond = () => resolve(base.auction.getLot(request));
              if (delayMs !== undefined) setTimeout(respond, delayMs);
            }),
        },
      };
    };
    return { ports, respond: () => respond() };
  }

  it("shows typing while Auction is slow and answers the press with the result", async () => {
    const { bot, calls } = makeBot(slowLot(1_500).ports);

    const handled = bot.handleUpdate(lotPress());
    await vi.advanceTimersByTimeAsync(typingAfterMs - 1);
    expect(methods(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(methods(calls)).toEqual(["sendChatAction"]);
    expect(calls[0]?.payload).toMatchObject({ chat_id: 42, action: "typing" });

    await vi.advanceTimersByTimeAsync(500);
    await handled;
    await vi.advanceTimersByTimeAsync(typingEveryMs * 2);
    expect(methods(calls)).toEqual([
      "sendChatAction",
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[1]?.payload).not.toHaveProperty("text");
  });

  // Транспорт Connect обрывает вызов по `timeoutMs`; фальшивый RPC делает то
  // же, поэтому бюджет здесь проверяется настоящими портами клиента.
  function rpcAfter<T>(ms: number, value?: T) {
    return vi.fn(
      (_request: unknown, options?: { timeoutMs?: number }) =>
        new Promise<T>((resolve, reject) => {
          const limit = options?.timeoutMs ?? Number.POSITIVE_INFINITY;
          if (limit < ms) {
            setTimeout(
              () =>
                reject(
                  new ConnectError("deadline exceeded", Code.DeadlineExceeded),
                ),
              limit,
            );
          } else {
            setTimeout(() => resolve(value as T), ms);
          }
        }),
    );
  }

  it("shows the unavailable frame once the action budget runs out", async () => {
    const identity = {
      resolveIdentity: rpcAfter(2_500, {
        identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
        globalRoles: [GlobalRole.PUBLIC],
        blocked: false,
      }),
    };
    const getLot = rpcAfter(Number.POSITIVE_INFINITY);
    const auction = {
      getFaqAcknowledgement: rpcAfter(1_500, { acknowledged: true }),
      getLot,
    };
    // Моки отвечают формой сгенерированных сообщений без их классов.
    const ports = createPorts(
      identity as unknown as IdentityRpc,
      auction as unknown as AuctionRpc,
    );
    const { bot, calls } = makeBot(ports);

    const handled = bot.handleUpdate(lotPress());
    await vi.advanceTimersByTimeAsync(actionBudgetMs - 1);
    expect(methods(calls)).not.toContain("editMessageText");
    // Чтение лота получило остаток бюджета, а не свои 3 секунды.
    expect(getLot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: 1_000 }),
    );

    await vi.advanceTimersByTimeAsync(1);
    await handled;
    expect(withoutTyping(calls)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.payload).toMatchObject({
      text: expect.stringContaining("недоступен"),
    });
  });

  it("answers a hanging press by the watchdog and only once", async () => {
    const lot = slowLot();
    const { bot, calls } = makeBot(lot.ports);

    const handled = bot.handleUpdate(lotPress());
    await vi.advanceTimersByTimeAsync(pressWatchdogMs - 1);
    expect(methods(calls)).not.toContain("answerCallbackQuery");
    await vi.advanceTimersByTimeAsync(1);
    expect(withoutTyping(calls)).toEqual(["answerCallbackQuery"]);

    lot.respond();
    await handled;
    expect(withoutTyping(calls)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
  });

  it("delivers the screen when Telegram refuses the press answer", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    const { bot, calls } = makeBot(publicPorts, {
      logger,
      refuse: { answerCallbackQuery: "Bad Request: query is too old" },
    });

    await bot.handleUpdate(lotPress());

    expect(methods(calls)).toEqual(["answerCallbackQuery", "editMessageText"]);
    expect(
      lines.some((line) => line.includes("answerCallbackQuery failed")),
    ).toBe(true);
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      operation: "callback",
      result: "ok",
    });
  });

  // Загрузка байтов — тот вызов, что доставляет карточку: пока она идёт,
  // результата у человека нет, и индикаторы держатся до её конца.
  it("keeps waiting through a slow cold upload of the lot photo", async () => {
    const { bot, calls } = makeBot(portsWith({ lot: withImage }));
    const slowUpload: Transformer = async (prev, method, payload, signal) => {
      if (method === "editMessageText") {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      return prev(method, payload, signal);
    };
    bot.api.config.use(slowUpload);

    const handled = bot.handleUpdate(lotPress());
    await vi.advanceTimersByTimeAsync(pressWatchdogMs - 1);
    expect(methods(calls)).toEqual(["sendChatAction", "sendChatAction"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(withoutTyping(calls)).toEqual(["answerCallbackQuery"]);

    await vi.advanceTimersByTimeAsync(10_000 - pressWatchdogMs);
    await handled;
    expect(withoutTyping(calls)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(methods(calls).filter((m) => m === "sendChatAction")).toHaveLength(
      3,
    );
  });

  it("shows typing while /start waits for the services", async () => {
    const ports: PortsFactory = (requestId, deadlineAt) => {
      const base = publicPorts(requestId, deadlineAt);
      return {
        ...base,
        entry: {
          requestRole: (request) =>
            new Promise((resolve) => {
              setTimeout(() => resolve(base.entry.requestRole(request)), 1_500);
            }),
        },
      };
    };
    const { bot, calls } = makeBot(ports);

    const handled = bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    await vi.advanceTimersByTimeAsync(1_500);
    await handled;
    expect(methods(calls)).toEqual(["sendChatAction", "sendMessage"]);
  });
});

// Нажатие кнопки в сообщении бота: текстовом, rich-карточке или сообщении-фото
// от прежней версии бота.
function lotPress(
  options: { photo?: boolean; rich?: boolean; data?: string } = {},
): Update {
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
        : options.rich
          ? { ...base, rich_message: { blocks: [photoBlock] } }
          : { ...base, text: "old" },
    },
  } as Update;
}
