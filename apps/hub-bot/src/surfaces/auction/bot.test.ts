import { Code, ConnectError } from "@connectrpc/connect";
import { HttpError, InputFile, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../../../gen/identity/v1/roles_pb.js";
import {
  inspectCall,
  reportViolations,
} from "../../../testkit/auction/screen-lint.js";
import {
  type EntryPort,
  encodeAuctionCallback,
  type LotHistoryEntryView,
  type LotImagePort,
  type LotView,
} from "../../auction-ui/index.js";
import { createLogger, type Logger } from "../../core/logging.js";
import { noopTracing } from "../../core/tracing.js";
import type { AuctionListing, AuctionSummary } from "./auctions.js";
import { createBot } from "./bot.js";
import {
  type AuctionRpc,
  createPorts,
  type IdentityRpc,
  type PortsFactory,
} from "./clients.js";
import { traceLotCallback } from "./delivery/message.js";
import { deniedTexts } from "./entry-screen.js";
import { entryCallback, startCallback } from "./faq.js";
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
    photos?: PhotoCache;
    presentation?: "rich" | "plain";
    // Обрыв соединения на первом вызове метода.
    dropOnce?: string;
  } = {},
) {
  const bot = createBot({
    token: "111:test-token",
    environment: "prod",
    tracing: noopTracing(),
    ...(options.presentation === undefined
      ? {}
      : { presentation: options.presentation }),
    ports,
    logger: options.logger ?? silent,
    timeZone: "Europe/Moscow",
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

const activeAuction: AuctionSummary = {
  auctionId,
  stage: "prebidding",
  opensAt: "2026-10-10T16:00:00Z",
  lotCount: 3,
};

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
    history?: readonly LotHistoryEntryView[];
    names?: Readonly<Record<string, string>>;
    // Аукционы по выборкам; по умолчанию аукцион ленты активен.
    auctions?: Partial<Record<AuctionListing, AuctionSummary[]>>;
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
        proxyEnabled: false,
        status: { kind: "unsold" },
        ...overrides.lot,
      }),
      listAuctionLots: async () => ({ lots: [], nextPageToken: "" }),
      listLotHistory: async () => ({
        entries: overrides.history ?? [],
        nextPageToken: "",
      }),
      getDisplayNames: async () => overrides.names ?? {},
      placeBid: async () => ({ kind: "accepted" }),
      setProxyLimit: async () => ({ kind: "accepted" }),
      chooseDisplayName: async () => ({ kind: "accepted", name: "@owl" }),
    },
    operations: {
      newOperationId: () => "01929b7e-5c1d-7a3f-8e4b-00000000c001",
    },
    catalog: {
      listAuctions: async ({ listing }) => ({
        auctions:
          overrides.auctions?.[listing] ??
          (listing === "active" ? [activeAuction] : []),
        nextPageToken: "",
      }),
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

function faqUpdate(): Update {
  return startUpdate({
    message_id: 1,
    date: 0,
    chat: privateChat,
    from,
    text: "/faq",
    entities: [{ type: "bot_command", offset: 0, length: 4 }],
  });
}

type SentButton = { text: string; callback_data?: string };

// Запись трансформера — объект параметров вызова Bot API; его тип зависит от
// метода, и тест читает из него только клавиатуру.
function keyboardOf(payload: unknown): SentButton[][] {
  return (
    (payload as { reply_markup?: { inline_keyboard?: SentButton[][] } })
      .reply_markup?.inline_keyboard ?? []
  );
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
    const press = (action: "read" | "faq"): Update => ({
      update_id: 2,
      callback_query: {
        id: "entry-cb",
        from,
        chat_instance: "ci",
        data: entryCallback(action),
        message: { message_id: 7, date: 0, chat: privateChat, text: "old" },
      },
    });
    // Отметку ставит возврат «‹ Меню» под самим FAQ.
    await first.bot.handleUpdate(press("read"));
    expect(acknowledged).toBe(true);
    const restarted = makeBot(ports);
    await restarted.bot.handleUpdate(start);
    expect(restarted.calls[0]?.payload).toMatchObject({
      text: expect.stringContaining("<b>Меню</b>"),
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
      text: expect.stringMatching(/^<b>Меню<\/b>/),
      parse_mode: "HTML",
    });
    expect(calls[0]?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Аукционы", callback_data: expect.any(String) },
            { text: "Прошедшие", callback_data: expect.any(String) },
          ],
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
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: (text.split(" ")[0] ?? text).length,
            },
          ],
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
      // `/menu` из кнопки меню клиента — тот же вход (PER-472).
      "/menu",
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
    // `/menu` — вход без кода канала, даже с хвостом.
    ["/menu", {}],
    ["/menu s_tg_ads", {}],
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
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: (text.split(" ")[0] ?? text).length,
            },
          ],
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
        operations: base.operations,
        catalog: base.catalog,
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
          [{ text: "Ставки", callback_data: expect.any(String) }],
          // Возврат тела и «Меню» — один последний ряд; у лота с итогом
          // «Обновить» нет.
          [
            { text: "‹ Лоты", callback_data: expect.any(String) },
            { text: "Меню", callback_data: entryCallback("menu") },
          ],
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

  // Один активный аукцион — всё равно список из одной строки, а не сразу
  // лента (PER-453); строка открывает ленту, лента возвращает в список.
  it("lists a single active auction and opens its feed from the row", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    const feedButton = encodeAuctionCallback({
      kind: "feed",
      auctionId,
      page: 0,
    });
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("<b>Аукционы</b>"),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "10 октября, сб · идут ставки · 3 лота",
              callback_data: feedButton,
            },
          ],
          [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
        ],
      },
    });
    await bot.handleUpdate(lotPress({ data: feedButton }));
    expect(calls.at(-1)?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: expect.arrayContaining([
          [
            { text: "‹ Аукционы", callback_data: entryCallback("auctions") },
            { text: "Меню", callback_data: entryCallback("menu") },
          ],
        ]),
      },
    });
  });

  // Завершённый аукцион уходит из активных в прошедшие, и его лента
  // возвращает туда, где он стоит сейчас.
  it("moves a finished auction to the past list and returns its feed there", async () => {
    const finished = { ...activeAuction, stage: "finished" as const };
    const { bot, calls } = makeBot(
      portsWith({ auctions: { active: [], finished: [finished] } }),
    );
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Активных аукционов сейчас нет."),
      reply_markup: {
        inline_keyboard: [
          [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
        ],
      },
    });
    await bot.handleUpdate(lotPress({ data: entryCallback("past") }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("<b>Прошедшие аукционы</b>"),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "10 октября, сб · завершён · 3 лота",
              callback_data: encodeAuctionCallback({
                kind: "feed",
                auctionId,
                page: 0,
              }),
            },
          ],
          [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
        ],
      },
    });
    await bot.handleUpdate(
      lotPress({
        data: encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
      }),
    );
    expect(calls.at(-1)?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: expect.arrayContaining([
          [
            { text: "‹ Прошедшие", callback_data: entryCallback("past") },
            { text: "Меню", callback_data: entryCallback("menu") },
          ],
        ]),
      },
    });
  });

  it("says in text that there are no past auctions", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: entryCallback("past") }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Прошедших аукционов пока нет."),
      reply_markup: {
        inline_keyboard: [
          [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
        ],
      },
    });
  });

  it("answers unavailable when the auction list cannot be read", async () => {
    const ports: PortsFactory = (requestId) => ({
      ...publicPorts(requestId),
      catalog: {
        listAuctions: () =>
          Promise.reject(new ConnectError("down", Code.Unavailable)),
      },
    });
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: "<b>Аукцион сейчас недоступен.</b> Попробуй ещё раз через минуту.",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Повторить", callback_data: entryCallback("auctions") },
            { text: "Меню", callback_data: entryCallback("menu") },
          ],
        ],
      },
    });
  });

  // Критерий PER-463: повтор открывает экран, с которого пришёл отказ.
  it("reopens the lot by the retry button once Auction answers again", async () => {
    const base = publicPorts("r");
    const getLot = vi
      .fn(base.auction.getLot)
      .mockRejectedValueOnce(new ConnectError("down", Code.Unavailable));
    const { bot, calls } = makeBot(() => ({
      ...base,
      auction: { ...base.auction, getLot },
    }));
    await bot.handleUpdate(lotPress());
    const retry = keyboardOf(calls.at(-1)?.payload)[0]?.[0];
    expect(retry).toEqual({
      text: "Повторить",
      callback_data: encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
    });
    // Данные повтора — та же кнопка лота, что нажимает `lotPress`.
    await bot.handleUpdate(lotPress());
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { rich_message: { html: expect.stringContaining("Кружка") } },
    });
  });

  // Под следом кадр отказа приходит новым сообщением, а повтор несёт кнопку
  // лота без префикса следа: он правит сам кадр и сообщений не плодит.
  it("retries a trace press by editing the refusal frame", async () => {
    const base = publicPorts("r");
    const getLot = vi
      .fn(base.auction.getLot)
      .mockRejectedValueOnce(new ConnectError("down", Code.Unavailable));
    const { bot, calls } = makeBot(() => ({
      ...base,
      auction: { ...base.auction, getLot },
    }));
    await bot.handleUpdate(lotPress({ data: traceLotCallback(lotId) }));
    expect(calls.at(-1)?.method).toBe("sendMessage");
    const retry = keyboardOf(calls.at(-1)?.payload)[0]?.[0];
    expect(retry?.callback_data).toBe(
      encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
    );
    await bot.handleUpdate(lotPress());
    expect(calls.at(-1)?.method).toBe("editMessageText");
  });

  // `/start` при недоступном Identity: заявка не подана, и «Повторить»
  // повторяет вход с тем же кодом канала, а не открывает меню без заявки.
  it("retries the entry with the channel code after a failed /start", async () => {
    const requestRole = vi
      .fn<EntryPort["requestRole"]>(async () => ({
        identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
        globalRoles: [],
        outcome: "pending",
      }))
      .mockRejectedValueOnce(new ConnectError("down", Code.Unavailable));
    const { bot, calls } = makeBot(portsWith({ entry: requestRole }));
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: "/start s_tg_ads",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        reply_markup: {
          inline_keyboard: [
            // «Меню» здесь нет: оно разрешило бы личность без заявки.
            [{ text: "Повторить", callback_data: startCallback("tg_ads") }],
          ],
        },
      },
    });
    await bot.handleUpdate(lotPress({ data: startCallback("tg_ads") }));
    expect(requestRole).toHaveBeenLastCalledWith({
      user: { telegramUserId: 42 },
      requestedRole: "public",
      sourceCode: "tg_ads",
      firstName: "Person",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: { text: deniedTexts["not-admitted"] },
    });
  });

  it("answers an unreadable button with a frame that leads to the menu", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: "v9:auc:lot:x" }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Этот экран устарел\.<\/b>/),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Меню", callback_data: entryCallback("menu") }],
        ],
      },
    });
  });

  // `/faq` открывает FAQ новым сообщением с любого места и заявок не ставит.
  it("answers /faq with the FAQ screen without requesting a role", async () => {
    const requestRole = vi.fn<EntryPort["requestRole"]>();
    const { bot, calls } = makeBot(portsWith({ entry: requestRole }));
    await bot.handleUpdate(faqUpdate());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringMatching(/^<b>Правила и FAQ<\/b>/),
        parse_mode: "HTML",
      },
    });
    expect(keyboardOf(calls[0]?.payload).at(-1)).toEqual([
      { text: "‹ Меню", callback_data: entryCallback("read") },
    ]);
    expect(requestRole).not.toHaveBeenCalled();
  });

  // Та же проверка доступа, что у `/start`: недопущенный получает свой кадр.
  it.each([
    [{ globalRoles: [], blocked: false }, "not-admitted"],
    [{ globalRoles: ["public"], blocked: true }, "blocked"],
  ] as const)(
    "refuses /faq to %j with the %s frame",
    async (person, reason) => {
      const base = publicPorts("r");
      const { bot, calls } = makeBot(() => ({
        ...base,
        identity: {
          resolveIdentity: async () => ({
            identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
            globalRoles: [...person.globalRoles],
            blocked: person.blocked,
          }),
        },
      }));
      await bot.handleUpdate(faqUpdate());
      expect(calls.map((call) => call.payload)).toMatchObject([
        { text: deniedTexts[reason] },
      ]);
    },
  );

  // Название лота — недоверенный текст: в ленте оно в подписи кнопки, в
  // хронологии — в HTML-тексте, и разметкой не становится.
  it("escapes a lot title with markup characters in the history", async () => {
    const { bot, calls } = makeBot(
      portsWith({
        lot: { card: { title: "Кружка <XL> & блюдце", description: "" } },
      }),
    );
    await bot.handleUpdate(
      lotPress({
        data: encodeAuctionCallback({
          kind: "history",
          lotId,
          page: 0,
          historyPage: 0,
        }),
      }),
    );
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Кружка &lt;XL&gt; &amp; блюдце"),
      parse_mode: "HTML",
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
    const logger = createLogger("info", {
      service: "auction-bot",
      out: (line) => lines.push(line),
    });
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
      {
        photos,
        dropOnce: "editMessageText",
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
    expect(photos.get({ lotId, version: "img-1" })).toBeUndefined();
    await bot.handleUpdate(lotPress());
    expect(getLotImage).toHaveBeenCalledTimes(2);
  });

  // Изображение может не загрузиться — сбой GetLotImage: карточка остаётся
  // без фото, а не превращается в «недоступно».
  it("shows the card without a photo when the image cannot be loaded", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      service: "auction-bot",
      out: (line) => lines.push(line),
    });
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
      {
        refuse: { editMessageText: "Bad Request: message can't be edited" },
      },
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

  it("shows the bids of a lot in journal order with the menu in the last row", async () => {
    const bidder = "01926f3c-8b7a-7cde-8f00-00000000000b";
    const leader = "01926f3c-8b7a-7cde-8f00-00000000000c";
    const bid = (
      sequence: number,
      participantId: string,
      rubles: number,
      origin: LotHistoryEntryView["origin"],
    ): LotHistoryEntryView => ({
      kind: "bid",
      sequence,
      occurredAt: "2026-10-03T16:04:00Z",
      bidId: `01926f3c-8b7a-7cde-8f00-0000000001${String(sequence).padStart(2, "0")}`,
      participantId,
      amount: { minorUnits: rubles * 100, currency: "RUB" },
      origin,
    });
    const ports = portsWith({
      lot: {
        status: {
          kind: "trading",
          currentPrice: { minorUnits: 160_000, currency: "RUB" },
          leaderId: leader,
          phase: "live",
        },
      },
      history: [
        bid(4, bidder, 1500, { kind: "manual", source: "bot" }),
        bid(6, leader, 1600, { kind: "proxy" }),
        bid(7, bidder, 1700, { kind: "manual", source: "floor" }),
      ],
      names: { [bidder]: "@jay" },
    });
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(
      lotPress({
        data: encodeAuctionCallback({
          kind: "history",
          lotId,
          page: 0,
          historyPage: 999,
        }),
      }),
    );
    const edit = calls.find((call) => call.method === "editMessageText");
    if (edit === undefined) throw new Error("the history was not shown");
    const payload = edit.payload as { text?: unknown; parse_mode?: unknown };
    expect(payload.parse_mode).toBe("HTML");
    const text = String(payload.text);
    expect(text.startsWith("<b>Ставки</b>")).toBe(true);
    expect(text).toContain("Кружка");
    // Время — в поясе сообщества из конфигурации теста, Москве; имени лидера
    // Auction не отдал — строка без имени.
    const lines = text.split("\n").filter((line) => line.includes("₽"));
    expect(lines).toEqual([
      expect.stringMatching(
        /^• 3 октября, сб, 19:04 · @jay · 1\s500\s₽ · вручную$/,
      ),
      expect.stringMatching(/^• 3 октября, сб, 19:04 · 1\s600\s₽ · авто$/),
      expect.stringMatching(
        /^• 3 октября, сб, 19:04 · @jay · 1\s700\s₽ · в зале$/,
      ),
    ]);
    expect(edit.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            { text: "‹ Лот", callback_data: expect.any(String) },
            { text: "Меню", callback_data: entryCallback("menu") },
          ],
        ],
      },
    });
  });

  it("logs the frame of the update without Telegram identifiers", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      service: "auction-bot",
      out: (line) => lines.push(line),
    });
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
        globalRoles: [GlobalRole.GUEST],
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
    const logger = createLogger("info", {
      service: "auction-bot",
      out: (line) => lines.push(line),
    });
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

