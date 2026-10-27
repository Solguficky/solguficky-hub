import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { HttpError, InputFile, type Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RaffleSchema,
  RaffleStatus,
} from "../../../gen/auction/v1/auction_service_pb.js";
import { AccessRight } from "../../../gen/identity/v1/access_pb.js";
import { inspectCall, reportViolations } from "../../../testkit/screen-lint.js";
import {
  type BidOriginView,
  type EntryPort,
  encodeAuctionCallback,
  type FavoritesPort,
  type LotHistoryEntryView,
  type LotImagePort,
  type LotView,
  type ProxyExplainerPort,
  type RaffleView,
} from "../../auction-ui/index.js";
import { raffleOf } from "../../core/auction/raffle.js";
import type {
  AuctionWatches,
  AuctionWatchState,
} from "../../core/auction/watch.js";
import type { EditLimiter } from "../../core/bot/edit-limiter.js";
import { createLogger, type Logger } from "../../core/logging.js";
import { createMediaChat, type MediaChat } from "../../core/media-chat.js";
import type {
  AuctionNotificationChange,
  AuctionNotificationSettings,
  AuctionNotificationsPort,
  OutbidFrequency,
} from "../../core/notifications/outbid.js";
import { noopTracing } from "../../core/tracing.js";
import type { AuctionListing, AuctionSummary } from "./auctions.js";
import { createBot } from "./bot.js";
import {
  type AuctionRpc,
  createPorts,
  type IdentityRpc,
  type PortsFactory,
} from "./clients.js";
import {
  traceLotCallback,
  traceNotifyCallback,
  traceRaffleCallback,
} from "./delivery/message.js";
import { deniedTexts } from "./entry-screen.js";
import { entryCallback, notifyCallback, startCallback } from "./faq.js";
import { commandsFor } from "./menu-commands.js";
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