// Лист ставки (PER-317): вопрос новым сообщением с режимом ответа, ответ
// reply-сообщением и «Отмена» по правилам дизайн-кода, «Вопросы».
describe("bid leaf delivery", () => {
  const trading = portsWith({
    lot: {
      nextPrice: { minorUnits: 125_000, currency: "RUB" },
      proxyEnabled: true,
      status: {
        kind: "trading",
        currentPrice: { minorUnits: 120_000, currency: "RUB" },
        phase: "online",
      },
    },
  });
  const step = encodeAuctionCallback({
    kind: "question",
    question: "bid",
    lotId,
    page: 0,
    addressee: from.id,
  });
  const questionMessage = {
    message_id: 9,
    date: 0,
    chat: privateChat,
    from: { id: botInfo.id, is_bot: true, first_name: "stub" },
    text: "Своя сумма",
    reply_markup: {
      inline_keyboard: [[{ text: "Отмена", callback_data: step }]],
    },
  };
  const answer = (extra: Record<string, unknown>): Update =>
    ({
      update_id: 5,
      message: {
        message_id: 10,
        date: 0,
        chat: privateChat,
        from,
        reply_to_message: questionMessage,
        ...extra,
      },
    }) as Update;

  it("asks the amount in a new message and takes the keyboard off the card", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({
          kind: "ask",
          question: "bid",
          lotId,
          page: 0,
        }),
        message: { message_id: 7, date: 0, chat: privateChat, text: "card" },
      },
    } as Update);
    expect(calls.map((call) => call.method)).toContain(
      "editMessageReplyMarkup",
    );
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload).toMatchObject({
      text: expect.stringContaining("<b>Своя сумма</b>"),
      reply_markup: {
        force_reply: true,
        inline_keyboard: [[{ text: "Отмена", callback_data: step }]],
      },
    });
  });

  // «Своя сумма» упала на сбое, и карточка стала кадром отказа. Повтор
  // задаёт вопрос, а кадр удаляется: без кнопок он остался бы в чате мёртвым.
  it("deletes the refusal frame when the retried action asks a question", async () => {
    const { bot, calls } = makeBot(trading);
    const data = encodeAuctionCallback({
      kind: "ask",
      question: "bid",
      lotId,
      page: 0,
    });
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data,
        message: {
          message_id: 7,
          date: 0,
          chat: privateChat,
          text: "Аукцион сейчас недоступен.",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Повторить", callback_data: data },
                { text: "Меню", callback_data: entryCallback("menu") },
              ],
            ],
          },
        },
      },
    } as Update);
    expect(calls.map((call) => call.method)).not.toContain(
      "editMessageReplyMarkup",
    );
    expect(calls.find((call) => call.method === "deleteMessage")).toMatchObject(
      {
        payload: { chat_id: 42, message_id: 7 },
      },
    );
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: { text: expect.stringContaining("<b>Своя сумма</b>") },
    });
  });

  it("confirms the typed amount and closes the question", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate(answer({ text: "1 300" }));
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Поставить 1\s300\s₽\?<\/b>/),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: expect.stringMatching(/^Да, поставить 1\s300\s₽$/),
              style: "danger",
              callback_data: expect.stringMatching(/^v1:auc:b:/),
            },
          ],
          [{ text: "Нет", callback_data: expect.any(String) }],
        ],
      },
    });
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageReplyMarkup",
      payload: { chat_id: 42, message_id: 9 },
    });
  });

  // PER-473: сумма ниже порога отвергается на сам ответ, без экрана «Да».
  it("refuses an amount below the threshold without a confirmation", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate(answer({ text: "10" }));
    const sent = JSON.stringify(calls.map((call) => call.payload));
    expect(sent).not.toContain("Да, поставить");
    // Отказ — свой экран исхода (PER-472), а не строка над карточкой.
    expect(sent).toMatch(/<b>Ставка ниже порога<\/b>/);
    expect(sent).toMatch(/Сейчас можно от 1\s250\s₽\./);
  });

  // PER-473: после «Да» — экран «принята» с «К лоту» и «Меню» одним рядом.
  it("answers an accepted bid with its own screen and the lot button", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({
          kind: "commit",
          command: "bid",
          lotId,
          opId: "0198f2a4-7c1e-7d3a-9b21-00000000c001",
          amount: 130_000,
          page: 0,
        }),
        message: { message_id: 7, date: 0, chat: privateChat, text: "Ставка" },
      },
    } as Update);
    const shown = calls.find((call) => call.method === "editMessageText");
    expect(shown?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Ставка 1\s300\s₽ принята<\/b>/),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "К лоту",
              callback_data: encodeAuctionCallback({
                kind: "lot",
                lotId,
                page: 0,
              }),
            },
            { text: "Меню", callback_data: entryCallback("menu") },
          ],
        ],
      },
    });
  });

  // Непринятый ответ — свой экран новым сообщением (PER-472): причина в
  // заголовке, «Ввести заново» задаёт вопрос снова, «Отмена» снята с вопроса.
  it.each([
    [{ text: "много" }, "Это не сумма"],
    [{ text: "$20" }, "Ставки принимаются только в рублях"],
    [{ sticker: { file_id: "s" } }, "Нужен ответ текстом"],
  ])(
    "answers a refused %j with its own screen and a retry",
    async (extra, reason) => {
      const { bot, calls } = makeBot(trading);
      await bot.handleUpdate(answer(extra));
      const sent = calls.find((call) => call.method === "sendMessage");
      const text = (sent?.payload as { text?: string } | undefined)?.text ?? "";
      expect(text.startsWith(`<b>${reason}</b>`)).toBe(true);
      expect(sent?.payload).toMatchObject({
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Ввести заново",
                callback_data: encodeAuctionCallback({
                  kind: "ask",
                  question: "bid",
                  lotId,
                  page: 0,
                }),
              },
            ],
            [
              {
                text: "К лоту",
                callback_data: encodeAuctionCallback({
                  kind: "lot",
                  lotId,
                  page: 0,
                }),
              },
              { text: "Меню", callback_data: entryCallback("menu") },
            ],
          ],
        },
      });
      expect(calls.at(-1)).toMatchObject({ method: "editMessageReplyMarkup" });
    },
  );

  it("deletes the question on cancel and sends the card as a new message", async () => {
    const { bot, calls } = makeBot(trading, { presentation: "plain" });
    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: step,
        message: questionMessage,
      },
    } as Update);
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("deleteMessage")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("deleteMessage")).toBeLessThan(
      methods.indexOf("sendMessage"),
    );
    expect(methods).not.toContain("editMessageText");
  });

  it("ignores a message that answers no question", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 11,
        date: 0,
        chat: privateChat,
        from,
        text: "1300",
      },
    } as Update);
    expect(calls).toEqual([]);
  });
});