// Допуск решают права смотрящего; строки ниже дают ему свои.
const VIEWER_ID = "01926f3c-8b7a-7cde-8f00-00000000000a";
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
    // Имя бота поддержки без «@»: кадр ожидания допуска несёт ссылку (PER-625).
    supportBotUsername?: string;
    // Обрыв соединения на первом вызове метода.
    dropOnce?: string;
    // Карточки финала (PER-336): поток и темп правок.
    live?: Parameters<typeof createBot>[0]["live"];
    // Отказ с кодом, а не 400: `429` и `403` у правки вне update.
    refuseWith?: Record<string, { code: number; description: string }>;
    // Чат медиа ботов (PER-774): промо-видео аукциона.
    media?: MediaChat;
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
    ...(options.supportBotUsername === undefined
      ? {}
      : { supportBotUsername: options.supportBotUsername }),
    ...(options.live === undefined ? {} : { live: options.live }),
    ...(options.media === undefined ? {} : { media: options.media }),
    botInfo,
  });
  const calls: Array<{ method: string; payload: unknown }> = [];
  // Результат зависит от метода, фикстура его не знает: единственное
  // ослабление типа в тесте. Отказ Bot API задаётся описанием по методу.
  const recorder: Transformer = (_prev, method, payload) => {
    calls.push({ method, payload });
    // Каждый экран сверяется с каталогом и дизайн-кодом в момент отправки;
    // найденное снимает хук набора (`testkit/lint-setup.ts`).
    reportViolations(inspectCall("auction", method, payload));
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
    const coded = options.refuseWith?.[method];
    if (coded !== undefined) {
      return Promise.resolve({
        ok: false,
        error_code: coded.code,
        description: coded.description,
        parameters: { retry_after: 2 },
      });
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
            // Блок на каждое фото, в порядке `media` (PER-721).
            blocks: (rich.media ?? []).map((_, index) =>
              index === 0 ? photoBlock : photoBlockAt(index),
            ),
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

// Блок фото карусели не первым: `file_id` у него свой.
const photoBlockAt = (index: number) => ({
  type: "photo",
  photo: [
    { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
    {
      file_id: `large-${index + 1}`,
      file_unique_id: "l",
      width: 800,
      height: 800,
    },
  ],
});

function portsWith(
  overrides: {
    lot?: Partial<LotView>;
    image?: LotImagePort["getLotImage"];
    photo?: LotImagePort["getLotPhoto"];
    entry?: EntryPort["requestAccess"];
    // Права смотрящего; по умолчанию — право аукциона.
    rights?: readonly ("place-bids" | "access-hub")[];
    history?: readonly LotHistoryEntryView[];
    names?: Readonly<Record<string, string>>;
    // Аукционы по выборкам; по умолчанию аукцион ленты активен.
    auctions?: Partial<Record<AuctionListing, AuctionSummary[]>>;
    // Избранное Notifications; нет — у процесса нет его адреса.
    favorites?: FavoritesPort;
    // Отметка пояснения автоставки (PER-517); нет — у процесса нет адреса
    // Notifications.
    proxyExplainer?: ProxyExplainerPort;
  } = {},
): PortsFactory {
  const shownLot = (): LotView => ({
    lotId,
    auctionId,
    version: 1,
    card: { title: "Кружка", description: "" },
    proxyEnabled: false,
    status: { kind: "unsold" },
    ...overrides.lot,
  });
  return () => ({
    ...(overrides.favorites === undefined
      ? {}
      : { favorites: overrides.favorites }),
    ...(overrides.proxyExplainer === undefined
      ? {}
      : { proxyExplainer: overrides.proxyExplainer }),
    identity: {
      resolveIdentity: async () => ({
        viewer: {
          identityId: VIEWER_ID,
          rights: overrides.rights ?? ["place-bids"],
        },
        blocked: false,
      }),
    },
    entry: {
      requestAccess:
        overrides.entry ??
        (async () => ({
          viewer: { identityId: VIEWER_ID, rights: ["place-bids"] },
          outcome: "already-held",
        })),
    },
    auction: {
      getLot: async () => shownLot(),
      findLot: async () => shownLot(),
      listAuctionLots: async () => ({ lots: [], nextPageToken: "" }),
      listLotHistory: async () => ({
        entries: overrides.history ?? [],
        nextPageToken: "",
      }),
      getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
      getDisplayNames: async () => overrides.names ?? {},
      placeBid: async () => ({ kind: "accepted", lotVersion: 0 }),
      setProxyLimit: async () => ({ kind: "accepted", lotVersion: 0 }),
      chooseDisplayName: async () => ({ kind: "accepted", name: "@owl" }),
      // Корень аукциона (PER-644) читает его из тех же списков, что
      // «Аукционы» и «Прошедшие».
      getAuction: async ({ auctionId: id }) => {
        const found = [
          ...(overrides.auctions?.active ?? [activeAuction]),
          ...(overrides.auctions?.finished ?? []),
        ].find((auction) => auction.auctionId === id);
        return found === undefined
          ? undefined
          : { auctionId: found.auctionId, stage: found.stage, final: false };
      },
      getRaffle: async () => undefined,
      registerForRaffle: async () => {
        throw new Error("not used");
      },
      cancelRaffleRegistration: async () => {
        throw new Error("not used");
      },
      listMyInvoices: async () => ({ invoices: [] }),
      chooseFulfillment: async () => {
        throw new Error("not used");
      },
      getMyPredictions: async () => [],
      getPredictionResults: async () => ({ kind: "after-final" as const }),
      getDayChronicle: async () => {
        throw new Error("not used");
      },
      submitPrediction: async () => {
        throw new Error("not used");
      },
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
      getLotPhoto:
        overrides.photo ??
        (async ({ photoId }) => ({
          content: new Uint8Array([4, 5, 6]),
          mediaType: "image/jpeg",
          version: `photo-${photoId}`,
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
  return commandUpdate("/faq");
}

function commandUpdate(text: string): Update {
  return startUpdate({
    message_id: 1,
    date: 0,
    chat: privateChat,
    from,
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.length }],
  });
}

type SentButton = { text: string; callback_data?: string; url?: string };

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
      text: expect.stringContaining("Как делать ставки"),
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
    // Отметку ставит кнопка «Аукционы» под самим FAQ.
    await first.bot.handleUpdate(press("read"));
    expect(acknowledged).toBe(true);
    const restarted = makeBot(ports);
    await restarted.bot.handleUpdate(start);
    expect(restarted.calls[0]?.payload).toMatchObject({
      text: expect.stringContaining("<b>Меню</b>"),
    });
    await restarted.bot.handleUpdate(press("faq"));
    expect(restarted.calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Как делать ставки"),
    });
  });

  // `/start` ознакомившегося открывает корневое меню — корень без ряда
  // навигации (PER-592).
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
    expect(JSON.stringify(calls[0]?.payload)).not.toContain("‹ ");
  });

  // Ссылка на лот `l_<токен>` (PER-492) открывает карточку лота: цель названа
  // самой ссылкой, поэтому отметка FAQ её не перекрывает — та закрывает вход в
  // дерево без цели.
  it("opens the lot of a lot link without the FAQ gate", async () => {
    const token = Buffer.from(lotId.replaceAll("-", ""), "hex").toString(
      "base64url",
    );
    const ports: PortsFactory = (requestId, deadlineAt) => ({
      ...publicPorts(requestId, deadlineAt),
      faq: {
        ...publicPorts(requestId, deadlineAt).faq,
        acknowledged: async () => false,
      },
    });
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: `/start l_${token}`,
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(JSON.stringify(calls.at(-1)?.payload)).toContain("Кружка");
    expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain(
      "Как делать ставки",
    );
  });

  // Отказ Auction на приходе по ссылке — тот же кадр недоступности с
  // «Повторить», что у нажатия, а не тишина: ветка ссылки стоит внутри try.
  it("answers the unavailable frame when Auction is down on a lot link", async () => {
    const token = Buffer.from(lotId.replaceAll("-", ""), "hex").toString(
      "base64url",
    );
    const ports: PortsFactory = (requestId, deadlineAt) => ({
      ...publicPorts(requestId, deadlineAt),
      auction: {
        ...publicPorts(requestId, deadlineAt).auction,
        getLot: () =>
          Promise.reject(new ConnectError("down", Code.Unavailable)),
      },
    });
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: `/start l_${token}`,
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Аукцион сейчас недоступен"),
    });
  });

  // Токен лота — недоверенный хвост: обрезанный или подделанный, он не
  // открывает ничего, и приход читается как `/start` без цели.
  it("answers a broken lot link like a plain /start", async () => {
    const broken = Buffer.from(lotId.replaceAll("-", ""), "hex")
      .toString("base64url")
      .slice(0, 21);
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(
      startUpdate({
        message_id: 1,
        date: 0,
        chat: privateChat,
        from,
        text: `/start l_${broken}`,
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      }),
    );
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Меню<\/b>/),
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
      // `/menu` открывает корневое меню, как `/start` ознакомившегося
      // (PER-592).
      "/menu",
    ]) {
      expect(await answer(text)).toEqual(plain);
    }
  });

  // Код канала — недоверенный хвост `s_<код>`: `/start` заявку не ставит, а
  // кладёт его в кнопку «Подать заявку», и до Identity он едет нажатием, как
  // пришёл; payload без префикса кода не несёт (ADR-060, пункты 17–18;
  // дополнение от 2026-10-12).
  it.each([
    ["/start s_tg_ads", { sourceCode: "tg_ads" }, "v1:entry:apply:tg_ads"],
    ["/start s_", { sourceCode: "" }, "v1:entry:apply:"],
    ["/start m_AZLzpLXGfY6fChssPU5fYA", {}, "v1:entry:apply"],
    ["/start", {}, "v1:entry:apply"],
  ])(
    "welcomes on %s and applies with the auction queue and the first name",
    async (text, code, data) => {
      const requestAccess = vi.fn<EntryPort["requestAccess"]>(async () => ({
        viewer: { identityId: VIEWER_ID, rights: [] },
        outcome: "pending",
      }));
      const { bot, calls } = makeBot(
        portsWith({ entry: requestAccess, rights: [] }),
      );
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
      expect(requestAccess).not.toHaveBeenCalled();
      expect(keyboardOf(calls[0]?.payload)).toEqual([
        [{ text: "Подать заявку", callback_data: data }],
      ]);
      await bot.handleUpdate(lotPress({ data }));
      expect(requestAccess).toHaveBeenCalledExactlyOnceWith({
        user: { telegramUserId: 42 },
        queue: "auction",
        firstName: "Person",
        ...code,
      });
      expect(calls.at(-1)).toMatchObject({
        method: "editMessageText",
        payload: { text: deniedTexts["not-admitted"] },
      });
    },
  );

  // Кадр ожидания допуска несёт вход в бот поддержки с меткой аукциона
  // (PER-625, ADR-068): «?start=auction» говорит боту поддержки, откуда человек.
  it("puts the support bot on the waiting frame when its address is set", async () => {
    const requestAccess = vi.fn<EntryPort["requestAccess"]>(async () => ({
      viewer: { identityId: VIEWER_ID, rights: [] },
      outcome: "pending",
    }));
    const { bot, calls } = makeBot(
      portsWith({ entry: requestAccess, rights: [] }),
      { supportBotUsername: "solguficky_support_bot" },
    );
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
    await bot.handleUpdate(lotPress({ data: "v1:entry:apply" }));
    const shown = calls.at(-1);
    expect(shown).toMatchObject({
      method: "editMessageText",
      payload: { text: deniedTexts["not-admitted"] },
    });
    expect(keyboardOf(shown?.payload)).toEqual([
      [
        {
          text: "Написать в поддержку ↗",
          url: "https://t.me/solguficky_support_bot?start=auction",
        },
      ],
    ]);
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
          // Возврат тела — последний ряд одной кнопкой; у лота с итогом
          // «Обновить» нет.
          [{ text: "‹ Лоты", callback_data: expect.any(String) }],
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
  // лента (PER-453); строка открывает корень аукциона, как в хабе (PER-644),
  // корень возвращает в список.
  it("lists a single active auction and opens its root from the row", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    const feedButton = encodeAuctionCallback({ kind: "root", auctionId });
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
          [{ text: "🗂 Прошедшие", callback_data: entryCallback("past") }],
          [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
        ],
      },
    });
    await bot.handleUpdate(lotPress({ data: feedButton }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("<b>Аукцион</b>"),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏷️ Лоты",
              callback_data: encodeAuctionCallback({
                kind: "feed",
                auctionId,
                page: 0,
              }),
            },
          ],
          // Онлайн-неделя: вход в «Хроники дня» (PER-725).
          [
            {
              text: "Хроники дня",
              callback_data: encodeAuctionCallback({
                kind: "day-chronicle",
                auctionId,
              }),
            },
          ],
          [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
        ],
      },
    });
  });

  // Завершённый аукцион уходит из активных в прошедшие, и его корень
  // возвращает туда, где он стоит сейчас.
  it("moves a finished auction to the past list and returns its root there", async () => {
    const finished = { ...activeAuction, stage: "finished" as const };
    const { bot, calls } = makeBot(
      portsWith({ auctions: { active: [], finished: [finished] } }),
    );
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    // Пустой список — не тупик: «Прошедшие» внутри и «‹ Меню» (PER-592).
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Активных аукционов сейчас нет."),
      reply_markup: {
        inline_keyboard: [
          [{ text: "🗂 Прошедшие", callback_data: entryCallback("past") }],
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
              callback_data: encodeAuctionCallback({ kind: "root", auctionId }),
            },
          ],
          [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
        ],
      },
    });
    await bot.handleUpdate(
      lotPress({ data: encodeAuctionCallback({ kind: "root", auctionId }) }),
    );
    expect(calls.at(-1)?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: expect.arrayContaining([
          [{ text: "‹ Прошедшие", callback_data: entryCallback("past") }],
        ]),
      },
    });
    const results = buttonData(lastScreen(calls), "Итоги");
    await bot.handleUpdate(lotPress({ data: results }));
    expect(lastScreen(calls).text).toContain("Итоги после финала.");
  });

  // Отменённый аукцион (PER-606; ADR-047, дополнение 2026-10-12) — прошедший,
  // и статус отличает его от завершённого: в строке списка и в корне.
  it("marks a cancelled auction in the past list and in its root", async () => {
    // Дедлайн впереди: у отменённого отсчёта до финала нет — финала не будет.
    const cancelled = {
      ...activeAuction,
      stage: "cancelled" as const,
      closesAt: "2099-10-12T16:00:00Z",
    };
    const { bot, calls } = makeBot(
      portsWith({ auctions: { active: [], finished: [cancelled] } }),
    );
    await bot.handleUpdate(lotPress({ data: entryCallback("past") }));
    expect(JSON.stringify(calls.at(-1)?.payload)).not.toContain("финал");
    expect(calls.at(-1)?.payload).toMatchObject({
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "10 октября, сб · отменён · 3 лота",
              callback_data: encodeAuctionCallback({ kind: "root", auctionId }),
            },
          ],
          [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
        ],
      },
    });
  });

  // Идущий аукцион — первым (ADR-047, дополнение 2026-10-12: порядок решает
  // поверхность), даже если запланированный начинается раньше по дате.
  it("lists the auction under way first among the active ones", async () => {
    const scheduledId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3477";
    const scheduled: AuctionSummary = {
      auctionId: scheduledId,
      stage: "scheduled",
      opensAt: "2026-10-01T16:00:00Z",
      lotCount: 2,
    };
    const { bot, calls } = makeBot(
      portsWith({
        auctions: { active: [scheduled, activeAuction], finished: [] },
      }),
    );
    await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
    const payload = calls.at(-1)?.payload as
      | { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
      | undefined;
    const rows = payload?.reply_markup.inline_keyboard ?? [];
    expect(rows.slice(0, 2).map(([button]) => button?.callback_data)).toEqual([
      encodeAuctionCallback({ kind: "root", auctionId }),
      encodeAuctionCallback({ kind: "root", auctionId: scheduledId }),
    ]);
  });

  it("says in text that there are no past auctions", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: entryCallback("past") }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Прошедших аукционов пока нет."),
      reply_markup: {
        inline_keyboard: [
          [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
        ],
      },
    });
  });

  // Строка состояния (PER-767): под строкой аукциона в «Аукционах» — день
  // недели, идущее окно и розыгрыш; текст общий с хабом. Экран идёт через
  // линтер харнесса.
  it("shows the status line under the active auction", async () => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-13T16:00:00Z"),
    });
    try {
      const { bot, calls } = makeBot(
        portsWith({
          auctions: {
            active: [
              {
                ...activeAuction,
                week: {
                  stage: "prebidding",
                  opensAt: "2026-10-09T21:00:00Z",
                  closesAt: "2026-10-16T21:00:00Z",
                  stepWindows: [
                    {
                      from: "2026-10-13T15:00:00Z",
                      until: "2026-10-13T19:00:00Z",
                      lotIds: ["lot"],
                    },
                  ],
                  raffleClosesAt: "2026-10-15T18:00:00Z",
                },
              },
            ],
          },
        }),
      );
      await bot.handleUpdate(lotPress({ data: entryCallback("auctions") }));
      const text = String(
        (calls.at(-1)?.payload as { text?: string } | undefined)?.text,
      );
      expect(text).toContain(
        "\nдень 4 из 7 · 🔥 Счастливые часы до 22:00 · розыгрыш: регистрация до 15.10",
      );
    } finally {
      vi.useRealTimers();
    }
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
          [{ text: "Повторить", callback_data: entryCallback("auctions") }],
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
    const requestAccess = vi.fn<EntryPort["requestAccess"]>(async () => ({
      viewer: { identityId: VIEWER_ID, rights: [] },
      outcome: "pending",
    }));
    const resolveIdentity = vi
      .fn(async () => ({
        viewer: { identityId: VIEWER_ID, rights: [] },
        blocked: false,
      }))
      .mockRejectedValueOnce(new ConnectError("down", Code.Unavailable));
    const base = portsWith({ entry: requestAccess });
    const { bot, calls } = makeBot((requestId, deadlineAt) => ({
      ...base(requestId, deadlineAt),
      identity: { resolveIdentity },
    }));
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
            // Возврата здесь нет: человеку, которого бот ещё не пустил,
            // возвращаться некуда.
            [{ text: "Повторить", callback_data: startCallback("tg_ads") }],
          ],
        },
      },
    });
    // Повтор — тот же `/start`: заявки нет, код канала доезжает до кнопки.
    await bot.handleUpdate(lotPress({ data: startCallback("tg_ads") }));
    expect(requestAccess).not.toHaveBeenCalled();
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageText",
      payload: {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Подать заявку", callback_data: "v1:entry:apply:tg_ads" }],
          ],
        },
      },
    });
  });

  it("answers an unreadable button with a frame that leads to the auctions", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: "v9:auc:lot:x" }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Этот экран устарел\.<\/b>/),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "‹ Аукционы", callback_data: entryCallback("auctions") }],
        ],
      },
    });
  });

  // Разделы открываются командами, `/menu` — корневое меню, `/past` вне
  // списка команд по старой привычке открывает прошедшие (PER-592). Заявки
  // команда не ставит, а без отметки ознакомления человек видит FAQ.
  it.each([
    ["/auctions", "<b>Аукционы</b>"],
    ["/menu", "<b>Меню</b>"],
    ["/past", "<b>Прошедшие аукционы</b>"],
  ])(
    "answers %s with its list root without requesting access",
    async (text, title) => {
      const requestAccess = vi.fn<EntryPort["requestAccess"]>();
      const { bot, calls } = makeBot(portsWith({ entry: requestAccess }));
      await bot.handleUpdate(
        startUpdate({
          message_id: 1,
          date: 0,
          chat: privateChat,
          from,
          text,
          entities: [{ type: "bot_command", offset: 0, length: text.length }],
        }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: "sendMessage",
        payload: { text: expect.stringContaining(title) },
      });
      expect(requestAccess).not.toHaveBeenCalled();
    },
  );

  // Отсчёт до финала (PER-518): строка активного аукциона несёт его хвостом,
  // а кнопка — нет. Экран идёт через линтер харнесса.
  it("counts down to the finale in the active auction row", async () => {
    vi.useFakeTimers({
      toFake: ["Date"],
      now: new Date("2026-10-07T12:00:00Z"),
    });
    try {
      const { bot, calls } = makeBot(
        portsWith({
          auctions: {
            active: [{ ...activeAuction, closesAt: "2026-10-09T21:00:00Z" }],
          },
        }),
      );
      await bot.handleUpdate(
        startUpdate({
          message_id: 1,
          date: 0,
          chat: privateChat,
          from,
          text: "/auctions",
          entities: [{ type: "bot_command", offset: 0, length: 9 }],
        }),
      );
      expect(calls[0]?.payload).toMatchObject({
        text: "<b>Аукционы</b>\n\n• Торги с 10 октября, сб — <b>идут ставки</b>, 3 лота, <b>до финала 3 дня</b>",
        reply_markup: {
          inline_keyboard: [
            [
              expect.objectContaining({
                text: "10 октября, сб · идут ставки · 3 лота",
              }),
            ],
            [expect.objectContaining({ text: "🗂 Прошедшие" })],
            [expect.objectContaining({ text: "‹ Меню" })],
          ],
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // `/faq` открывает FAQ новым сообщением с любого места и заявок не ставит.
  it("answers /faq with the FAQ screen without requesting access", async () => {
    const requestAccess = vi.fn<EntryPort["requestAccess"]>();
    const { bot, calls } = makeBot(portsWith({ entry: requestAccess }));
    await bot.handleUpdate(faqUpdate());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringMatching(/^<b>Правила и FAQ<\/b>/),
        parse_mode: "HTML",
      },
    });
    expect(keyboardOf(calls[0]?.payload).slice(-2)).toEqual([
      [{ text: "Аукционы", callback_data: entryCallback("read") }],
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
    expect(requestAccess).not.toHaveBeenCalled();
  });

  // Та же проверка доступа, что у `/start`: без права — приветствие с
  // кнопкой заявки, остальным недопущенным — свой кадр.
  it("welcomes a person without the right on /faq", async () => {
    const { bot, calls } = makeBot(portsWith({ rights: [] }));
    await bot.handleUpdate(faqUpdate());
    expect(keyboardOf(calls[0]?.payload)).toEqual([
      [{ text: "Подать заявку", callback_data: "v1:entry:apply" }],
    ]);
  });

  it.each([
    [{ rights: ["place-bids"], blocked: true }, "blocked"],
    // Участнику сообщества бот аукциона и FAQ не открывает: только переход
    // в бот хаба (ADR-064, пункт 2).
    [{ rights: ["access-hub", "place-bids"], blocked: false }, "in-community"],
  ] as const)(
    "refuses /faq to %j with the %s frame",
    async (person, reason) => {
      const base = publicPorts("r");
      const { bot, calls } = makeBot(() => ({
        ...base,
        identity: {
          resolveIdentity: async () => ({
            viewer: { identityId: VIEWER_ID, rights: [...person.rights] },
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
    // Описание длиннее предела подписи к фото приходит целиком, фото — над
    // заголовком (решение владельца 10 октября 2026 года).
    expect(description.length).toBeGreaterThan(1024);
    expect(card.rich_message.html).toContain(description.trim());
    expect(card.rich_message.html).toMatch(
      /^<img src="tg:\/\/photo\?id=lot"\/><h1>/,
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

  // Несколько фото лота (PER-721): карусель над заголовком, как постеры
  // карточки сходки; каждое фото грузится своим `GetLotPhoto`, а `file_id`
  // кэшируется по каждому, и второй показ идёт без байтов.
  it("shows several photos of a lot as a carousel and reuses the file_id of each", async () => {
    const photos = createPhotoCache();
    const getLotPhoto = vi.fn(async ({ photoId }: { photoId: string }) => ({
      content: new Uint8Array([1]),
      mediaType: "image/jpeg",
      version: `v-${photoId}`,
    }));
    const getLotImage = vi.fn(async () => {
      throw new Error("the cover is read as a photo");
    });
    const { bot, calls } = makeBot(
      portsWith({
        lot: {
          card: {
            title: "Кружка",
            description: "",
            image: { version: "v-p1" },
            photos: [
              { photoId: "p1", version: "v-p1" },
              { photoId: "p2", version: "v-p2" },
              { photoId: "p3", version: "v-p3" },
            ],
          },
        },
        image: getLotImage,
        photo: getLotPhoto,
      }),
      { photos },
    );
    await bot.handleUpdate(lotPress());
    await bot.handleUpdate(lotPress());

    expect(getLotPhoto).toHaveBeenCalledTimes(3);
    expect(getLotImage).not.toHaveBeenCalled();
    const edits = calls.filter((call) => call.method === "editMessageText");
    const first = edits[0]?.payload as {
      rich_message: { html: string; media: { id: string }[] };
    };
    expect(first.rich_message.html).toMatch(
      /^<tg-slideshow><img src="tg:\/\/photo\?id=lot"\/><img src="tg:\/\/photo\?id=lot2"\/><img src="tg:\/\/photo\?id=lot3"\/><\/tg-slideshow><h1>Кружка<\/h1>/,
    );
    expect(first.rich_message.media.map((photo) => photo.id)).toEqual([
      "lot",
      "lot2",
      "lot3",
    ]);
    expect(edits[1]?.payload).toMatchObject({
      rich_message: {
        media: [
          { id: "lot", media: { media: "large" } },
          { id: "lot2", media: { media: "large-2" } },
          { id: "lot3", media: { media: "large-3" } },
        ],
      },
    });
  });

  it("leaves out of the carousel a photo Auction does not give", async () => {
    const getLotPhoto = vi.fn(async ({ photoId }: { photoId: string }) => {
      if (photoId === "p2") throw new Error("gone");
      return {
        content: new Uint8Array([1]),
        mediaType: "image/jpeg",
        version: `v-${photoId}`,
      };
    });
    const { bot, calls } = makeBot(
      portsWith({
        lot: {
          card: {
            title: "Кружка",
            description: "",
            image: { version: "v-p1" },
            photos: [
              { photoId: "p1", version: "v-p1" },
              { photoId: "p2", version: "v-p2" },
            ],
          },
        },
        photo: getLotPhoto,
      }),
    );
    await bot.handleUpdate(lotPress());

    const card = calls.find((call) => call.method === "editMessageText")
      ?.payload as { rich_message: { html: string; media: unknown[] } };
    // Одно оставшееся фото стоит фотографией, а не каруселью из одного кадра.
    expect(card.rich_message.html).toMatch(
      /^<img src="tg:\/\/photo\?id=lot"\/><h1>/,
    );
    expect(card.rich_message.media).toHaveLength(1);
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
      origin: BidOriginView,
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
          [{ text: "‹ Лот", callback_data: expect.any(String) }],
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

  // Переход участника в бот хаба — ответ по сценарию, а не отказ: отказы
  // авторизации и спан update он не помечает.
  it("logs the move of a community member to the hub bot as a handled update", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      service: "auction-bot",
      out: (line) => lines.push(line),
    });
    const base = publicPorts("r");
    const { bot, calls } = makeBot(
      () => ({
        ...base,
        identity: {
          resolveIdentity: async () => ({
            viewer: {
              identityId: VIEWER_ID,
              rights: ["access-hub", "place-bids"],
            },
            blocked: false,
          }),
        },
      }),
      { logger },
    );
    await bot.handleUpdate(lotPress());
    expect(calls.map((call) => call.payload)).toContainEqual(
      expect.objectContaining({ text: deniedTexts["in-community"] }),
    );
    const record = JSON.parse(lines.at(-1) ?? "{}");
    expect(record).toMatchObject({ result: "ok", screen: "denied" });
    expect(record).not.toHaveProperty("error_category");
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
        rights: [AccessRight.PLACE_BIDS],
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
        identity: {
          resolveIdentity: (user) =>
            new Promise((resolve) => {
              setTimeout(
                () => resolve(base.identity.resolveIdentity(user)),
                1_500,
              );
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
            inline_keyboard: [[{ text: "Повторить", callback_data: data }]],
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

  // Пояснение видено (PER-517): вопрос лимита уходит в Telegram с «Как это
  // работает» над «Отменой», и линтер экранов проверяет его на отправке.
  it("asks the limit with how it works once the explainer was seen", async () => {
    const { bot, calls } = makeBot(
      portsWith({
        lot: {
          nextPrice: { minorUnits: 125_000, currency: "RUB" },
          proxyEnabled: true,
          status: {
            kind: "trading",
            currentPrice: { minorUnits: 120_000, currency: "RUB" },
            phase: "online",
          },
        },
        proxyExplainer: {
          seen: async () => true,
          markSeen: async () => {},
        },
      }),
    );
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({
          kind: "ask",
          question: "proxy",
          lotId,
          page: 0,
        }),
        message: { message_id: 7, date: 0, chat: privateChat, text: "card" },
      },
    } as Update);
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload).toMatchObject({
      text: expect.not.stringContaining("Подсказка"),
      reply_markup: {
        force_reply: true,
        inline_keyboard: [[{ text: "Как это работает" }], [{ text: "Отмена" }]],
      },
    });
  });

  // «Как это работает» (PER-517) задаёт вопрос лимита заново: нажатый вопрос
  // удаляется, как по «Отмене», а новый с пояснением приходит следом.
  it("replaces the limit question with an explained one on how it works", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({ kind: "explain", lotId, page: 0 }),
        message: {
          message_id: 9,
          date: 0,
          chat: privateChat,
          text: "Автоставка",
        },
      },
    } as Update);
    expect(calls.map((call) => call.method)).not.toContain(
      "editMessageReplyMarkup",
    );
    expect(calls.find((call) => call.method === "deleteMessage")).toMatchObject(
      { payload: { chat_id: 42, message_id: 9 } },
    );
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: {
        text: expect.stringContaining(
          "💡 Подсказка: платишь цену, а не лимит.",
        ),
        reply_markup: { force_reply: true },
      },
    });
  });

  // Telegram не дал удалить вопрос — он остаётся живым: «Отмена» с шагом с
  // него не снимается, и ответ на него по-прежнему принимается.
  it("keeps an undeletable limit question answerable on how it works", async () => {
    const { bot, calls } = makeBot(trading, {
      refuse: { deleteMessage: "Bad Request: message can't be deleted" },
    });
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb",
        from,
        chat_instance: "ci",
        data: encodeAuctionCallback({ kind: "explain", lotId, page: 0 }),
        message: {
          message_id: 9,
          date: 0,
          chat: privateChat,
          text: "Автоставка",
        },
      },
    } as Update);
    expect(calls.map((call) => call.method)).not.toContain(
      "editMessageReplyMarkup",
    );
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: { reply_markup: { force_reply: true } },
    });
  });

  // Шаг вопроса лежит в «Отмене», а над ней может стоять «Как это работает»:
  // ответ находит шаг по всей клавиатуре.
  it("takes an answer to the limit question under how it works", async () => {
    const { bot, calls } = makeBot(trading);
    const limitStep = encodeAuctionCallback({
      kind: "question",
      question: "proxy",
      lotId,
      page: 0,
      addressee: from.id,
    });
    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 10,
        date: 0,
        chat: privateChat,
        from,
        text: "2 000",
        reply_to_message: {
          ...questionMessage,
          text: "Автоставка",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Как это работает",
                  callback_data: encodeAuctionCallback({
                    kind: "explain",
                    lotId,
                    page: 0,
                  }),
                },
              ],
              [{ text: "Отмена", callback_data: limitStep }],
            ],
          },
        },
      },
    } as Update);
    const sent = calls.find((call) => call.method === "sendMessage");
    expect(sent?.payload).toMatchObject({
      text: expect.stringMatching(
        /^<b>Включить автоставку до 2\s000\s₽\?<\/b>/,
      ),
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
              text: "✔️ Да, поставить",
              style: "danger",
              callback_data: expect.stringMatching(/^v1:auc:b:/),
            },
            { text: "✖️ Нет", callback_data: expect.any(String) },
          ],
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
    expect(sent).not.toContain("✔️ Да, поставить");
    // Отказ — свой экран исхода (PER-472), а не строка над карточкой.
    expect(sent).toMatch(/<b>Ставка ниже порога<\/b>/);
    expect(sent).toMatch(/Сейчас можно от 1\s250\s₽\./);
  });

  // PER-473: после «Да» — экран «принята» с выходом «К лоту».
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
              text: "‹ Лот",
              callback_data: encodeAuctionCallback({
                kind: "lot",
                lotId,
                page: 0,
              }),
            },
          ],
          [{ text: "‹ Лоты" }],
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
                text: "‹ Лот",
                callback_data: encodeAuctionCallback({
                  kind: "lot",
                  lotId,
                  page: 0,
                }),
              },
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

  // Сообщение без реплая бот не пропускает молча (PER-592): ответ, у которого
  // клиент потерял реплай, получает подсказку, а не тишину.
  it("hints at a message that answers no question", async () => {
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
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(calls[0]?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Я отвечаю на кнопки и команды\.<\/b>/),
    });
    expect(keyboardOf(calls[0]?.payload)).toEqual([
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ]);
  });

  it("stays silent on a service message and hints once at an album", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate({
      update_id: 7,
      message: {
        message_id: 12,
        date: 0,
        chat: privateChat,
        from,
        pinned_message: { message_id: 3, date: 0 },
      },
    } as Update);
    expect(calls).toEqual([]);
    for (const message_id of [13, 14]) {
      await bot.handleUpdate({
        update_id: message_id,
        message: {
          message_id,
          date: 0,
          chat: privateChat,
          from,
          media_group_id: "album-1",
          photo: [
            { file_id: "file", file_unique_id: "uniq", width: 1, height: 1 },
          ],
        },
      } as Update);
    }
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  });

  it("stays silent on a command for another bot", async () => {
    const { bot, calls } = makeBot(trading);
    await bot.handleUpdate({
      update_id: 6,
      message: {
        message_id: 11,
        date: 0,
        chat: privateChat,
        from,
        text: "/start@other_bot",
      },
    } as Update);
    expect(calls).toEqual([]);
  });
});

// Настройки уведомлений аукциона (PER-515, PER-539, PER-645): пункт меню,
// кнопки-переключатели с подтверждением, выключатели «перебили» в финале и
// анонса финала, отказ Notifications и «Реже» под уведомлением.
describe("auction notification settings", () => {
  const mode = (frequency: OutbidFrequency) =>
    notifyCallback({ kind: "frequency", frequency });

  // Хранилище Notifications вне бота: оно переживает пересоздание бота, как
  // база сервиса переживает рестарт процесса.
  function withOutbid(
    store: { settings: AuctionNotificationSettings | undefined },
    port: Partial<AuctionNotificationsPort> = {},
  ): PortsFactory & { chosen: AuctionNotificationChange[] } {
    const chosen: AuctionNotificationChange[] = [];
    const ports: PortsFactory = (requestId) => ({
      ...publicPorts(requestId),
      outbid: {
        get: async () => store.settings,
        set: async (_viewer, change) => {
          chosen.push(change);
          const current = store.settings ?? {
            frequency: "every",
            finalAnnouncements: true,
            liveFinalOutbids: false,
            auctionAnnouncements: true,
          };
          store.settings =
            change.kind === "frequency"
              ? { ...current, frequency: change.frequency }
              : change.kind === "final"
                ? { ...current, finalAnnouncements: change.enabled }
                : change.kind === "live"
                  ? { ...current, liveFinalOutbids: change.enabled }
                  : { ...current, auctionAnnouncements: change.enabled };
          return store.settings;
        },
        ...port,
      },
    });
    return Object.assign(ports, { chosen });
  }
  const stored = (
    frequency: OutbidFrequency,
    finalAnnouncements = true,
    liveFinalOutbids = false,
  ): { settings: AuctionNotificationSettings | undefined } => ({
    settings: {
      frequency,
      finalAnnouncements,
      liveFinalOutbids,
      auctionAnnouncements: true,
    },
  });

  // Настройки открывает команда `/notifications` новым сообщением; это
  // подраздел «Настроек» (PER-595): четыре кнопки-переключателя и последним
  // рядом «‹ Настройки».
  it("opens the settings by the command with the way back to the settings", async () => {
    const { bot, calls } = makeBot(withOutbid(stored("every")));
    await bot.handleUpdate(commandUpdate("/notifications"));
    expect(calls.at(-1)?.method).toBe("sendMessage");
    const rows = keyboardOf(calls.at(-1)?.payload);
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("<b>Уведомления</b>"),
    });
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)).toEqual([
      { text: "‹ Настройки", callback_data: entryCallback("settings") },
    ]);
  });

  it("answers the settings command as outdated without Notifications", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(commandUpdate("/notifications"));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Этот экран устарел."),
    });
  });

  // №72 прогона 14.10: каждая настройка — одна кнопка с текущим значением,
  // которая несёт следующее; пояснение говорит о переключении, о сводке, о
  // финале и о том, что покупку настройки не трогают.
  it("shows one switch per setting carrying its next value and explains them", async () => {
    const { bot, calls } = makeBot(withOutbid(stored("15")));
    await bot.handleUpdate(lotPress({ data: notifyCallback() }));
    expect(calls.at(-1)?.method).toBe("editMessageText");
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringMatching(
        /переключает[\s\S]*одной сводкой[\s\S]*Перебили в финале[\s\S]*Анонс финала[\s\S]*О покупке лота пишу всегда[\s\S]*Новый аукцион и торги/,
      ),
      reply_markup: {
        inline_keyboard: [
          [{ text: "Перебили: раз в 15 минут", callback_data: mode("60") }],
          [
            {
              text: "🔕 Выкл · Перебили в финале",
              callback_data: notifyCallback({ kind: "live", enabled: true }),
            },
          ],
          [
            {
              text: "🔔 Вкл · Анонс финала",
              callback_data: notifyCallback({ kind: "final", enabled: false }),
            },
          ],
          [
            {
              text: "🔔 Вкл · Новый аукцион и торги",
              callback_data: notifyCallback({
                kind: "announcements",
                enabled: false,
              }),
            },
          ],
          [{ text: "‹ Настройки", callback_data: entryCallback("settings") }],
        ],
      },
    });
  });

  // Критерий PER-645: кнопка частоты проходит все пять режимов по кругу и
  // показывает текущий. Подтверждение — ответ на нажатие, и уходит он раньше
  // правки экрана: показ ответил бы на нажатие сам, без текста.
  it("cycles the frequency through all five modes and shows the current one", async () => {
    const ports = withOutbid(stored("every"));
    const { bot, calls } = makeBot(ports);
    const seen: string[] = [];
    for (let press = 0; press < 5; press += 1) {
      await bot.handleUpdate(lotPress({ data: notifyCallback() }));
      const data =
        keyboardOf(calls.at(-1)?.payload)[0]?.[0]?.callback_data ?? "";
      calls.length = 0;
      await bot.handleUpdate(lotPress({ data }));
      expect(calls.map((call) => call.method)).toEqual([
        "answerCallbackQuery",
        "editMessageText",
      ]);
      seen.push(keyboardOf(calls[1]?.payload)[0]?.[0]?.text ?? "");
    }
    expect(seen).toEqual([
      "Перебили: раз в 5 минут",
      "Перебили: раз в 15 минут",
      "Перебили: раз в час",
      "Перебили: не присылать",
      "Перебили: о каждом",
    ]);
    expect(ports.chosen).toEqual(
      (["5", "15", "60", "off", "every"] as const).map((frequency) => ({
        kind: "frequency",
        frequency,
      })),
    );
    expect(calls[0]?.payload).toMatchObject({
      text: "Теперь: о каждом событии сразу.",
    });
  });

  // Кнопка несёт целевое значение, а не шаг: повтор нажатия на том же
  // сообщении и старая кнопка режима ставят названный режим.
  it("stores the named frequency from an old mode button", async () => {
    const ports = withOutbid(stored("every"));
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(lotPress({ data: mode("off") }));
    await bot.handleUpdate(lotPress({ data: mode("off") }));
    expect(ports.chosen).toEqual([
      { kind: "frequency", frequency: "off" },
      { kind: "frequency", frequency: "off" },
    ]);
    expect(calls[0]?.payload).toMatchObject({ text: "Теперь: не присылаю." });
  });

  // «Перебили в финале» (PER-645) — целевое состояние: частоту и анонс
  // финала он не трогает.
  it("switches the live final outbids on without touching the others", async () => {
    const ports = withOutbid(stored("15"));
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(
      lotPress({ data: notifyCallback({ kind: "live", enabled: true }) }),
    );
    expect(ports.chosen).toEqual([{ kind: "live", enabled: true }]);
    expect(calls[0]?.payload).toMatchObject({
      text: "Включено: перебили в финале.",
    });
    const shown = JSON.stringify(calls[1]?.payload);
    expect(shown).toContain('"🔔 Вкл · Перебили в финале"');
    expect(shown).toContain('"Перебили: раз в 15 минут"');
    expect(shown).toContain('"🔔 Вкл · Анонс финала"');
  });

  // Выключатель финала (PER-539) — целевое состояние: частоту он не трогает.
  it("switches the final announcements off without touching the frequency", async () => {
    const ports = withOutbid(stored("15"));
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(
      lotPress({ data: notifyCallback({ kind: "final", enabled: false }) }),
    );
    expect(ports.chosen).toEqual([{ kind: "final", enabled: false }]);
    expect(calls[0]?.payload).toMatchObject({
      text: "Выключено: анонс финала.",
    });
    const shown = JSON.stringify(calls[1]?.payload);
    expect(shown).toContain('"🔕 Выкл · Анонс финала"');
    expect(shown).toContain('"Перебили: раз в 15 минут"');
  });

  it("treats a switch outside the dictionary as unknown data", async () => {
    const ports = withOutbid(stored("every"));
    const { bot } = makeBot(ports);
    await bot.handleUpdate(lotPress({ data: "v1:entry:notify:final:2" }));
    await bot.handleUpdate(lotPress({ data: "v1:entry:notify:live:2" }));
    expect(ports.chosen).toEqual([]);
  });

  // Критерий PER-515: выбор переживает рестарт бота — бот его не помнит, а
  // читает у Notifications.
  it("shows the stored choice after the bot restarts", async () => {
    const store = stored("every");
    await makeBot(withOutbid(store)).bot.handleUpdate(
      lotPress({ data: mode("60") }),
    );
    const restarted = makeBot(withOutbid(store));
    await restarted.bot.handleUpdate(lotPress({ data: notifyCallback() }));
    expect(JSON.stringify(restarted.calls.at(-1)?.payload)).toContain(
      "Перебили: раз в час",
    );
  });

  // Критерий PER-515: недоступный Notifications — отказ, а не молчаливое
  // сохранение; повтор несёт тот же выбор.
  it("refuses without a toast when Notifications is down", async () => {
    const ports = withOutbid(stored("every"), {
      set: () => Promise.reject(new ConnectError("down", Code.Unavailable)),
    });
    const { bot, calls } = makeBot(ports);
    await bot.handleUpdate(lotPress({ data: mode("off") }));
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
    ]);
    expect(calls[0]?.payload).not.toHaveProperty("text");
    expect(calls[1]?.payload).toMatchObject({
      text: "<b>Настройка уведомлений сейчас недоступна.</b> Попробуй ещё раз через минуту.",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Повторить", callback_data: mode("off") },
            { text: "‹ Аукционы", callback_data: entryCallback("auctions") },
          ],
        ],
      },
    });
  });

  it("refuses an answer outside the contract instead of guessing a default", async () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      service: "auction-bot",
      out: (line) => lines.push(line),
    });
    const { bot, calls } = makeBot(withOutbid({ settings: undefined }), {
      logger,
    });
    await bot.handleUpdate(lotPress({ data: notifyCallback() }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Настройка уведомлений сейчас недоступна."),
    });
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      result: "error",
      error_category: "invariant",
    });
  });

  // «Частота уведомлений» под перебитием открывает экран новым сообщением:
  // уведомление остаётся в истории целым.
  it("opens the settings from the outbid notification as a new message", async () => {
    const { bot, calls } = makeBot(withOutbid(stored("every")));
    await bot.handleUpdate(lotPress({ data: traceNotifyCallback() }));
    expect(calls.map((call) => call.method)).not.toContain("editMessageText");
    expect(calls.at(-1)).toMatchObject({
      method: "sendMessage",
      payload: { text: expect.stringContaining("<b>Уведомления</b>") },
    });
  });

  // Человек пришёл из вести, а не из «Настроек»: возврата в дерево у экрана
  // нет, и выбор режима на нём вид держит (№73 прогона 14 октября 2026 года).
  it("opens the settings from a notification without the way back to the settings", async () => {
    const ports = withOutbid(stored("every"));
    const { bot, calls } = makeBot(ports);
    const labels = () =>
      JSON.stringify(calls.at(-1)?.payload).match(/"text":"[^"]*"/g) ?? [];
    await bot.handleUpdate(lotPress({ data: traceNotifyCallback() }));
    expect(labels().some((label) => label.includes("‹"))).toBe(false);
    const shown = calls.at(-1)?.payload as
      | { reply_markup?: { inline_keyboard: { callback_data: string }[][] } }
      | undefined;
    const first = shown?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
    expect(first).toBe(
      notifyCallback({ kind: "frequency", frequency: "5" }, true),
    );
    await bot.handleUpdate(lotPress({ data: first ?? "" }));
    expect(ports.chosen).toEqual([{ kind: "frequency", frequency: "5" }]);
    expect(labels().some((label) => label.includes("‹"))).toBe(false);
  });

  // Участник сообщества настройки здесь не получает: его перебития приходят
  // в бот хаба (ADR-064), и Notifications не зовётся.
  it("sends a community member to the hub bot without touching Notifications", async () => {
    const ports = withOutbid(stored("every"));
    const member: PortsFactory = (requestId) => ({
      ...ports(requestId),
      identity: {
        resolveIdentity: async () => ({
          viewer: {
            identityId: VIEWER_ID,
            rights: ["access-hub", "place-bids"],
          },
          blocked: false,
        }),
      },
    });
    const { bot, calls } = makeBot(member);
    await bot.handleUpdate(lotPress({ data: mode("off") }));
    expect(ports.chosen).toEqual([]);
    expect(calls.at(-1)?.payload).toMatchObject({
      text: deniedTexts["in-community"],
    });
  });

  it("treats the settings button as outdated in a bot without Notifications", async () => {
    const { bot, calls } = makeBot(publicPorts);
    await bot.handleUpdate(lotPress({ data: mode("off") }));
    expect(calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Этот экран устарел."),
    });
  });
});

// «Счастливые часы» (PER-505): сумма кнопки — порог снимка, который Auction уже
// считает по шагу окна, а конец окна виден следующим чтением снимка без
// рестарта бота: карточка его не кэширует.
describe("happy hours", () => {
  const shown = (calls: Array<{ payload: unknown }>) =>
    JSON.stringify(calls.at(-1)?.payload).replace(/[  ]/g, " ");
  // У лота есть лидер: ставка по порогу — «По шагу», а не первая (PER-631).
  const trading = {
    kind: "trading" as const,
    currentPrice: { minorUnits: 120_000, currency: "RUB" },
    leaderId: "01929b7e-5c1d-7a3f-8e4b-0000000000ff",
    phase: "online" as const,
  };
  const rub = (rubles: number) => ({
    minorUnits: rubles * 100,
    currency: "RUB",
  });

  it("bids by the window step and shows the regular step after the window", async () => {
    const overrides: { lot: Partial<LotView> } = {
      lot: {
        nextPrice: rub(1210),
        fixedStep: rub(50),
        baseStep: rub(50),
        activeWindow: {
          from: "2026-10-10T15:00:00Z",
          until: "2026-10-10T18:00:00Z",
          step: rub(10),
        },
        status: trading,
      },
    };
    const { bot, calls } = makeBot(portsWith(overrides));
    await bot.handleUpdate(lotPress());
    expect(shown(calls)).toContain("По шагу (1 210 ₽)");
    expect(shown(calls)).toContain("Счастливые часы: шаг 10 ₽ до");
    // Окно кончилось: тот же процесс читает новый снимок по «Обновить».
    overrides.lot = {
      nextPrice: rub(1250),
      fixedStep: rub(50),
      baseStep: rub(50),
      status: trading,
    };
    await bot.handleUpdate(lotPress());
    expect(shown(calls)).toContain("По шагу (1 250 ₽)");
    expect(shown(calls)).toContain("Шаг: 50 ₽");
    expect(shown(calls)).not.toContain("Счастливые часы");
  });

  // Auction отдаёт будущее окно с объявленной суммой; окно, которое при
  // текущей цене шаг не снизит, карточка не обещает.
  it("announces a future window only when it lowers the step", async () => {
    const window = {
      from: "2026-10-11T12:00:00Z",
      until: "2026-10-11T15:00:00Z",
    };
    const lowering = makeBot(
      portsWith({
        lot: {
          baseStep: rub(50),
          nextWindow: { ...window, step: rub(10) },
          status: trading,
        },
      }),
    );
    await lowering.bot.handleUpdate(lotPress());
    expect(shown(lowering.calls)).toContain(
      "Счастливые часы: с 11 октября, вс, 15:00 до 18:00, шаг 10 ₽",
    );
    const idle = makeBot(
      portsWith({
        lot: {
          baseStep: rub(50),
          nextWindow: { ...window, step: rub(50) },
          status: trading,
        },
      }),
    );
    await idle.bot.handleUpdate(lotPress());
    expect(shown(idle.calls)).not.toContain("Счастливые часы");
  });
});

// Избранное (PER-495): отметки живут в Notifications. Фейк держит их вне бота,
// как сервис, и отвечает состоянием после команды: повтор отметки дубля не
// создаёт.
function notificationsFavorites() {
  const marks: string[] = [];
  const port: FavoritesPort = {
    listFollowedLots: async () => [...marks],
    followLot: async ({ lotId: marked }) => {
      if (!marks.includes(marked)) marks.push(marked);
      return { kind: "done", following: true };
    },
    unfollowLot: async ({ lotId: unmarked }) => {
      const at = marks.indexOf(unmarked);
      if (at >= 0) marks.splice(at, 1);
      return { kind: "done", following: false };
    },
  };
  return { marks, port };
}

function press(data: string): Update {
  return lotPress({ data });
}

type SentScreen = { text: string; keyboard: SentButton[][] };

// Последний экран, который бот показал: текст и клавиатура вызова Bot API.
function lastScreen(calls: Array<{ method: string; payload: unknown }>) {
  const sent = calls.filter(({ payload }) => keyboardOf(payload).length > 0);
  const last = sent.at(-1)?.payload as
    | { text?: string; rich_message?: { html?: string } }
    | undefined;
  return {
    text: last?.text ?? last?.rich_message?.html ?? "",
    keyboard: keyboardOf(last),
  } satisfies SentScreen;
}

function buttonData(screen: SentScreen, label: string): string {
  const data = screen.keyboard
    .flat()
    .find((button) => button.text === label)?.callback_data;
  if (data === undefined) throw new Error(`no button ${label}`);
  return data;
}

describe("favorite lots", () => {
  it("marks a lot, lists it once after a restart and unmarks it", async () => {
    const favorites = notificationsFavorites();
    const ports = portsWith({
      favorites: favorites.port,
      lot: {
        status: {
          kind: "scheduled",
          startingPrice: { minorUnits: 50_000, currency: "RUB" },
        },
      },
    });
    const first = makeBot(ports);

    await first.bot.handleUpdate(lotPress());
    const card = lastScreen(first.calls);
    expect(card.keyboard.flat().map((b) => b.text)).toContain(
      "Добавить в избранное",
    );

    await first.bot.handleUpdate(
      press(buttonData(card, "Добавить в избранное")),
    );
    expect(
      lastScreen(first.calls)
        .keyboard.flat()
        .map((b) => b.text),
    ).toContain("Убрать из избранного");
    // Повторное нажатие той же кнопки со старого экрана дубля не создаёт.
    await first.bot.handleUpdate(
      press(buttonData(card, "Добавить в избранное")),
    );
    expect(favorites.marks).toEqual([lotId]);

    // Рестарт процесса: память бота пропала, отметка осталась в сервисе.
    // Избранное открывается только из корня аукциона (PER-644): набранная по
    // старой привычке `/favorites` получает кадр устаревшего экрана.
    const second = makeBot(ports);
    await second.bot.handleUpdate(commandUpdate("/favorites"));
    expect(lastScreen(second.calls).text).toContain("Этот экран устарел.");
    const root = encodeAuctionCallback({ kind: "root", auctionId });
    await second.bot.handleUpdate(press(root));
    await second.bot.handleUpdate(
      press(buttonData(lastScreen(second.calls), "Избранное")),
    );
    const list = lastScreen(second.calls);
    expect(list.text).toContain("<b>Избранное</b>");
    expect(list.text).toContain("Лотов в избранном: 1.");
    // Возврат — в корень аукциона, откуда список открыт.
    expect(list.keyboard.flat().map((b) => b.text)).toEqual([
      "Кружка · старт 500 ₽",
      "‹ Аукцион",
    ]);

    await second.bot.handleUpdate(
      press(buttonData(list, "Кружка · старт 500 ₽")),
    );
    await second.bot.handleUpdate(
      press(buttonData(lastScreen(second.calls), "Убрать из избранного")),
    );
    expect(favorites.marks).toEqual([]);
    await second.bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "favorites", page: 0, auctionId })),
    );
    // Пустой список несёт только возврат: его текст — в последнем вызове.
    expect(second.calls.at(-1)?.payload).toMatchObject({
      text: expect.stringContaining("Лотов в избранном пока нет."),
    });
  });

  // Карточка участника в онлайн-торгах с автоставкой и избранным (PER-594,
  // PER-644): ставка по шагу, своя сумма с автоставкой, «Обновить» с
  // избранным, «Ставки» и возврат; соседей в пустой ленте нет. Пустое
  // описание — заглушка.
  it("fits the card of a participant with limits and favorites into five rows", async () => {
    const { bot, calls } = makeBot(
      portsWith({
        favorites: notificationsFavorites().port,
        lot: {
          nextPrice: { minorUnits: 125_000, currency: "RUB" },
          proxyEnabled: true,
          status: {
            kind: "trading",
            currentPrice: { minorUnits: 120_000, currency: "RUB" },
            phase: "online",
          },
        },
      }),
    );

    await bot.handleUpdate(lotPress());

    const card = lastScreen(calls);
    expect(card.keyboard.map((row) => row.map((b) => b.text))).toEqual([
      [expect.stringMatching(/^Первая ставка \(1\s250\s₽\)$/)],
      ["Своя сумма", "Автоставка"],
      ["Ставки", "Добавить в избранное"],
      ["🔄 Обновить"],
      ["‹ Лоты"],
    ]);
    expect(card.text).toContain("Описание пока не добавлено.");
  });

  // Без адреса Notifications избранного у бота нет вовсе: ни команды в меню
  // клиента, ни кнопки на карточке.
  it("lists neither the command nor the card button without Notifications", async () => {
    const { bot, calls } = makeBot(publicPorts);

    expect(commandsFor(false).map((entry) => entry.command)).not.toContain(
      "favorites",
    );
    await bot.handleUpdate(lotPress());
    expect(JSON.stringify(lastScreen(calls).keyboard)).not.toContain(
      "Добавить в избранное",
    );
  });

  // Отметку подделанным нажатием участник сообщества не ставит: на любом
  // действии ему отвечает переход в бот хаба (ADR-064, пункт 2).
  it("answers a forged follow press of a community member with the hub transfer", async () => {
    const favorites = notificationsFavorites();
    const member = portsWith({ favorites: favorites.port });
    const { bot, calls } = makeBot(() => ({
      ...member("req"),
      identity: {
        resolveIdentity: async () => ({
          viewer: { identityId: VIEWER_ID, rights: ["access-hub"] },
          blocked: false,
        }),
      },
    }));

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "follow", lotId, page: 0 })),
    );
    expect(favorites.marks).toEqual([]);
    expect(JSON.stringify(calls)).toContain(deniedTexts["in-community"]);
  });
});

// Розыгрыш среди участников (ADR-066) — служба с состоянием вместо Auction:
// регистрация меняет отметку, жеребьёвку тест проводит сам.
function raffleService(initial: RaffleView) {
  let raffle: RaffleView | undefined = initial;
  const service = {
    get current() {
      return raffle;
    },
    set(next: RaffleView | undefined) {
      raffle = next;
    },
    registrations: [] as string[],
    methods: {
      getRaffle: async () => raffle,
      registerForRaffle: async (request: { opId: string }) => {
        service.registrations.push(request.opId);
        if (raffle === undefined || raffle.status !== "open") {
          return {
            kind: "refused" as const,
            refusal: "registration-closed" as const,
          };
        }
        raffle = { ...raffle, registered: true };
        return { kind: "accepted" as const, raffle };
      },
      cancelRaffleRegistration: async () => {
        if (raffle === undefined) throw new Error("no raffle");
        raffle = { ...raffle, registered: false };
        return { kind: "accepted" as const, raffle };
      },
    },
  };
  return service;
}

function withRaffle(
  factory: PortsFactory,
  service: ReturnType<typeof raffleService>,
): PortsFactory {
  return (requestId, deadlineAt) => {
    const ports = factory(requestId, deadlineAt);
    return { ...ports, auction: { ...ports.auction, ...service.methods } };
  };
}

const openRaffle: RaffleView = {
  auctionId,
  status: "open",
  closesAt: "2026-10-29T18:00:00Z",
  commitment: "ab".repeat(32),
  beaconRound: 12_345_678,
  registered: false,
  tickets: [],
};

// Программа недели (PER-724): абзац корня аукциона по сводке и розыгрышу.
describe("week programme in the auction root", () => {
  const inHours = (hours: number) =>
    new Date(Date.now() + hours * 3_600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
  function programmePorts(
    getRaffle: () => Promise<RaffleView | undefined>,
  ): PortsFactory {
    return (requestId, deadlineAt) => {
      const ports = publicPorts(requestId, deadlineAt);
      return {
        ...ports,
        auction: {
          ...ports.auction,
          getAuction: async () => ({
            auctionId,
            stage: "prebidding" as const,
            opensAt: inHours(-48),
            closesAt: inHours(96),
            final: true,
            finalAt: inHours(100),
            stepWindows: [
              { from: inHours(-1), until: inHours(1), lotIds: ["a", "b", "c"] },
            ],
          }),
          getRaffle,
        },
      };
    };
  }

  it("shows the happy hours, the raffle, the deadline and the final", async () => {
    const { bot, calls } = makeBot(
      programmePorts(async () => ({ ...openRaffle, closesAt: inHours(50) })),
    );

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "root", auctionId })),
    );
    const root = lastScreen(calls);
    expect(root.text).toContain("<b>Программа недели</b>");
    expect(root.text).toMatch(
      /Счастливые часы: сейчас, до (?:.+, )?\d\d:\d\d — 3 лота/,
    );
    expect(root.text).toContain("Розыгрыш: ");
    expect(root.text).toContain("Онлайн-торги до ");
    expect(root.text).toContain("Финал: ориентировочно ");
  });

  // Отказ чтения розыгрыша убирает его строку и кнопку, а не корень.
  it("keeps the root without the raffle line when the raffle read fails", async () => {
    const { bot, calls } = makeBot(
      programmePorts(async () => {
        throw new Error("auction unavailable");
      }),
    );

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "root", auctionId })),
    );
    const root = lastScreen(calls);
    expect(root.text).toContain("<b>Программа недели</b>");
    expect(root.text).not.toContain("Розыгрыш");
    expect(root.text).toContain("Финал: ориентировочно ");
    expect(root.keyboard.flat().map((button) => button.text)).not.toContain(
      "Розыгрыш",
    );
  });
});

describe("raffle among the participants", () => {
  // Вход — «Розыгрыш» в корне аукциона, как в хабе (PER-644).
  it("registers from the auction root, shows the commitment and then the result", async () => {
    const service = raffleService(openRaffle);
    const { bot, calls } = makeBot(withRaffle(publicPorts, service));

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "root", auctionId })),
    );
    const root = lastScreen(calls);
    await bot.handleUpdate(press(buttonData(root, "Розыгрыш")));
    const before = lastScreen(calls);
    expect(before.text).toContain("<b>Розыгрыш среди участников</b>");
    expect(before.text).toContain("Ты пока не зарегистрирован.");
    expect(before.keyboard.flat().map((b) => b.text)).toEqual([
      "Зарегистрироваться",
      "Как проверить честность",
      "‹ Аукцион",
    ]);

    await bot.handleUpdate(press(buttonData(before, "Зарегистрироваться")));
    // Принятая регистрация — свой экран исхода (прогон 14.10, №69).
    const outcome = lastScreen(calls);
    expect(outcome.text).toContain("<b>Ты в розыгрыше</b>");
    expect(outcome.keyboard.flat().map((b) => b.text)).toEqual([
      "Отменить регистрацию",
      "‹ Розыгрыш",
      "‹ Аукцион",
    ]);

    await bot.handleUpdate(press(buttonData(outcome, "‹ Розыгрыш")));
    const registered = lastScreen(calls);
    expect(registered.text).toContain("Ты зарегистрирован.");
    // Техника — за кнопкой (PER-618): экран участника о ней молчит.
    expect(registered.text).toContain("Итог проверяемый");
    expect(registered.text).not.toContain("ab".repeat(32));
    expect(registered.text).not.toContain("drand");
    expect(registered.keyboard.flat().map((b) => b.text)).toEqual([
      "Отменить регистрацию",
      "Как проверить честность",
      "‹ Аукцион",
    ]);
    expect(service.registrations).toHaveLength(1);

    await bot.handleUpdate(
      press(buttonData(registered, "Как проверить честность")),
    );
    const commitment = lastScreen(calls);
    expect(commitment.text).toContain("<b>Как проверить честность</b>");
    expect(commitment.text).toContain("ab".repeat(32));
    expect(commitment.text).toContain("12345678");
    expect(commitment.text).not.toContain("python3 -c");
    expect(commitment.keyboard.flat().map((b) => b.text)).toEqual([
      "‹ Розыгрыш",
    ]);

    // Жеребьёвка прошла: пул зафиксирован, seed раскрыт.
    service.set({
      ...openRaffle,
      status: "drawn",
      drawnAt: "2026-10-29T22:30:00Z",
      registered: true,
      tickets: [
        { number: 1, displayName: "@owl" },
        { number: 2, displayName: "Сова*" },
      ],
      myTicket: 1,
      reveal: {
        seed: "cd".repeat(32),
        randomness: "ef".repeat(32),
        value: "12".repeat(32),
        winningTicket: 2,
      },
    });
    await bot.handleUpdate(press(buttonData(registered, "‹ Аукцион")));
    await bot.handleUpdate(press(buttonData(lastScreen(calls), "Розыгрыш")));
    const result = lastScreen(calls);
    expect(result.text).toContain("Выиграл билет №2 — Сова*");
    expect(result.text).toContain("Билетов: 2");
    expect(result.text).toContain("Твой билет: №1");
    // Момент жеребьёвки во времени сообщества (PER-641): 22:30 UTC — уже
    // 30 октября по Москве.
    expect(result.text).toContain("Жеребьёвка: 30 октября");
    expect(result.text).not.toContain("cd".repeat(32));
    expect(result.text).not.toContain("python3 -c");
    expect(result.keyboard.flat().map((b) => b.text)).toEqual([
      "Как проверить честность",
      "‹ Аукцион",
    ]);

    await bot.handleUpdate(
      press(buttonData(result, "Как проверить честность")),
    );
    const proof = lastScreen(calls);
    expect(proof.text).toContain("ab".repeat(32));
    expect(proof.text).toContain("cd".repeat(32));
    expect(proof.text).toContain("Как проверить итог");
    expect(proof.text).toContain("python3 -c");
    await bot.handleUpdate(press(buttonData(proof, "‹ Розыгрыш")));
    expect(lastScreen(calls).text).toContain("Выиграл билет №2 — Сова*");
  });

  // Вне окна регистрации кнопки нет — есть объяснение.
  it("offers no registration once registration has closed", async () => {
    const service = raffleService({ ...openRaffle, status: "closing" });
    const { bot, calls } = makeBot(withRaffle(publicPorts, service));

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle", auctionId })),
    );
    const screen = lastScreen(calls);
    expect(screen.text).toContain("Регистрация закрыта");
    // До жеребьёвки строки момента нет (PER-641).
    expect(screen.text).not.toContain("Жеребьёвка: ");
    expect(screen.keyboard.flat().map((b) => b.text)).toEqual([
      "Как проверить честность",
      "‹ Аукцион",
    ]);
  });

  // Непроведённый розыгрыш проверять нечего: кнопки проверки нет.
  it("offers no proof of a raffle that was not held", async () => {
    const service = raffleService({
      auctionId,
      status: "not-held",
      closesAt: openRaffle.closesAt,
      registered: false,
      tickets: [],
    });
    const { bot, calls } = makeBot(withRaffle(publicPorts, service));

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle", auctionId })),
    );
    expect(
      lastScreen(calls)
        .keyboard.flat()
        .map((b) => b.text),
    ).toEqual(["‹ Аукцион"]);
  });

  // Фото приза (PER-773): первым блоком rich-сообщения над заголовком, как
  // фото лота, `file_id` — в тот же кэш; фото не прочиталось — тот же экран
  // без фото, а не сбой.
  it("shows the prize photo above the raffle and the raffle without it when unreadable", async () => {
    const service = raffleService({
      ...openRaffle,
      prize: "Кружка",
      prizePhoto: { photoId: "prize-1", version: "prize-v1" },
    });
    const withPhoto =
      (
        getRafflePrizePhoto: NonNullable<LotImagePort["getRafflePrizePhoto"]>,
      ): PortsFactory =>
      (requestId, deadlineAt) => {
        const ports = withRaffle(publicPorts, service)(requestId, deadlineAt);
        return { ...ports, image: { ...ports.image, getRafflePrizePhoto } };
      };
    const raffleData = encodeAuctionCallback({ kind: "raffle", auctionId });
    const getRafflePrizePhoto = vi.fn(async () => ({
      content: new Uint8Array([9]),
      mediaType: "image/jpeg",
      version: "prize-v1",
    }));
    const { bot, calls } = makeBot(withPhoto(getRafflePrizePhoto), {
      photos: createPhotoCache(),
    });
    await bot.handleUpdate(press(raffleData));
    await bot.handleUpdate(press(raffleData));

    expect(getRafflePrizePhoto).toHaveBeenCalledTimes(1);
    const edits = calls.filter((call) => call.method === "editMessageText");
    const first = edits[0]?.payload as { rich_message: { html: string } };
    expect(first.rich_message.html).toMatch(
      /^<img src="tg:\/\/photo\?id=lot"\/><h1>Розыгрыш среди участников<\/h1>/,
    );
    expect(first.rich_message.html).toContain("<p>Приз: Кружка</p>");
    expect(edits[1]?.payload).toMatchObject({
      rich_message: { media: [{ id: "lot", media: { media: "large" } }] },
    });

    const failing = makeBot(
      withPhoto(async () => {
        throw new Error("no prize photo");
      }),
    );
    await failing.bot.handleUpdate(press(raffleData));
    const screen = lastScreen(failing.calls);
    expect(screen.text).toMatch(/^<h1>Розыгрыш среди участников<\/h1>/);
    expect(screen.keyboard.flat().map((b) => b.text)).toEqual([
      "Зарегистрироваться",
      "Как проверить честность",
      "‹ Аукцион",
    ]);
  });

  // Отменённый вместе с аукционом розыгрыш (PER-698): «Розыгрыш» корня ведёт
  // в экран отмены с возвратом в корень, а не в кадр сбоя. Статус приходит
  // переводом ответа Auction, как у настоящего клиента.
  it("shows a raffle cancelled with its auction as its own screen", async () => {
    const service = raffleService(openRaffle);
    service.methods.getRaffle = async () =>
      raffleOf(
        create(RaffleSchema, {
          auctionId,
          status: RaffleStatus.CANCELLED,
          closesAt: openRaffle.closesAt,
          commitment: "ab".repeat(32),
          beaconRound: 12_345_678n,
          registered: true,
        }),
      );
    const { bot, calls } = makeBot(withRaffle(publicPorts, service));

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "root", auctionId })),
    );
    await bot.handleUpdate(press(buttonData(lastScreen(calls), "Розыгрыш")));
    const screen = lastScreen(calls);
    expect(screen.text).toContain("<b>Розыгрыш среди участников</b>");
    expect(screen.text).toContain(
      "Розыгрыш отменён вместе с аукционом: жеребьёвки не будет.",
    );
    expect(screen.text).not.toContain("недоступен");
    expect(screen.keyboard.flat().map((b) => b.text)).toEqual(["‹ Аукцион"]);
  });

  // Статус, которого бот не знает, отменой не становится (PER-698): перевод
  // бросает, и человек видит кадр сбоя, а не экран отмены.
  it("keeps the failure frame for a raffle of an unknown status", async () => {
    const service = raffleService(openRaffle);
    service.methods.getRaffle = async () =>
      raffleOf(
        create(RaffleSchema, {
          auctionId,
          status: (RaffleStatus.AWAITING_WINNER + 1) as RaffleStatus,
          closesAt: openRaffle.closesAt,
        }),
      );
    const { bot, calls } = makeBot(withRaffle(publicPorts, service));

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle", auctionId })),
    );
    const screen = lastScreen(calls);
    expect(screen.text).toContain("Аукцион сейчас недоступен");
    expect(screen.text).not.toContain("отменён");
  });

  // «К розыгрышу» под итогом (PER-620) — кнопка следа: экран итога приходит
  // новым сообщением, весть не правится и не удаляется.
  it("opens the raffle under a result notification as a new message", async () => {
    const service = raffleService({
      ...openRaffle,
      status: "drawn",
      registered: true,
      tickets: [{ number: 1 }, { number: 2 }],
      myTicket: 1,
      reveal: { seed: "cd".repeat(32), winningTicket: 2 },
    });
    const { bot, calls } = makeBot(withRaffle(publicPorts, service));

    await bot.handleUpdate(lotPress({ data: traceRaffleCallback(auctionId) }));
    const methods = calls.map((call) => call.method);
    expect(methods).toContain("sendMessage");
    expect(methods).not.toContain("editMessageText");
    expect(methods).not.toContain("deleteMessage");
    expect(lastScreen(calls).text).toContain("Выиграл билет №2.");
  });

  it("shows no raffle button on the feed of an auction without a raffle", async () => {
    const { bot, calls } = makeBot(publicPorts);

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "feed", auctionId, page: 0 })),
    );
    expect(
      lastScreen(calls)
        .keyboard.flat()
        .map((b) => b.text),
    ).not.toContain("Розыгрыш");
  });
});

// Карточка финала (PER-336): открытая нажатием карточка лота живого финала
// правится по потоку аукциона тем же сообщением, а другой экран в нём её
// снимает.
describe("final lot card", () => {
  const RIVAL = "01926f3c-8b7a-7cde-8f00-00000000000b";
  const rub = (rubles: number) => ({
    minorUnits: rubles * 100,
    currency: "RUB",
  });
  const liveLot = (version: number, price: number): LotView => ({
    lotId,
    auctionId,
    version,
    card: { title: "Кружка", description: "" },
    nextPrice: rub(price + 100),
    proxyEnabled: true,
    status: {
      kind: "trading",
      currentPrice: rub(price),
      leaderId: RIVAL,
      phase: "live",
    },
  });

  function liveStream() {
    const listeners = new Set<(state: AuctionWatchState) => void>();
    const watches: AuctionWatches = {
      subscribe(_auctionId, _viewer, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      open: () => (listeners.size > 0 ? 1 : 0),
      close: () => listeners.clear(),
    };
    return {
      watches,
      listeners,
      emit(activeLot: LotView) {
        for (const listener of [...listeners]) {
          listener({ auctionId, finished: false, activeLot, lineup: [] });
        }
      },
    };
  }

  // Темп проверяет тест лимитера; здесь правка уходит сразу.
  const immediate: EditLimiter = {
    submit: (_chat, _key, task) => {
      void task();
    },
    drop: () => {},
    waiting: () => 0,
    close: () => {},
  };

  const flush = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  };

  const edits = (calls: Array<{ method: string; payload: unknown }>) =>
    calls.filter(
      ({ method, payload }) =>
        method === "editMessageText" &&
        (payload as { message_id?: number }).message_id === 7 &&
        (payload as { chat_id?: number }).chat_id === 42,
    );

  // Сумму `Intl` пишет с неразрывными пробелами: тест сравнивает обычные.
  const plain = (text: string) => text.replace(/[  ]/g, " ");
  const htmlOf = (payload: unknown) =>
    plain(
      (payload as { rich_message?: { html?: string } }).rich_message?.html ??
        "",
    );
  const labels = (payload: unknown) =>
    keyboardOf(payload)
      .flat()
      .map((b) => plain(b.text));

  function setup(
    options: {
      lot?: LotView;
      refuseWith?: Record<string, { code: number; description: string }>;
    } = {},
  ) {
    const stream = liveStream();
    const ports = portsWith({
      lot: options.lot ?? liveLot(1, 1200),
      names: { [RIVAL]: "@jay" },
    });
    const { bot, calls } = makeBot(ports, {
      live: {
        watches: stream.watches,
        limiter: immediate,
        names: { getDisplayNames: async () => ({ [RIVAL]: "@jay" }) },
      },
      ...(options.refuseWith === undefined
        ? {}
        : { refuseWith: options.refuseWith }),
    });
    return { bot, calls, stream };
  }

  it("keeps one button at the next price as the price moves", async () => {
    const { bot, calls, stream } = setup();
    await bot.handleUpdate(lotPress({ rich: true }));
    const opened = lastScreen(calls);
    expect(opened.keyboard.flat().map((b) => plain(b.text))).toContain(
      "Поставить 1 300 ₽",
    );
    expect(plain(opened.text)).toContain("Следующая ставка: 1 300 ₽");
    const before = edits(calls).length;
    stream.emit(liveLot(2, 1400));
    await flush();
    const after = edits(calls);
    expect(after).toHaveLength(before + 1);
    const edited = after.at(-1)?.payload;
    expect(htmlOf(edited)).toContain("Цена: 1 400 ₽");
    expect(htmlOf(edited)).toContain("Лидер: @jay");
    expect(labels(edited)).toContain("Поставить 1 500 ₽");
  });

  it("names the ask of the auctioneer", async () => {
    const { bot, calls, stream } = setup();
    await bot.handleUpdate(lotPress({ rich: true }));
    stream.emit({
      ...liveLot(2, 1200),
      nextPrice: rub(2000),
      status: {
        kind: "trading",
        currentPrice: rub(1200),
        leaderId: RIVAL,
        phase: "live",
        ask: rub(2000),
      },
    });
    await flush();
    const edited = edits(calls).at(-1)?.payload;
    expect(htmlOf(edited)).toContain("Ведущий объявил: 2 000 ₽");
    expect(labels(edited)).toContain("Поставить 2 000 ₽");
  });

  it("stops editing once another screen takes the message", async () => {
    const { bot, calls, stream } = setup();
    await bot.handleUpdate(lotPress({ rich: true }));
    // «‹ Лоты» правит то же сообщение в ленту.
    await bot.handleUpdate(
      lotPress({
        rich: true,
        data: encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
      }),
    );
    expect(stream.listeners.size).toBe(0);
    const before = edits(calls).length;
    stream.emit(liveLot(2, 1400));
    await flush();
    expect(edits(calls)).toHaveLength(before);
  });

  // Сообщение удалили: правка получает отказ, карточку больше не правят и
  // нового сообщения вместо неё не шлют — живой экран не становится рассылкой.
  it("forgets the card when Telegram no longer has the message", async () => {
    const { bot, calls, stream } = setup();
    await bot.handleUpdate(
      lotPress({
        data: encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
      }),
    );
    // Нажатие пришло из текстового сообщения, и правка его в rich-карточку
    // прошла; дальше сообщения нет.
    const sentBefore = calls.filter(
      ({ method }) => method === "sendRichMessage" || method === "sendMessage",
    ).length;
    const refusing = makeBot(
      portsWith({ lot: liveLot(1, 1200), names: { [RIVAL]: "@jay" } }),
      {
        live: {
          watches: stream.watches,
          limiter: immediate,
          names: { getDisplayNames: async () => ({}) },
        },
        refuseWith: {
          editMessageText: {
            code: 400,
            description: "Bad Request: message to edit not found",
          },
        },
      },
    );
    await refusing.bot.handleUpdate(lotPress({ rich: true }));
    const subscribed = stream.listeners.size;
    stream.emit(liveLot(2, 1400));
    await flush();
    expect(stream.listeners.size).toBe(subscribed - 1);
    expect(
      refusing.calls.filter(({ method }) => method === "sendRichMessage")
        .length,
    ).toBe(1);
    expect(
      calls.filter(
        ({ method }) =>
          method === "sendRichMessage" || method === "sendMessage",
      ).length,
    ).toBe(sentBefore);
  });

  // Telegram забыл `file_id` фото из кэша: правка вытесняет запись и идёт без
  // фото, а не падает на каждой следующей цене.
  it("edits without the photo once Telegram refuses the cached file", async () => {
    const stream = liveStream();
    const photos = createPhotoCache();
    photos.set({ lotId, version: "img-1" }, "known-file");
    const lot = { ...liveLot(1, 1200), card: withImage.card };
    const options: Parameters<typeof makeBot>[1] = {
      photos,
      live: {
        watches: stream.watches,
        limiter: immediate,
        names: { getDisplayNames: async () => ({}) },
      },
    };
    const { bot, calls } = makeBot(
      portsWith({ lot, names: { [RIVAL]: "@jay" } }),
      options,
    );
    await bot.handleUpdate(lotPress({ rich: true }));
    options.refuseOnce = {
      editMessageText: "Bad Request: wrong file identifier/HTTP URL specified",
    };
    stream.emit({ ...liveLot(2, 1400), card: withImage.card });
    await flush();
    const last = edits(calls).at(-1)?.payload as {
      rich_message?: { media?: unknown[] };
    };
    expect(last.rich_message?.media).toBeUndefined();
    expect(photos.get({ lotId, version: "img-1" })).toBeUndefined();
  });

  // Гонка двух нажатий (ADR-049): второе получает отказ с новой ценой, и та
  // же карточка несёт кнопку на неё.
  it("answers a bid at a moved price with the new price on the card", async () => {
    const stream = liveStream();
    const base = portsWith({
      lot: liveLot(1, 1200),
      names: { [RIVAL]: "@jay" },
    });
    const ports: PortsFactory = (requestId, deadlineAt) => {
      const shared = base(requestId, deadlineAt);
      return {
        ...shared,
        auction: {
          ...shared.auction,
          placeBid: async () => ({
            kind: "refused",
            refusal: { kind: "bid-not-at-next-price", expected: rub(1400) },
          }),
        },
      };
    };
    const { bot, calls } = makeBot(ports, {
      live: {
        watches: stream.watches,
        limiter: immediate,
        names: { getDisplayNames: async () => ({}) },
      },
    });
    await bot.handleUpdate(
      lotPress({
        rich: true,
        data: encodeAuctionCallback({
          kind: "final-bid",
          lotId,
          amount: 130000,
          page: 0,
        }),
      }),
    );
    const shown = lastScreen(calls);
    expect(plain(shown.text)).toContain(
      "Цену уже подняли: следующая ставка — 1 400 ₽",
    );
    expect(shown.keyboard.flat().map((b) => plain(b.text))).toContain(
      "Поставить 1 400 ₽",
    );
    // Карточка после отказа остаётся живой.
    expect(stream.listeners.size).toBe(1);
  });
});

// Промо-видео (PER-774): «🎬 Промо» в корне аукциона, пока у аукциона есть видео
// и у бота чат медиа; нажатие присылает копию поста новым сообщением, а
// удалённый пост — ответ на нажатие «видео недоступно», и корень цел.
describe("promo video in the auction root", () => {
  const mediaChannelId = -1001234567890;
  const media = createMediaChat({
    channelId: mediaChannelId,
    logger: { warn: () => {} },
  });
  const promoPorts =
    (withMedia: boolean): PortsFactory =>
    (requestId, deadlineAt) => {
      const ports = publicPorts(requestId, deadlineAt);
      return {
        ...ports,
        ...(withMedia ? { media: true as const } : {}),
        auction: {
          ...ports.auction,
          getAuction: async () => ({
            auctionId,
            stage: "prebidding" as const,
            final: false,
            promoVideo: 77,
          }),
        },
      };
    };
  const toasts = (calls: Array<{ method: string; payload: unknown }>) =>
    calls
      .filter((call) => call.method === "answerCallbackQuery")
      .map((call) => (call.payload as { text?: string }).text)
      .filter((text) => text !== undefined);

  it("sends the post with a way back and keeps the root", async () => {
    const { bot, calls } = makeBot(promoPorts(true), { media });
    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "root", auctionId })),
    );
    const root = lastScreen(calls);
    const promo = root.keyboard
      .flat()
      .find((button) => button.text === "🎬 Промо");
    expect(promo?.callback_data).toBe(
      encodeAuctionCallback({ kind: "promo", auctionId }),
    );

    const before = calls.length;
    await bot.handleUpdate(press(promo?.callback_data ?? ""));
    const sent = calls.slice(before);
    expect(
      sent.filter((call) => call.method !== "answerCallbackQuery"),
    ).toEqual([
      {
        method: "copyMessage",
        payload: expect.objectContaining({
          chat_id: privateChat.id,
          from_chat_id: mediaChannelId,
          message_id: 77,
          caption: "<b>Промо-видео</b>",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "‹ Аукцион",
                  callback_data: encodeAuctionCallback({
                    kind: "root",
                    auctionId,
                  }),
                },
              ],
            ],
          },
        }),
      },
    ]);
    expect(toasts(calls)).toEqual([]);
  });

  it("opens the root as a new message under the video", async () => {
    const { bot, calls } = makeBot(promoPorts(true), { media });
    const update = press(encodeAuctionCallback({ kind: "root", auctionId }));
    (
      update.callback_query as unknown as { message: Record<string, unknown> }
    ).message = {
      message_id: 7,
      date: 0,
      chat: privateChat,
      video: {
        file_id: "v",
        file_unique_id: "u",
        width: 1,
        height: 1,
        duration: 3,
      },
      caption: "Промо-видео",
    };
    await bot.handleUpdate(update);
    const methods = calls.map((call) => call.method);
    expect(methods).not.toContain("editMessageText");
    expect(methods).toContain("sendMessage");
    expect(methods).toContain("editMessageReplyMarkup");
  });

  it("answers that the video is unavailable when the post is gone", async () => {
    const { bot, calls } = makeBot(promoPorts(true), {
      media,
      refuse: { copyMessage: "Bad Request: message to copy not found" },
    });
    const before = calls.length;
    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "promo", auctionId })),
    );
    expect(toasts(calls)).toEqual(["Видео недоступно."]);
    expect(
      calls
        .slice(before)
        .map((call) => call.method)
        .filter((method) => method !== "answerCallbackQuery"),
    ).toEqual(["copyMessage"]);
  });

  it("has no button without the media chat and answers a forged one", async () => {
    const { bot, calls } = makeBot(promoPorts(false));
    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "root", auctionId })),
    );
    expect(
      lastScreen(calls)
        .keyboard.flat()
        .map((button) => button.text),
    ).not.toContain("🎬 Промо");
    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "promo", auctionId })),
    );
    expect(toasts(calls)).toEqual(["Видео недоступно."]);
    expect(calls.map((call) => call.method)).not.toContain("copyMessage");
  });
});
