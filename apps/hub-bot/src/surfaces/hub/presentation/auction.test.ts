import { Code, ConnectError } from "@connectrpc/connect";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  createHarness,
  type HarnessOptions,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import {
  type AccessRight,
  type AuctionChronicleView,
  type AuctionStageView,
  type AuctionSummaryView,
  type DayChronicleView,
  encodeAuctionCallback,
  type FavoritesPort,
  type LotView,
  type MyInvoicesView,
  type PredictionRoundView,
  type RaffleView,
} from "../../../auction-ui/index.js";
import type {
  AuctionWatches,
  AuctionWatchState,
} from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import { createDispatcher } from "../application/dispatcher.js";
import type {
  AuctionScreenPorts,
  AuctionScreens,
  EnableAuctionResult,
  MeetupAuctionResult,
  MeetupAuctions,
} from "../auction/port.js";
import type {
  IdentityResolver,
  ParticipantUsernameResolver,
  ParticipantUsernameResult,
} from "../identity/port.js";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import { createAuctionParents } from "./auction-parents.js";
import { isAuctionCallback } from "./auction-route.js";
import { createLotPhotos } from "./lot-photos.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Аукцион у сходки в боте хаба (PER-307): вход и включение на карточке,
// оболочка ленты и лота с возвратом к сходке и доставка фото лота. Общий
// пакет и Auction подменены: здесь проверяется оболочка хаба, а поведение
// тела держит contract suite (`auction-contract.test.ts`).

const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const meetupToken = uuidToToken(meetupId);
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

const feedData = encodeAuctionCallback({ kind: "feed", auctionId, page: 0 });
const lotData = encodeAuctionCallback({ kind: "lot", lotId, page: 0 });
const setData = encodeAuctionCallback({ kind: "set", lotId, page: 0 });

function meetup(materials = 0): MeetupSnapshot {
  return {
    id: meetupId,
    title: "Ярмарка",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "visible",
    author: "0192f0a0-0000-7000-8000-00000000a001",
    version: 1,
    materials: Array.from({ length: materials }, (_, index) => ({
      id: `0192f0a0-0000-7000-8000-0000000000b${index}`,
      title: `Материал ${index + 1}`,
      source: { kind: "message-link" as const, url: "https://t.me/c/1/2" },
    })),
  };
}

const lot: LotView = {
  lotId,
  auctionId,
  version: 3,
  card: {
    title: "Кружка с совой",
    description: "Ручная роспись.",
    image: { version: "img-1" },
  },
  proxyEnabled: false,
  status: {
    kind: "scheduled",
    startingPrice: { minorUnits: 50_000, currency: "RUB" },
  },
};

// Пускает право хаба, а в Auction уходят права (RFC-016). По умолчанию права
// участника, у набора `admin` — ещё права вести сходки и аукцион (ADR-070);
// гостю тест передаёт права явно.
type Holder = "admin" | "member" | "guest";

function identity(
  holder: Holder,
  blocked = false,
  rights: readonly AccessRight[] = blocked
    ? []
    : holder === "admin"
      ? ["access-hub", "place-bids", "manage-meetups", "run-auctions"]
      : ["access-hub", "place-bids"],
  // Настоящий аккаунт участника (PER-648). По умолчанию Identity отказывает,
  // как участнику, который открыл карточку проданного лота.
  account: ParticipantUsernameResult = { kind: "denied" },
) {
  return {
    resolve: async () => ({
      kind: "resolved" as const,
      identityId,
      rights,
      blocked,
    }),
    resolveParticipantUsername: async () => account,
  } satisfies IdentityResolver & ParticipantUsernameResolver;
}

function fakeMeetups(snapshot = meetup(), down = false): Meetups {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    listVisible: notUsed,
    listArchived: notUsed,
    createDraft: notUsed,
    get: async () =>
      down
        ? { kind: "timeout", cause: new Error("budget spent") }
        : { kind: "ok", meetup: snapshot },
    changeAttributes: notUsed,
    setSchedule: notUsed,
    publish: async () => ({
      kind: "ok",
      meetup: { ...snapshot, visibility: "visible" },
    }),
    unpublish: notUsed,
    cancel: notUsed,
    markHeld: notUsed,
    schedulePublication: notUsed,
    cancelPublication: notUsed,
    attachMaterial: notUsed,
    removeMaterial: notUsed,
  };
}

// Auction с аукционом на сходку: ключ выводит сервер из сходки, поэтому второй
// аукцион не рождается ни от какого числа нажатий.
function fakeAuction(
  options: {
    existing?: boolean;
    lookup?: () => MeetupAuctionResult;
    enable?: () => EnableAuctionResult;
    image?: () => Promise<{ content: Uint8Array; version: string }>;
    // Лот ленты и карточки; по умолчанию — запланированный.
    lot?: LotView;
    // Розыгрыш аукциона (ADR-066): регистрация меняет отметку.
    raffle?: RaffleView;
    // Имя в аукционе ещё не выбрано: регистрация ждёт выбора имени, а
    // псевдоним — этот отказ, если он задан.
    nameless?: { aliasRefusal?: "alias-taken" };
    // Идущий аукцион сообщества (PER-595, PER-669); по умолчанию — нет его.
    current?: () => MeetupAuctionResult | Promise<MeetupAuctionResult>;
    stage?: "scheduled" | "prebidding" | "finished";
    // Хроники дня (PER-725): агрегаты последних суток от Auction.
    chronicle?: DayChronicleView;
    // Статистика аукциона (PER-770); "down" — чтение отказывает.
    auctionChronicle?: AuctionChronicleView | "down";
    // Отображаемые имена участников: карточка проданного лота называет
    // победителя.
    names?: Readonly<Record<string, string>>;
    // Аукцион скрыт от участников (PER-673): Auction отдал признак держателю
    // `run_auctions`.
    hidden?: true;
    // Второй лот сета (ADR-073): карточка ведёт к экрану сета, а тот — к
    // остальным его лотам.
    otherLot?: LotView;
    // Счета смотрящего (PER-322): выбор способа меняет счёт.
    invoices?: MyInvoicesView;
    // Программа недели (PER-724): поля сводки поверх умолчаний и отказ
    // чтения розыгрыша.
    summary?: Partial<AuctionSummaryView>;
    raffleFails?: true;
    // Свои раунды прогнозов (ADR-067): по умолчанию — ни одного.
    predictions?: readonly PredictionRoundView[];
    // Фото приза (PER-773): байты, которые отдаёт `GetRafflePrizePhoto`.
    prizePhoto?: () => Promise<{ content: Uint8Array; version: string }>;
  } = {},
) {
  const invoices: { current: MyInvoicesView } = {
    current: options.invoices ?? { invoices: [] },
  };
  const shownLot = options.lot ?? lot;
  const raffle: { current: RaffleView | undefined } = {
    current: options.raffle,
  };
  let named = options.nameless === undefined;
  const auctions = new Map<string, string>(
    options.existing === true ? [[meetupId, auctionId]] : [],
  );
  const opIds: string[] = [];
  const lookups: string[] = [];
  const image =
    options.image ??
    (async () => ({ content: new Uint8Array([1, 2, 3]), version: "img-1" }));
  const getLotImage = vi.fn((_request: { lotId: string }) => image());
  const getLotPhoto = vi.fn(
    async (request: { lotId: string; photoId: string }) => ({
      content: new Uint8Array([7]),
      version: `photo-${request.photoId}`,
    }),
  );
  const getRafflePrizePhoto = vi.fn(
    (_request: { auctionId: string }) =>
      options.prizePhoto?.() ?? Promise.reject(new Error("no prize photo")),
  );
  const listAuctionLots = vi.fn(async () => ({
    lots: [shownLot],
    nextPageToken: "",
  }));
  const getLot = vi.fn(async () => shownLot);
  // Лот сета ищется отдельно: второй лот набора виден по своему идентификатору
  // (ADR-073), а прочие лоты остаются прежними.
  const findLot = vi.fn(async (request: { lotId: string }) =>
    request.lotId === shownLot.lotId
      ? shownLot
      : options.otherLot !== undefined &&
          request.lotId === options.otherLot.lotId
        ? options.otherLot
        : shownLot,
  );
  // Снимок аукциона — один у корня (PER-605) и у строки аукциона на карточке
  // сходки (PER-594).
  const summaryOf = (id: string) => ({
    auctionId: id,
    stage: options.stage ?? ("scheduled" as const),
    opensAt: "2026-10-26T09:00:00Z",
    closesAt: "2026-10-29T18:00:00Z",
    final: true,
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    ...options.summary,
  });
  // Корень аукциона (PER-605): Auction отдаёт аукцион, который у сходки есть.
  const getAuction = vi.fn(async (request: { auctionId: string }) =>
    [...auctions.values()].includes(request.auctionId)
      ? summaryOf(request.auctionId)
      : undefined,
  );
  const port: MeetupAuctions & AuctionScreens = {
    soldLots: async () => ({ kind: "ok", sold: 0 }),
    async getMeetupAuction(_person, id) {
      lookups.push(id);
      if (options.lookup !== undefined) return options.lookup();
      const found = auctions.get(id);
      return found === undefined
        ? { kind: "ok" }
        : { kind: "ok", auction: summaryOf(found) };
    },
    async enableAuction(_person, id, opId) {
      opIds.push(opId);
      if (options.enable !== undefined) return options.enable();
      const alreadyExisted = auctions.has(id);
      auctions.set(id, auctionId);
      return { kind: "enabled", auctionId, alreadyExisted };
    },
    currentAuction: async () => options.current?.() ?? { kind: "ok" },
    screenPorts(): AuctionScreenPorts {
      return {
        auction: {
          getLot,
          findLot: findLot,
          listAuctionLots,
          // Ставка соперника и ответ прокси лидера одной командой: момент один.
          listLotHistory: async () => ({
            entries: [
              {
                kind: "bid" as const,
                sequence: 4,
                occurredAt: "2026-10-03T16:04:00Z",
                bidId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
                participantId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402",
                amount: { minorUnits: 150_000, currency: "RUB" },
                origin: { kind: "manual" as const, source: "bot" as const },
              },
              {
                kind: "bid" as const,
                sequence: 6,
                occurredAt: "2026-10-03T16:04:00Z",
                bidId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3403",
                participantId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3404",
                amount: { minorUnits: 160_000, currency: "RUB" },
                origin: { kind: "proxy" as const },
              },
            ],
            nextPageToken: "",
          }),
          getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
          getDisplayNames: async (request) => {
            const names = options.names ?? {};
            return Object.fromEntries(
              request.participantIds
                .filter((id) => names[id] !== undefined)
                .map((id) => [id, names[id] as string]),
            );
          },
          placeBid: async () => ({ kind: "accepted", lotVersion: 0 }),
          setProxyLimit: async () => ({ kind: "accepted", lotVersion: 0 }),
          chooseDisplayName: async () => {
            const refusal = options.nameless?.aliasRefusal;
            if (refusal !== undefined) return { kind: "refused", refusal };
            named = true;
            return { kind: "accepted", name: "@owl" };
          },
          getAuction,
          getRaffle: async () => {
            if (options.raffleFails === true) {
              throw new Error("auction unavailable");
            }
            return raffle.current;
          },
          registerForRaffle: async () => {
            if (raffle.current === undefined) throw new Error("no raffle");
            if (!named) {
              return { kind: "refused", refusal: "display-name-not-chosen" };
            }
            raffle.current = { ...raffle.current, registered: true };
            return { kind: "accepted", raffle: raffle.current };
          },
          cancelRaffleRegistration: async () => {
            throw new Error("not used");
          },
          listMyInvoices: async () => invoices.current,
          chooseFulfillment: async (request) => {
            invoices.current = {
              ...invoices.current,
              invoices: invoices.current.invoices.map((invoice) =>
                invoice.invoiceId === request.invoiceId
                  ? { ...invoice, fulfillment: request.method }
                  : invoice,
              ),
            };
            return { kind: "accepted" as const };
          },
          getMyPredictions: async () => options.predictions ?? [],
          getPredictionResults: async () => ({ kind: "after-final" as const }),
          getDayChronicle: async () => {
            if (options.chronicle === undefined) throw new Error("not used");
            return options.chronicle;
          },
          getAuctionChronicle: async () => {
            if (options.auctionChronicle === undefined) {
              throw new Error("not used");
            }
            if (options.auctionChronicle === "down") {
              throw new ConnectError("down", Code.Unavailable);
            }
            return options.auctionChronicle;
          },
          submitPrediction: async () => {
            throw new Error("not used");
          },
        },
        operations: {
          newOperationId: () => "0198f2a4-7c1e-7d3a-9b21-00000000c001",
        },
        image: {
          getLotImage: async (request) => ({
            ...(await getLotImage(request)),
            mediaType: "image/jpeg",
          }),
          getLotPhoto: async (request) => ({
            ...(await getLotPhoto(request)),
            mediaType: "image/jpeg",
          }),
          getRafflePrizePhoto: async (request) => ({
            ...(await getRafflePrizePhoto(request)),
            mediaType: "image/jpeg",
          }),
        },
      };
    },
  };
  return {
    port,
    auctions,
    opIds,
    lookups,
    getLotImage,
    getLotPhoto,
    getRafflePrizePhoto,
    listAuctionLots,
    getLot,
    getAuction,
    raffle,
  };
}

function harness(
  holder: Holder,
  auction: ReturnType<typeof fakeAuction>,
  options: Omit<HarnessOptions, "auction"> & {
    blocked?: boolean;
    rights?: readonly AccessRight[];
    snapshot?: MeetupSnapshot;
    meetupsDown?: boolean;
    presentation?: "rich" | "plain";
    account?: ParticipantUsernameResult;
  } = {},
) {
  const {
    blocked,
    rights,
    snapshot,
    meetupsDown,
    presentation,
    account,
    ...rest
  } = options;
  return createHarness(
    identity(holder, blocked, rights, account),
    createDispatcher(
      fakeMeetups(snapshot, meetupsDown),
      undefined,
      undefined,
      auction.port,
    ),
    [],
    undefined,
    presentation,
    undefined,
    { auction: auction.port, ...rest },
  );
}

function press(data: string, message: Record<string, unknown> = {}): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: 42, is_bot: false, first_name: "tester" },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        text: "Лоты",
        ...message,
      },
    } as never,
  };
}

type Shown = {
  text?: string;
  rich_message?: {
    html?: string;
    media?: { id: string; media: { type: string; media: unknown } }[];
  };
  reply_markup?: {
    inline_keyboard: { text: string; callback_data?: string }[][];
  };
};

function screens(calls: readonly RecordedCall[]): Shown[] {
  return calls
    .filter((call) =>
      ["editMessageText", "sendMessage", "sendRichMessage"].includes(
        call.method,
      ),
    )
    .map((call) => call.payload as Shown);
}

function lastScreen(calls: readonly RecordedCall[]): Shown {
  const shown = screens(calls).at(-1);
  if (shown === undefined) throw new Error("no screen was shown");
  return shown;
}

function labels(shown: Shown): string[][] {
  return (shown.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => button.text),
  );
}

function data(shown: Shown, text: string): string | undefined {
  return shown.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.text === text)?.callback_data;
}

const extensionsData = `v1:ext:${meetupToken}`;
const rootData = encodeAuctionCallback({ kind: "root", auctionId });

describe("meetup card extensions entry", () => {
  it("puts one extensions entry next to the materials and names the auction stage in a line", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      snapshot: meetup(2),
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const card = lastScreen(calls);
    expect(labels(card)).toContainEqual(["📎 Материалы (2)", "🧩 Расширения"]);
    expect(data(card, "🧩 Расширения")).toBe(extensionsData);
    expect(JSON.stringify(labels(card))).not.toContain("Лоты");
    expect(JSON.stringify(card)).not.toContain("🛠 Включить аукцион");
    // Кнопка без состояния, а состояние аукциона — строка текста (PER-594):
    // карточка читает аукцион один раз.
    expect(card.rich_message?.html ?? card.text).toContain(
      "🏷️ Аукцион: скоро старт",
    );
    expect(auction.lookups).toEqual([meetupId]);
  });

  // Строка аукциона — блок после «Когда» и «Где» (PER-594): у онлайн-торгов
  // со сроком — и срок в поясе сообщества.
  it.each([
    [
      "prebidding",
      {
        auctionId,
        stage: "prebidding" as const,
        closesAt: "2026-10-29T18:00:00Z",
        final: false,
      },
      /\n\n🏷️ Аукцион: идут онлайн-торги до 29 октября( 2026)?, чт, \d\d:00\n\n/,
    ],
    [
      "finished",
      { auctionId, stage: "finished" as const, final: false },
      /\n\n🏷️ Аукцион: завершён\n\n/,
    ],
  ])("names the %s auction on the meetup card", async (_, summary, line) => {
    const auction = fakeAuction({
      lookup: () => ({ kind: "ok", auction: summary }),
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const text = lastScreen(calls).text ?? "";
    expect(text).toMatch(line);
    // Блок стоит после «Когда» и «Где» и перед описанием.
    expect(text.indexOf("📍 Где:")).toBeLessThan(text.indexOf("Аукцион:"));
    expect(text.indexOf("Аукцион:")).toBeLessThan(
      text.indexOf("Описание пока не добавлено."),
    );
  });

  it("leaves the auction line out without an auction at the meetup", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    expect(lastScreen(calls).text).not.toContain("Аукцион:");
  });

  it("keeps the card and its extensions entry when Auction does not answer", async () => {
    const auction = fakeAuction({
      lookup: () => ({ kind: "unavailable", cause: new Error("down") }),
    });
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const card = lastScreen(calls);
    expect(card.rich_message?.html ?? card.text).toContain("Ярмарка");
    // Карточка верна, но для записи границы это сбой соседа: иначе его не
    // отличить от сходки без аукциона (PER-594).
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "dependency_unavailable",
      error: "auction_unavailable",
    });
    // Сбой Auction убирает только строку аукциона (PER-594).
    expect(card.rich_message?.html ?? card.text).not.toContain("Аукцион:");
    expect(labels(card)).toContainEqual(["📎 Материалы (0)", "🧩 Расширения"]);
    // Пять рядов организатора не превышены: расширения — в ряду материалов.
    expect(card.reply_markup?.inline_keyboard.length).toBeLessThanOrEqual(5);
  });

  it("does not call Auction for a person without the hub right", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("guest", auction, {
      rights: ["place-bids"],
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    expect(auction.lookups).toEqual([]);
    expect(auction.getAuction).not.toHaveBeenCalled();
    // Приветствие с кнопкой заявки (PER-592), а не экран аукциона.
    expect(lastScreen(calls).text).toContain("Чтобы войти, подай заявку.");
  });

  it("does not call Auction for a blocked person", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot } = harness("member", auction, { blocked: true });
    await bot.init();
    await bot.handleUpdate(press(rootData));

    expect(auction.getAuction).not.toHaveBeenCalled();
  });
});

describe("meetup extensions menu", () => {
  it("opens the auction root of an enabled auction", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(extensionsData));

    const menu = lastScreen(calls);
    expect(menu.text).toMatch(/^<b>Расширения<\/b>\n<i>Ярмарка<\/i>\n\n/);
    expect(menu.text).toContain("<i>Ярмарка</i>");
    expect(labels(menu)).toEqual([["🏷️ Аукцион"], ["‹ Сходка"]]);
    expect(data(menu, "🏷️ Аукцион")).toBe(rootData);
    expect(data(menu, "‹ Сходка")).toBe(`v1:view:${meetupToken}`);
  });

  it("offers enabling to the administrator of a meetup without an auction", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(extensionsData));

    const menu = lastScreen(calls);
    expect(labels(menu)).toEqual([["🛠 Включить аукцион"], ["‹ Сходка"]]);
    expect(data(menu, "🛠 Включить аукцион")).toBe(
      `v1:manage:auction:${meetupToken}`,
    );
  });

  // Включение — право вести аукцион (ADR-070, PER-654), а не вести сходки:
  // помощник с одной записью run_auctions его видит, держатель одного права
  // вести сходки — нет, и его подделанная кнопка не доходит до Auction.
  it("offers enabling to a holder of the right to run auctions alone", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("member", auction, {
      rights: ["access-hub", "place-bids", "run-auctions"],
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));

    expect(labels(lastScreen(calls))).toEqual([
      ["🛠 Включить аукцион"],
      ["‹ Сходка"],
    ]);
  });

  it("refuses enabling to a holder of the right to manage meetups alone before Auction", async () => {
    const auction = fakeAuction();
    const { bot, calls, records } = harness("member", auction, {
      rights: ["access-hub", "place-bids", "manage-meetups"],
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    expect(JSON.stringify(lastScreen(calls))).not.toContain(
      "🛠 Включить аукцион",
    );

    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const frame = lastScreen(calls);
    expect(frame.text).toContain("Это действие тебе недоступно.");
    expect(data(frame, "‹ Расширения")).toBe(extensionsData);
    expect(auction.opIds).toEqual([]);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
      use_case: "enable_auction",
    });
  });

  it("tells a member that the meetup has no extensions", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(extensionsData));

    const menu = lastScreen(calls);
    expect(menu.text).toContain("У этой сходки пока нет расширений.");
    expect(labels(menu)).toEqual([["‹ Сходка"]]);
  });

  it("offers no enabling at a cancelled meetup", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction, {
      snapshot: { ...meetup(), lifecycle: "cancelled" },
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));

    const menu = lastScreen(calls);
    expect(menu.text).toContain("У этой сходки пока нет расширений.");
    expect(JSON.stringify(menu)).not.toContain("🛠 Включить аукцион");
  });

  it("names an Auction outage with a retry instead of guessing the auction", async () => {
    const auction = fakeAuction({
      lookup: () => ({ kind: "unavailable", cause: new Error("down") }),
    });
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(extensionsData));

    const menu = lastScreen(calls);
    expect(menu.text).toContain("Аукцион сейчас не отвечает.");
    expect(labels(menu)).toEqual([["Повторить"], ["‹ Сходка"]]);
    expect(data(menu, "Повторить")).toBe(extensionsData);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "dependency_unavailable",
      error: "auction_unavailable",
    });
  });
});

describe("enabling the auction", () => {
  it("enables the auction and shows the outcome with the auction root behind it", async () => {
    const auction = fakeAuction();
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const outcome = lastScreen(calls);
    expect(outcome.text).toContain("<b>Аукцион включён</b>");
    // Первый шаг после включения — лот (прогон 12.10, №16).
    expect(labels(outcome)).toEqual([
      ["🛠 Добавить лот"],
      ["🏷️ Аукцион"],
      ["‹ Расширения"],
    ]);
    expect(data(outcome, "🛠 Добавить лот")).toMatch(/^v1:lot:new:[\w-]+$/);
    expect(data(outcome, "🏷️ Аукцион")).toBe(rootData);
    expect(data(outcome, "‹ Расширения")).toBe(extensionsData);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "ok",
      use_case: "enable_auction",
    });
    await bot.handleUpdate(press(rootData));
    expect(lastScreen(calls).text).toMatch(/^<b>Аукцион<\/b>/);
  });

  it("does not birth a second auction on a repeated press", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    expect(auction.auctions.size).toBe(1);
    // Ключ команды рождается на нажатие, а аукцион один.
    expect(new Set(auction.opIds).size).toBe(2);
    expect(lastScreen(calls).text).toContain(
      "<b>Аукцион у этой сходки уже включён</b>",
    );
  });

  it("answers a refusal of the meetup administrator right with a frame back to the extensions", async () => {
    const auction = fakeAuction({
      enable: () => ({ kind: "not-administrator" }),
    });
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const frame = lastScreen(calls);
    expect(frame.text).toContain("Это действие тебе недоступно.");
    expect(data(frame, "‹ Расширения")).toBe(extensionsData);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
    });
  });

  it("offers a retry when Auction is unavailable", async () => {
    const auction = fakeAuction({
      enable: () => ({ kind: "unavailable", cause: new Error("down") }),
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    expect(data(lastScreen(calls), "Повторить")).toBe(
      `v1:manage:auction:${meetupToken}`,
    );
  });
});

describe("auction root and the way back", () => {
  // PER-725: участник открывает «Хроники дня» из корня онлайн-недели и видит
  // номинации суток — без разделов, ссылок и кнопок сводки дня пульта.
  it("opens the day chronicle of the online week without the console", async () => {
    const auction = fakeAuction({
      existing: true,
      stage: "prebidding",
      chronicle: {
        lots: [
          {
            lotId: lot.lotId,
            bidCount: 4,
            leaderChanges: 5,
            longestDuel: 4,
            totalBidCount: 6,
            priceGrowth: { minorUnits: 15_000, currency: "RUB" },
          },
        ],
      },
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(labels(root)).toContainEqual(["Хроники дня", "Статистика"]);
    await bot.handleUpdate(press(data(root, "Хроники дня") ?? ""));
    const chronicle = lastScreen(calls);
    expect(chronicle.text).toContain("Хроники дня");
    expect(chronicle.text).toContain("Спорнее всех:");
    expect(chronicle.text).toContain("5 смен лидера");
    expect(chronicle.text).toContain("Тёмная лошадка:");
    expect(chronicle.text).toContain("Эпичная дуэль:");
    expect(chronicle.text).toContain("4 перебивания подряд вдвоём");
    // Только у сводки дня пульта: максимумы цены, рост за сутки, ссылки на
    // лоты для пересылки и возврат в пульт.
    expect(chronicle.text).not.toContain("Новые максимумы цены");
    expect(chronicle.text).not.toContain("Больше всех выросла цена");
    expect(chronicle.text).not.toContain("t.me/");
    expect(labels(chronicle).flat()).not.toContain("‹ Пульт");
    expect(labels(chronicle).flat()).toContain("‹ Аукцион");
  });

  // PER-770: участник открывает «Статистику» из корня и после торгов —
  // счётчики, рекорд роста и номинации за весь аукцион, без людей и ников.
  it("opens the statistics of the whole auction and returns to the root", async () => {
    const auction = fakeAuction({
      existing: true,
      stage: "finished",
      auctionChronicle: {
        bidCount: 42,
        participantCount: 12,
        tradedLotCount: 1,
        growthRecord: {
          lotId: lot.lotId,
          growth: { minorUnits: 30_000, currency: "RUB" },
        },
        lots: [
          {
            lotId: lot.lotId,
            bidCount: 42,
            leaderChanges: 7,
            longestDuel: 5,
          },
        ],
      },
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(labels(root)).toContainEqual(["Статистика"]);
    expect(labels(root).flat()).not.toContain("Хроники дня");
    await bot.handleUpdate(press(data(root, "Статистика") ?? ""));
    const statistics = lastScreen(calls);
    expect(statistics.text).toContain("Статистика аукциона");
    expect(statistics.text).toContain("42 ставки");
    expect(statistics.text).toContain("12 участников");
    expect(statistics.text).toContain("1 из 1 лота со ставками");
    expect(statistics.text).toContain("Рекорд роста:");
    expect(statistics.text).toContain("7 смен лидера");
    expect(statistics.text).toContain("5 перебиваний подряд вдвоём");
    expect(statistics.text).not.toContain("Тёмная лошадка:");
    expect(statistics.text).not.toContain("@");
    expect(statistics.text).not.toContain("t.me/");
    await bot.handleUpdate(press(data(statistics, "‹ Аукцион") ?? ""));
    expect(labels(lastScreen(calls))).toContainEqual(["Статистика"]);
  });

  it("offers a retry when Auction does not answer the statistics", async () => {
    const auction = fakeAuction({
      existing: true,
      stage: "prebidding",
      auctionChronicle: "down",
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));
    const statisticsData = data(lastScreen(calls), "Статистика") ?? "";
    await bot.handleUpdate(press(statisticsData));

    expect(data(lastScreen(calls), "Повторить")).toBe(statisticsData);
    await bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(calls))).toContainEqual([
      "Хроники дня",
      "Статистика",
    ]);
  });

  it("offers no day chronicle before the online week", async () => {
    const auction = fakeAuction({ existing: true, stage: "scheduled" });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    expect(labels(lastScreen(calls)).flat()).not.toContain("Хроники дня");
    expect(labels(lastScreen(calls)).flat()).not.toContain("Статистика");
  });

  it("opens prediction results from a finished auction", async () => {
    const auction = fakeAuction({ existing: true, stage: "finished" });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(labels(root)).toContainEqual(["Итоги"]);
    await bot.handleUpdate(press(data(root, "Итоги") ?? ""));
    expect(lastScreen(calls).text).toContain("Итоги после финала.");
  });

  // Программа недели (PER-724): абзац под сроками, текст общий с ботом
  // аукциона.
  it("shows the week programme under the dates while the online week runs", async () => {
    const inHours = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    const auction = fakeAuction({
      existing: true,
      stage: "prebidding",
      summary: {
        closesAt: inHours(96),
        finalAt: inHours(100),
        stepWindows: [
          { from: inHours(-1), until: inHours(1), lotIds: ["a", "b"] },
        ],
      },
      raffle: {
        auctionId,
        status: "open",
        closesAt: inHours(50),
        commitment: "ab".repeat(32),
        beaconRound: 12_345_678,
        registered: false,
        tickets: [],
      },
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(root.text).toContain("<b>Программа недели</b>");
    expect(root.text).toMatch(
      /Счастливые часы: сейчас, до (?:.+, )?\d\d:\d\d — 2 лота/,
    );
    expect(root.text).toContain("Розыгрыш: ");
    expect(root.text).toContain("Онлайн-торги до ");
    expect(root.text).toContain("Финал: ориентировочно ");
  });

  it("keeps the root and the programme without the raffle when its read fails", async () => {
    const auction = fakeAuction({
      existing: true,
      stage: "prebidding",
      summary: { closesAt: "2999-10-29T18:00:00Z" },
      raffleFails: true,
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(root.text).toContain("<b>Программа недели</b>");
    expect(root.text).toContain("Онлайн-торги до ");
    expect(root.text).not.toContain("Розыгрыш");
    expect(labels(root).flat()).not.toContain("Розыгрыш");
  });

  it("names an auction hidden from participants in its status", async () => {
    const auction = fakeAuction({ existing: true, hidden: true });
    const { bot, calls } = harness("admin", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    expect(lastScreen(calls).text).toContain(
      "Статус: <b>скоро старт, скрыт от участников</b>",
    );
  });

  it("walks extensions, auction, lots and a lot, and returns the same way", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(root.text).toMatch(/^<b>Аукцион<\/b>/);
    expect(root.text).toContain("Статус: <b>скоро старт</b>");
    expect(root.text).toContain("📅 Когда: онлайн-торги с ");
    expect(root.text).toContain("Финал: в зале");
    expect(labels(root)).toEqual([
      ["🏷️ Лоты"],
      ["Правила и FAQ"],
      ["‹ Расширения"],
    ]);
    expect(data(root, "‹ Расширения")).toBe(extensionsData);
    expect(root.text).not.toContain("скрыт от участников");

    await bot.handleUpdate(press(data(root, "🏷️ Лоты") ?? ""));
    const feed = lastScreen(calls);
    expect(feed.text).toMatch(/^<b>Лоты<\/b>/);
    // Лента — просто список лотов: входов корня в ней нет.
    expect(JSON.stringify(labels(feed))).not.toContain("Правила и FAQ");
    expect(labels(feed).at(-1)).toEqual(["‹ Аукцион"]);
    expect(data(feed, "‹ Аукцион")).toBe(rootData);

    await bot.handleUpdate(press(lotData));
    const card = lastScreen(calls);
    expect(labels(card).at(-1)).toEqual(["‹ Лоты"]);
    await bot.handleUpdate(press(data(card, "‹ Лоты") ?? ""));
    expect(data(lastScreen(calls), "‹ Аукцион")).toBe(rootData);
  });

  // Сет лотов (ADR-073, п. 7): карточка лота сета ведёт к экрану сета, тот
  // перечисляет лоты сета и возвращает карточку.
  it("opens the screen of the set from the card of its lot", async () => {
    const otherLotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
    const otherLot: LotView = {
      lotId: otherLotId,
      auctionId,
      version: 1,
      card: { title: "Плакат", description: "" },
      proxyEnabled: false,
      status: { kind: "unsold" },
    };
    const setLot: LotView = {
      ...lot,
      lotSet: {
        name: "Лесные дары",
        lotIds: [lotId, otherLotId],
        collectorName: "@owl",
      },
    };
    const auction = fakeAuction({
      existing: true,
      lot: setLot,
      otherLot,
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.text).toContain("Сет: «Лесные дары»");
    expect(card.text).toContain("Сет «Лесные дары» собрал @owl");
    expect(labels(card)).toContainEqual(["Лоты сета"]);

    await bot.handleUpdate(press(data(card, "Лоты сета") ?? ""));
    const set = lastScreen(calls);
    expect(set.text).toContain("<i>Лесные дары</i>");
    // Intl разделяет разряды неразрывным пробелом — тест читает его обычным.
    const setText = (set.text ?? "").replace(/\s/g, " ");
    expect(setText).toContain("• Кружка с совой — старт 500 ₽");
    expect(setText).toContain("• Плакат — не продан");
    expect(labels(set).at(-1)).toEqual(["‹ Лот"]);
  });

  it("gives the administrator the console in the root and keeps adding lots in the list", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("admin", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(calls))).toEqual([
      ["🏷️ Лоты"],
      ["Правила и FAQ"],
      // Единственный вход управления в корне (PER-802).
      ["🛠 Пульт"],
      ["‹ Сходки"],
    ]);
    await bot.handleUpdate(press(feedData));
    expect(labels(lastScreen(calls))[0]).toEqual(["🛠 Добавить лот"]);
  });

  it("returns from the root to the upcoming list when the process no longer knows the meetup", async () => {
    const auction = fakeAuction({ existing: true });
    // Рестарт: память процесса пуста, а кнопка корня осталась в чате.
    const { bot, calls } = harness("member", auction, {
      auctionParents: createAuctionParents(),
    });
    await bot.init();
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(labels(root).at(-1)).toEqual(["‹ Сходки"]);
    expect(data(root, "‹ Сходки")).toBe("v1:nav:hub");
  });

  it("remembers the meetup from enabling, not only from the menu", async () => {
    const auction = fakeAuction();
    const parents = createAuctionParents();
    const { bot } = harness("admin", auction, { auctionParents: parents });
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    expect(parents.meetupOf(auctionId)).toBe(meetupId);
  });

  it("offers a retry when Auction does not answer the root", async () => {
    const auction = fakeAuction({ existing: true });
    auction.getAuction.mockRejectedValue(
      new ConnectError("down", Code.Unavailable),
    );
    const { bot, calls, records } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(rootData));

    expect(data(lastScreen(calls), "Повторить")).toBe(rootData);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      use_case: "view_auction",
      error_category: "dependency_unavailable",
    });
  });

  // Чтение Auction могло ещё не увидеть только что включённый аукцион:
  // кадр предлагает повтор, а не тупик.
  it("offers a retry when Auction does not give the auction yet", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(rootData));

    const root = lastScreen(calls);
    expect(root.text).toContain("Аукцион не найден.");
    expect(labels(root)).toEqual([["Повторить"], ["‹ Сходки"]]);
    expect(data(root, "Повторить")).toBe(rootData);
  });

  it("shows the bids of a lot in journal order and returns to the lot", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({
          kind: "history",
          lotId,
          page: 0,
          historyPage: 999,
        }),
      ),
    );
    const history = lastScreen(calls);
    expect(history.text).toMatch(/^<b>Ставки<\/b>/);
    const lines = (history.text ?? "")
      .split("\n")
      .filter((line) => line.includes("₽"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/1\s500\s₽ · вручную$/);
    expect(lines[1]).toMatch(/1\s600\s₽ · авто$/);
    expect(labels(history).at(-1)).toEqual(["‹ Лот"]);
    expect(data(history, "‹ Лот")).toBe(lotData);
  });

  it("offers a retry when Auction does not answer the feed", async () => {
    const auction = fakeAuction({ existing: true });
    auction.listAuctionLots.mockRejectedValue(
      new ConnectError("down", Code.Unavailable),
    );
    const { bot, calls, records } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));

    expect(data(lastScreen(calls), "Повторить")).toBe(feedData);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      use_case: "view_auction",
      error_category: "dependency_unavailable",
    });
  });
});

// Избранное (PER-495): участник отмечает лоты в боте хаба — у человека одна
// отметка в Notifications, в каком бы боте он ни торговал.
describe("favorite lots in the hub", () => {
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

  it("marks a lot from its card and lists it from the auction root with the way back to the root", async () => {
    const favorites = notificationsFavorites();
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
      favorites: () => favorites.port,
    });
    await bot.init();
    await bot.handleUpdate(press(rootData));
    const root = lastScreen(calls);
    expect(labels(root)[1]).toEqual(["Избранное", "Правила и FAQ"]);

    await bot.handleUpdate(press(lotData));
    const follow = data(lastScreen(calls), "Добавить в избранное");
    if (follow === undefined) throw new Error("no follow button on the card");
    await bot.handleUpdate(press(follow));
    expect(favorites.marks).toEqual([lotId]);
    expect(data(lastScreen(calls), "Убрать из избранного")).toBeDefined();

    const open = data(root, "Избранное");
    if (open === undefined) throw new Error("no favorites in the auction root");
    await bot.handleUpdate(press(open));
    const list = lastScreen(calls);
    expect(list.text).toMatch(/^<b>Избранное<\/b>/);
    expect(labels(list).at(-1)).toEqual(["‹ Аукцион"]);
    expect(data(list, "‹ Аукцион")).toBe(rootData);
  });

  it("keeps the root and the card without favorites when Notifications is not configured", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(calls))[1]).toEqual(["Правила и FAQ"]);
    await bot.handleUpdate(press(lotData));
    expect(JSON.stringify(labels(lastScreen(calls)))).not.toContain(
      "Добавить в избранное",
    );
  });
});

describe("lot photo delivery", () => {
  const richLot = (fileId: string) => ({
    message_id: 9,
    date: 0,
    chat: { id: 42, type: "private", first_name: "tester" },
    rich_message: {
      blocks: [
        {
          type: "photo",
          photo: [
            { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
            { file_id: fileId, file_unique_id: "l", width: 800, height: 800 },
          ],
        },
      ],
    },
  });

  it("uploads the photo into the rich card and reuses its file_id", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    const { bot, calls } = harness("member", auction, {
      lotPhotos: photos,
      respond: (method) =>
        method === "editMessageText" ? richLot("big-file") : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    // Фото — первым блоком, над заголовком (решение владельца 10 октября 2026).
    expect(card.rich_message?.html).toMatch(
      /^<img src="tg:\/\/photo\?id=lot"\/><h1>/,
    );
    expect(card.rich_message?.media?.[0]?.media.media).toBeInstanceOf(
      InputFile,
    );
    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "file",
      fileId: "big-file",
    });

    await bot.handleUpdate(press(lotData));
    expect(auction.getLotImage).toHaveBeenCalledTimes(1);
    expect(lastScreen(calls).rich_message?.media?.[0]?.media.media).toBe(
      "big-file",
    );
  });

  // Несколько фото лота (PER-721): карусель, как у постеров карточки сходки,
  // фото — своим `GetLotPhoto` каждое, `file_id` — по каждому.
  it("shows the photos of a lot as a carousel and reuses the file_id of each", async () => {
    const auction = fakeAuction({
      existing: true,
      lot: {
        ...lot,
        card: {
          title: "Кружка с совой",
          description: "Ручная роспись.",
          image: { version: "photo-p1" },
          photos: [
            { photoId: "p1", version: "photo-p1" },
            { photoId: "p2", version: "photo-p2" },
          ],
        },
      },
    });
    const photos = createLotPhotos();
    const { bot, calls } = harness("member", auction, {
      lotPhotos: photos,
      respond: (method) =>
        method === "editMessageText"
          ? {
              ...richLot("first-file"),
              rich_message: {
                blocks: [
                  {
                    type: "slideshow",
                    blocks: [
                      ...richLot("first-file").rich_message.blocks,
                      ...richLot("second-file").rich_message.blocks,
                    ],
                  },
                ],
              },
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.rich_message?.html).toMatch(
      /^<tg-slideshow><img src="tg:\/\/photo\?id=lot"\/><img src="tg:\/\/photo\?id=lot2"\/><\/tg-slideshow><h1>/,
    );
    expect(auction.getLotPhoto).toHaveBeenCalledTimes(2);
    expect(auction.getLotImage).not.toHaveBeenCalled();
    expect(photos.get({ lotId, version: "photo-p2" })).toEqual({
      kind: "file",
      fileId: "second-file",
    });

    await bot.handleUpdate(press(lotData));
    expect(auction.getLotPhoto).toHaveBeenCalledTimes(2);
    expect(
      lastScreen(calls).rich_message?.media?.map((photo) => photo.media.media),
    ).toEqual(["first-file", "second-file"]);
  });

  it("sends the card without a photo when Auction does not give the image", async () => {
    const auction = fakeAuction({
      existing: true,
      image: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    const { bot, calls, records } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.rich_message?.html).toContain("<h1>Кружка с совой</h1>");
    expect(card.rich_message?.media).toBeUndefined();
    expect(
      records.some((record) => record.message === "lot image unavailable"),
    ).toBe(true);
  });

  it("edits the card without a photo when Telegram refuses the upload and skips it next time", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    const { bot, calls } = harness("member", auction, {
      lotPhotos: photos,
      respond: (method, payload) =>
        method === "editMessageText" &&
        (payload as Shown).rich_message?.media !== undefined
          ? {
              ok: false,
              error_code: 400,
              description: "Bad Request: IMAGE_PROCESS_FAILED",
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.rich_message?.html).toContain("<h1>Кружка с совой</h1>");
    expect(card.rich_message?.media).toBeUndefined();
    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "rejected",
    });

    await bot.handleUpdate(press(lotData));
    expect(auction.getLotImage).toHaveBeenCalledTimes(1);
  });

  it("shows the lot card as an HTML message without a photo in plain presentation", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.text).toMatch(/^<b>Кружка с совой<\/b>/);
    expect(card.rich_message).toBeUndefined();
    expect(auction.getLotImage).not.toHaveBeenCalled();
  });
});

describe("review findings", () => {
  // Включение не читает сходку заново (PER-605): исход называет аукцион и
  // ведёт в его корень, даже когда Meetups лежит.
  it("reports an enabled auction when Meetups does not answer", async () => {
    const auction = fakeAuction();
    const parents = createAuctionParents();
    const { bot, calls, records } = harness("admin", auction, {
      meetupsDown: true,
      auctionParents: parents,
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const frame = lastScreen(calls);
    expect(frame.text).toContain("<b>Аукцион включён</b>");
    expect(data(frame, "‹ Расширения")).toBe(`v1:ext:${meetupToken}`);
    expect(JSON.stringify(frame)).not.toContain("Повторить");
    expect(parents.meetupOf(auctionId)).toBe(meetupId);
    expect(records.at(-1)?.fields).toMatchObject({ result: "ok" });
  });

  it("leaves a hub button without a version to the hub parser", () => {
    expect(isAuctionCallback("manage:menu")).toBe(false);
    expect(isAuctionCallback("v1:nav:hub")).toBe(false);
    expect(isAuctionCallback(feedData)).toBe(true);
    expect(isAuctionCallback(`v1:t:${lotData.slice("v1:".length)}`)).toBe(true);
    // Своя кнопка, даже нечитаемая, остаётся аукционной.
    expect(isAuctionCallback("v9:auc:feed:broken")).toBe(true);
  });

  it("opens a traced auction callback from a notification as a new screen", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:t:${lotData.slice("v1:".length)}`));

    expect(auction.getLot).toHaveBeenCalledOnce();
    expect(lastScreen(calls).rich_message?.html).toContain("Кружка с совой");
    expect(calls.some((call) => call.method === "sendRichMessage")).toBe(true);
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
  });

  it("shows the blocking frame, not an outage, when Auction is not configured", async () => {
    const { bot, calls } = createHarness(
      identity("member", true),
      createDispatcher(fakeMeetups()),
    );
    await bot.init();
    await bot.handleUpdate(press(feedData));

    expect(lastScreen(calls).text).toContain("Доступ к Solguficky Hub закрыт");
  });

  it("names a missing lot, but treats a failing feed as an outage", async () => {
    const auction = fakeAuction({ existing: true });
    auction.getLot.mockRejectedValue(new ConnectError("no", Code.NotFound));
    auction.listAuctionLots.mockRejectedValue(
      new ConnectError("no", Code.NotFound),
    );
    const { bot, calls } = harness("member", auction);
    await bot.init();

    await bot.handleUpdate(press(lotData));
    expect(lastScreen(calls).text).toContain("Лот не найден");
    await bot.handleUpdate(press(setData));
    expect(lastScreen(calls).text).toContain("Лот не найден");
    expect(data(lastScreen(calls), "Повторить")).toBeUndefined();
    await bot.handleUpdate(press(feedData));
    expect(lastScreen(calls).text).not.toContain("Лот не найден");
    expect(data(lastScreen(calls), "Повторить")).toBe(feedData);
  });

  it("does not mark the photo rejected on a transient Telegram failure", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    const { bot } = harness("member", auction, {
      lotPhotos: photos,
      respond: (method, payload) =>
        method === "editMessageText" &&
        (payload as Shown).rich_message?.media !== undefined
          ? {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 1",
              parameters: { retry_after: 1 },
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(photos.get({ lotId, version: "img-1" })).toBeUndefined();
  });

  it("keeps a working file_id when only the message cannot be edited", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    photos.set({ lotId, version: "img-1" }, { kind: "file", fileId: "big" });
    const { bot, calls } = harness("member", auction, {
      lotPhotos: photos,
      respond: (method) =>
        method === "editMessageText"
          ? {
              ok: false,
              error_code: 400,
              description: "Bad Request: message can't be edited",
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "file",
      fileId: "big",
    });
    expect(auction.getLotImage).not.toHaveBeenCalled();
    const sent = calls.filter((call) => call.method === "sendRichMessage");
    expect(
      (sent.at(-1)?.payload as Shown | undefined)?.rich_message?.media?.[0]
        ?.media.media,
    ).toBe("big");
  });
});

// Лист ставки (PER-317) в оболочке хаба: вопрос новым сообщением с режимом
// ответа, ответ reply-сообщением и «Отмена» по дизайн-коду, «Вопросы».
describe("bid leaf in the hub", () => {
  const trading: LotView = {
    ...lot,
    nextPrice: { minorUnits: 125_000, currency: "RUB" },
    proxyEnabled: true,
    status: {
      kind: "trading",
      currentPrice: { minorUnits: 120_000, currency: "RUB" },
      phase: "online",
    },
  };
  const step = encodeAuctionCallback({
    kind: "question",
    question: "bid",
    lotId,
    page: 0,
    addressee: 42,
  });
  const question = {
    message_id: 9,
    date: 0,
    chat: { id: 42, type: "private", first_name: "tester" },
    from: { id: 1, is_bot: true, first_name: "hub" },
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
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        reply_to_message: question,
        ...extra,
      },
    }) as Update;
  const setup = async () => {
    const auction = fakeAuction({ existing: true, lot: trading });
    const run = harness("member", auction, {
      presentation: "plain",
    });
    await run.bot.init();
    return run;
  };

  it("puts the bid rows on the card of a lot in online trading", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(press(lotData));
    const card = lastScreen(calls);
    // Своя сумма с автоставкой — парой (PER-594), «Ставки» — рядом, «Обновить»
    // — в ряду листания (PER-669).
    expect(labels(card).slice(0, 4)).toEqual([
      [expect.stringMatching(/^Первая ставка \(1\s250\s₽\)$/)],
      ["Своя сумма", "Автоставка"],
      ["Ставки"],
      ["🔄 Обновить"],
    ]);
  });

  // Карточка участника в онлайн-торгах с автоставкой и избранным — пять рядов
  // (PER-594, PER-669): ставка по шагу, своя сумма с автоставкой, «Ставки» с
  // избранным, листание с «Обновить» и возврат.
  it("fits the card of a participant with limits and favorites into five rows", async () => {
    const auction = fakeAuction({ existing: true, lot: trading });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
      favorites: () => ({
        listFollowedLots: async () => [],
        followLot: async () => ({ kind: "done", following: true }),
        unfollowLot: async () => ({ kind: "done", following: false }),
      }),
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(labels(lastScreen(calls))).toEqual([
      [expect.stringMatching(/^Первая ставка \(1\s250\s₽\)$/)],
      ["Своя сумма", "Автоставка"],
      ["Ставки", "Добавить в избранное"],
      ["🔄 Обновить"],
      ["‹ Лоты"],
    ]);
  });

  it("asks the amount in a new message with the reply mode", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({ kind: "ask", question: "bid", lotId, page: 0 }),
      ),
    );
    expect(calls.map((call) => call.method)).toContain(
      "editMessageReplyMarkup",
    );
    const asked = calls.find((call) => call.method === "sendMessage");
    expect(asked?.payload).toMatchObject({
      text: expect.stringContaining("Своя сумма"),
      reply_markup: {
        force_reply: true,
        inline_keyboard: [[{ text: "Отмена", callback_data: step }]],
      },
    });
  });

  // Пояснение видено (PER-517): вопрос лимита уходит в Telegram с «Как это
  // работает» над «Отменой», и линтер экранов проверяет его на отправке.
  it("asks the limit with how it works once the explainer was seen", async () => {
    const auction = fakeAuction({ existing: true, lot: trading });
    const marks: string[] = [];
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
      proxyExplainer: () => ({
        seen: async () => true,
        markSeen: async (viewer) => {
          marks.push(viewer.identityId);
        },
      }),
    });
    await bot.init();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({
          kind: "ask",
          question: "proxy",
          lotId,
          page: 0,
        }),
      ),
    );
    const asked = calls.find((call) => call.method === "sendMessage");
    expect(asked?.payload).toMatchObject({
      text: expect.not.stringContaining("Подсказка"),
      reply_markup: {
        force_reply: true,
        inline_keyboard: [[{ text: "Как это работает" }], [{ text: "Отмена" }]],
      },
    });
    expect(marks).toEqual([]);
  });

  // «Как это работает» (PER-517) задаёт вопрос лимита заново: нажатый вопрос
  // удаляется, как по «Отмене», а новый с пояснением приходит следом.
  it("replaces the limit question with an explained one on how it works", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "explain", lotId, page: 0 }), {
        text: "Автоставка",
      }),
    );
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

  it("confirms the typed amount and takes the cancel off the question", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(answer({ text: "1 300" }));
    const confirm = calls.find((call) => call.method === "sendMessage");
    expect(confirm?.payload).toMatchObject({
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
      payload: { message_id: 9 },
    });
  });

  // PER-473: принятая ставка — свой экран с «‹ Лот» и «‹ Лоты» (PER-595), а не
  // строка над карточкой с прежней ценой.
  it("answers an accepted bid with its own screen and the lot button", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({
          kind: "commit",
          command: "bid",
          lotId,
          opId: "0198f2a4-7c1e-7d3a-9b21-00000000c001",
          amount: 130_000,
          page: 0,
        }),
      ),
    );
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
  // заголовке, «Ввести заново» и «К лоту» вместо режима ответа.
  it.each([
    [{ text: "много" }, "Это не сумма"],
    [{ text: "$20" }, "Ставки принимаются только в рублях"],
    [{ sticker: { file_id: "s" } }, "Нужен ответ текстом"],
  ])(
    "answers a refused %j with its own screen and a retry",
    async (extra, reason) => {
      const { bot, calls } = await setup();
      await bot.handleUpdate(answer(extra));
      const sent = calls.find((call) => call.method === "sendMessage");
      const payload = sent?.payload as
        | {
            text?: string;
            reply_markup?: { inline_keyboard?: { text: string }[][] };
          }
        | undefined;
      expect(payload?.text?.startsWith(`<b>${reason}</b>`)).toBe(true);
      expect(
        payload?.reply_markup?.inline_keyboard?.map((row) =>
          row.map((button) => button.text),
        ),
      ).toEqual([["Ввести заново"], ["‹ Лот"]]);
    },
  );

  it("deletes the question on cancel and sends the card anew", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(press(step, question));
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("deleteMessage")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("deleteMessage")).toBeLessThan(
      methods.indexOf("sendMessage"),
    );
    expect(methods).not.toContain("editMessageText");
  });
});

describe("raffle among the participants", () => {
  const openRaffle: RaffleView = {
    auctionId,
    status: "open",
    closesAt: "2026-10-29T18:00:00Z",
    commitment: "ab".repeat(32),
    beaconRound: 12_345_678,
    registered: false,
    tickets: [],
  };

  // «🏷️ Лоты» — своим рядом, «Розыгрыш» и «Прогнозы» — парой под ним
  // (решение владельца по прогону stage 27.10, PER-798).
  it("puts the raffle and the predictions in one row under the lots", async () => {
    const predictions: readonly PredictionRoundView[] = [
      { round: "catalog", status: "open", answers: [] },
    ];
    const both = harness(
      "member",
      fakeAuction({ existing: true, raffle: openRaffle, predictions }),
    );
    await both.bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(both.calls)).slice(0, 2)).toEqual([
      ["🏷️ Лоты"],
      ["Розыгрыш", "Прогнозы"],
    ]);

    const predictionsOnly = harness(
      "member",
      fakeAuction({ existing: true, predictions }),
    );
    await predictionsOnly.bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(predictionsOnly.calls)).slice(0, 2)).toEqual([
      ["🏷️ Лоты"],
      ["Прогнозы"],
    ]);
  });

  it("registers from the auction root and shows the result with the recomputation", async () => {
    const auction = fakeAuction({ existing: true, raffle: openRaffle });
    // Пояс сообщества задан явно: момент жеребьёвки проверяется по нему (PER-641).
    const { bot, calls } = harness("member", auction, {
      communityTimeZone: "Europe/Moscow",
    });

    await bot.handleUpdate(press(rootData));
    // Без прогнозов «Розыгрыш» — своим рядом под «Лотами» (PER-798).
    expect(labels(lastScreen(calls)).slice(0, 2)).toEqual([
      ["🏷️ Лоты"],
      ["Розыгрыш"],
    ]);
    const raffleData = data(lastScreen(calls), "Розыгрыш");
    expect(raffleData).toBeDefined();
    await bot.handleUpdate(press(raffleData ?? ""));
    const before = lastScreen(calls);
    expect(before.text).toContain("<b>Розыгрыш среди участников</b>");
    expect(labels(before)).toEqual([
      ["Зарегистрироваться"],
      ["Как проверить честность"],
      ["‹ Аукцион"],
    ]);

    await bot.handleUpdate(press(data(before, "Зарегистрироваться") ?? ""));
    // Принятая регистрация — свой экран исхода (прогон 14.10, №69).
    const outcome = lastScreen(calls);
    expect(outcome.text).toContain("<b>Ты в розыгрыше</b>");
    expect(outcome.text).toContain(
      "Отменить регистрацию можно до её закрытия.",
    );
    expect(labels(outcome)).toEqual([
      ["Отменить регистрацию"],
      ["‹ Розыгрыш"],
      ["‹ Аукцион"],
    ]);

    await bot.handleUpdate(press(data(outcome, "‹ Розыгрыш") ?? ""));
    const registered = lastScreen(calls);
    expect(registered.text).toContain("Ты зарегистрирован.");
    // Техника — за кнопкой (PER-618).
    expect(registered.text).toContain(
      "Итог проверяемый: как его проверить — по кнопке ниже.",
    );
    expect(registered.text).not.toContain("ab".repeat(32));
    expect(labels(registered)).toEqual([
      ["Отменить регистрацию"],
      ["Как проверить честность"],
      ["‹ Аукцион"],
    ]);

    auction.raffle.current = {
      ...openRaffle,
      status: "drawn",
      drawnAt: "2026-10-29T22:30:00Z",
      registered: true,
      tickets: [{ number: 1, displayName: "@owl" }],
      myTicket: 1,
      reveal: {
        seed: "cd".repeat(32),
        randomness: "ef".repeat(32),
        value: "12".repeat(32),
        winningTicket: 1,
      },
    };
    await bot.handleUpdate(press(raffleData ?? ""));
    const result = lastScreen(calls);
    expect(result.text).toContain("Выиграл билет №1 — @owl.");
    expect(result.text).toContain("Это твой билет.");
    expect(result.text).toContain("Билетов: 1");
    // Момент жеребьёвки во времени сообщества (PER-641): 22:30 UTC — уже
    // 30 октября по Москве.
    expect(result.text).toContain("Жеребьёвка: 30 октября");
    expect(result.text).not.toContain("cd".repeat(32));
    expect(result.text).not.toContain("Как проверить итог");
    expect(labels(result)).toEqual([
      ["Как проверить честность"],
      ["‹ Аукцион"],
    ]);

    await bot.handleUpdate(
      press(data(result, "Как проверить честность") ?? ""),
    );
    const proof = lastScreen(calls);
    expect(proof.text).toContain("<b>Как проверить честность</b>");
    expect(proof.text).toContain("ab".repeat(32));
    expect(proof.text).toContain("cd".repeat(32));
    expect(proof.text).toContain("Как проверить итог");
    expect(proof.text).toContain("python3 -c");
    expect(labels(proof)).toEqual([["‹ Розыгрыш"]]);
  });

  it("offers no registration outside the registration window", async () => {
    const auction = fakeAuction({
      existing: true,
      raffle: { ...openRaffle, status: "not-held" },
    });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle", auctionId })),
    );
    const screen = lastScreen(calls);
    expect(screen.text).toContain("Розыгрыш не проводится");
    expect(labels(screen)).toEqual([["‹ Аукцион"]]);
  });

  // Отменённый вместе с аукционом розыгрыш (PER-698) — экран отмены с
  // возвратом в корень, без регистрации и проверки, а не кадр сбоя.
  it("shows a raffle cancelled with its auction as its own screen", async () => {
    const auction = fakeAuction({
      existing: true,
      raffle: { ...openRaffle, registered: true, status: "cancelled" },
    });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle", auctionId })),
    );
    const screen = lastScreen(calls);
    expect(screen.text).toContain("<b>Розыгрыш среди участников</b>");
    expect(screen.text).toContain(
      "Розыгрыш отменён вместе с аукционом: жеребьёвки не будет.",
    );
    expect(labels(screen)).toEqual([["‹ Аукцион"]]);
  });
});

// Счета победителя (PER-322): «Мои счета» в корне, список с суммой и текстом
// организатора, счёт и выбор способа получения — экраны проходят линтер хаба.
describe("winner invoices in the hub", () => {
  const invoiceId = "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6b";
  const mine: MyInvoicesView = {
    invoices: [
      {
        invoiceId,
        lotId,
        amount: { minorUnits: 300_000, currency: "RUB" },
        paymentDueAt: "2026-10-31T18:00:00Z",
        status: "awaiting-payment",
      },
    ],
    paymentInstructions: "Перевод на карту <организатора>.",
  };

  it("opens the invoices from the root, then an invoice, and chooses delivery", async () => {
    const auction = fakeAuction({ existing: true, invoices: mine });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(calls)).flat()).toContain("Мои счета");

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "invoices", auctionId })),
    );
    const list = lastScreen(calls);
    expect(list.text).toMatch(/^<b>Мои счета<\/b>/);
    expect(list.text).toContain("Кружка с совой — 3");
    expect(list.text).toContain("Всего: <b>3");
    expect(list.text).toContain("Перевод на карту &lt;организатора&gt;.");
    expect(labels(list).at(-1)).toEqual(["‹ Аукцион"]);

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "invoice", lotId, invoiceId })),
    );
    const invoice = lastScreen(calls);
    expect(invoice.text).toMatch(/^<b>Счёт: Кружка с совой<\/b>/);
    expect(invoice.text).toContain("Получение: способ не выбран");
    expect(labels(invoice)).toEqual([
      ["Самовывоз"],
      ["Доставка"],
      ["Цифровая выдача"],
      ["‹ Счета"],
    ]);

    await bot.handleUpdate(
      press(
        encodeAuctionCallback({
          kind: "fulfillment",
          lotId,
          invoiceId,
          method: "delivery",
        }),
      ),
    );
    const chosen = lastScreen(calls);
    expect(chosen.text).toContain("Способ получения выбран");
    expect(chosen.text).toContain("Получение: доставка");
    expect(labels(chosen)[1]).toEqual(["Доставка · выбрано"]);
  });

  it("shows no invoices entry to a viewer without invoices", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));
    expect(labels(lastScreen(calls)).flat()).not.toContain("Мои счета");
  });
});

describe("raffle screens in the hub", () => {
  const base: RaffleView = {
    auctionId,
    status: "open",
    closesAt: "2026-10-29T18:00:00Z",
    commitment: "ab".repeat(32),
    beaconRound: 12_345_678,
    registered: false,
    tickets: [],
  };
  const pool = {
    registered: true,
    tickets: [{ number: 1, displayName: "@owl" }, { number: 2 }],
    myTicket: 1,
  };
  const raffleData = encodeAuctionCallback({ kind: "raffle", auctionId });

  // Каждый статус уходит в Telegram и проходит линтер экранов хаба.
  it.each([
    [{ ...base, status: "closing" as const }, "Регистрация закрыта"],
    [
      { ...base, ...pool, status: "awaiting-beacon" as const },
      "Жеребьёвка идёт: итог — через пару минут.",
    ],
    [
      {
        ...base,
        ...pool,
        status: "drawn" as const,
        reveal: {
          seed: "cd".repeat(32),
          randomness: "ef".repeat(32),
          value: "12".repeat(32),
          winningTicket: 2,
        },
      },
      "Выиграл билет №2.",
    ],
    [
      {
        ...base,
        status: "no-tickets" as const,
        reveal: { seed: "cd".repeat(32) },
      },
      "Розыгрыш не состоялся",
    ],
  ])("shows the raffle in status %#", async (raffle, text) => {
    const auction = fakeAuction({ existing: true, raffle });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(press(raffleData));
    const screen = lastScreen(calls);
    expect(screen.text).toContain(text);
    expect(screen.text).not.toContain("drand");
    expect(labels(screen)).toEqual([
      ["Как проверить честность"],
      ["‹ Аукцион"],
    ]);
  });

  // Ручной итог по настройке сервиса (PER-799): до и после закрытия
  // регистрации ни минут, ни проверки по маяку, ни её кнопки.
  it.each([
    [
      { ...base, drawnByHand: true as const },
      "Итог подведёт организатор после закрытия регистрации.",
    ],
    [
      {
        ...base,
        registered: true,
        status: "closing" as const,
        drawnByHand: true as const,
      },
      "итог подведёт организатор.",
    ],
  ])("promises the result by hand in status %#", async (raffle, text) => {
    const auction = fakeAuction({ existing: true, raffle });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(press(raffleData));
    const screen = lastScreen(calls);
    expect(screen.text).toContain(text);
    expect(screen.text).not.toContain("пару минут");
    expect(screen.text).not.toContain("проверяемый");
    expect(labels(screen).flat()).not.toContain("Как проверить честность");
  });

  // Фото приза (PER-773): первым блоком rich-сообщения, над заголовком, как
  // фото лота, и `file_id` из ответа — в тот же кэш.
  it("shows the prize photo above the raffle and reuses its file_id", async () => {
    const auction = fakeAuction({
      existing: true,
      raffle: {
        ...base,
        prize: "Кружка",
        prizePhoto: { photoId: "prize-1", version: "prize-v1" },
      },
      prizePhoto: async () => ({
        content: new Uint8Array([9]),
        version: "prize-v1",
      }),
    });
    const photos = createLotPhotos();
    const { bot, calls } = harness("member", auction, {
      lotPhotos: photos,
      respond: (method) =>
        method === "editMessageText"
          ? {
              message_id: 9,
              date: 0,
              chat: { id: 42, type: "private", first_name: "tester" },
              rich_message: {
                blocks: [
                  {
                    type: "photo",
                    photo: [
                      {
                        file_id: "prize-file",
                        file_unique_id: "p",
                        width: 800,
                        height: 800,
                      },
                    ],
                  },
                ],
              },
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(raffleData));

    const screen = lastScreen(calls);
    expect(screen.rich_message?.html).toMatch(
      /^<img src="tg:\/\/photo\?id=lot"\/><h1>Розыгрыш среди участников<\/h1>/,
    );
    expect(screen.rich_message?.html).toContain("<p>Приз: Кружка</p>");
    expect(screen.rich_message?.media?.[0]?.media.media).toBeInstanceOf(
      InputFile,
    );
    expect(auction.getRafflePrizePhoto).toHaveBeenCalledWith({
      auctionId,
      viewer: expect.anything(),
    });
    expect(labels(screen)).toEqual([
      ["Зарегистрироваться"],
      ["Как проверить честность"],
      ["‹ Аукцион"],
    ]);

    await bot.handleUpdate(press(raffleData));
    expect(auction.getRafflePrizePhoto).toHaveBeenCalledTimes(1);
    expect(lastScreen(calls).rich_message?.media?.[0]?.media.media).toBe(
      "prize-file",
    );
  });

  it("shows the raffle without a photo when Auction does not give it", async () => {
    const auction = fakeAuction({
      existing: true,
      raffle: {
        ...base,
        prize: "Кружка",
        prizePhoto: { photoId: "prize-1", version: "prize-v1" },
      },
      prizePhoto: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    const { bot, calls } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(raffleData));

    const screen = lastScreen(calls);
    expect(screen.rich_message?.html).toMatch(
      /^<h1>Розыгрыш среди участников<\/h1>/,
    );
    expect(screen.rich_message?.media).toBeUndefined();
  });

  // До жеребьёвки строки нет (PER-641).
  it("shows no draw moment before the draw", async () => {
    for (const raffle of [
      { ...base, status: "closing" as const },
      { ...base, ...pool, status: "awaiting-beacon" as const },
      {
        ...base,
        status: "no-tickets" as const,
        reveal: { seed: "cd".repeat(32) },
      },
    ]) {
      const auction = fakeAuction({ existing: true, raffle });
      const { bot, calls } = harness("member", auction);

      await bot.handleUpdate(press(raffleData));
      expect(lastScreen(calls).text).not.toContain("Жеребьёвка: ");
    }
  });

  // Экран проверки в каждом статусе уходит в Telegram и проходит линтер.
  it.each([
    [{ ...base }, "Seed раскроется после жеребьёвки"],
    [
      { ...base, ...pool, status: "awaiting-beacon" as const },
      "Жеребьёвка ждёт значение маяка drand",
    ],
    [
      {
        ...base,
        status: "no-tickets" as const,
        reveal: { seed: "cd".repeat(32) },
      },
      "Билетов не было: пересчитывать нечего.",
    ],
  ])("shows the proof in status %#", async (raffle, text) => {
    const auction = fakeAuction({ existing: true, raffle });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle-proof", auctionId })),
    );
    const screen = lastScreen(calls);
    expect(screen.text).toContain("Отпечаток seed (SHA-256)");
    expect(screen.text).toContain(text);
    expect(labels(screen)).toEqual([["‹ Розыгрыш"]]);
  });

  // «К розыгрышу» под итогом (PER-620) — кнопка следа: экран итога приходит
  // новым сообщением, весть в истории не правится.
  it("opens the raffle from a result notification as a new message", async () => {
    const auction = fakeAuction({
      existing: true,
      raffle: {
        ...base,
        ...pool,
        status: "drawn",
        reveal: { seed: "cd".repeat(32), winningTicket: 2 },
      },
    });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(press(`v1:t:${raffleData.slice("v1:".length)}`));
    const screen = lastScreen(calls);
    expect(screen.text).toContain("Выиграл билет №2.");
    expect(labels(screen)).toEqual([
      ["Как проверить честность"],
      ["‹ Аукцион"],
    ]);
    expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
  });

  it("chooses a name before the registration and returns to the raffle", async () => {
    const auction = fakeAuction({ existing: true, raffle: base, nameless: {} });
    const { bot, calls } = harness("member", auction);

    await bot.handleUpdate(
      press(encodeAuctionCallback({ kind: "raffle-register", auctionId })),
    );
    const choice = lastScreen(calls);
    expect(choice.text).toContain("<b>Имя в аукционе</b>");
    expect(choice.text).toContain("в списке розыгрыша");
    expect(labels(choice)).toEqual([["Взять псевдоним"], ["‹ Розыгрыш"]]);

    await bot.handleUpdate(press(data(choice, "Взять псевдоним") ?? ""));
    const asked = calls.filter((call) => call.method === "sendMessage").at(-1)
      ?.payload as Shown | undefined;
    expect(asked?.text).toContain("Псевдоним");
    const step = asked?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
    expect(step).toBe(
      encodeAuctionCallback({
        kind: "raffle-question",
        auctionId,
        addressee: 42,
      }),
    );

    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text: "Сова",
        reply_to_message: {
          message_id: 9,
          date: 0,
          chat: { id: 42, type: "private", first_name: "tester" },
          from: { id: 1, is_bot: true, first_name: "hub" },
          text: "Псевдоним",
          reply_markup: {
            inline_keyboard: [[{ text: "Отмена", callback_data: step ?? "" }]],
          },
        },
      },
    } as Update);
    expect(lastScreen(calls).text).toContain("<b>Ты в розыгрыше</b>");
  });

  it("refuses a taken alias with a retry and the way back to the raffle", async () => {
    const auction = fakeAuction({
      existing: true,
      raffle: base,
      nameless: { aliasRefusal: "alias-taken" },
    });
    const { bot, calls } = harness("member", auction);
    const step = encodeAuctionCallback({
      kind: "raffle-question",
      auctionId,
      addressee: 42,
    });

    await bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text: "Сова",
        reply_to_message: {
          message_id: 9,
          date: 0,
          chat: { id: 42, type: "private", first_name: "tester" },
          from: { id: 1, is_bot: true, first_name: "hub" },
          text: "Псевдоним",
          reply_markup: {
            inline_keyboard: [[{ text: "Отмена", callback_data: step }]],
          },
        },
      },
    } as Update);
    const refused = lastScreen(calls);
    expect(refused.text).toContain("Этот псевдоним уже занят");
    expect(labels(refused)).toEqual([["Ввести заново"], ["‹ Розыгрыш"]]);
  });
});

// Карточка финала в боте хаба (PER-336): та же карточка дерева, что у бота
// аукциона, правится по потоку аукциона в сообщении, где её открыли.
describe("final lot card in the hub", () => {
  const rival = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
  const rub = (rubles: number) => ({
    minorUnits: rubles * 100,
    currency: "RUB",
  });
  const live = (version: number, price: number): LotView => ({
    ...lot,
    version,
    nextPrice: rub(price + 100),
    proxyEnabled: true,
    status: {
      kind: "trading",
      currentPrice: rub(price),
      leaderId: rival,
      phase: "live",
    },
  });
  const plain = (text: string) => text.replace(/[  ]/g, " ");

  function stream() {
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

  const setup = async () => {
    const watch = stream();
    const auction = fakeAuction({ existing: true, lot: live(1, 1200) });
    const run = harness("member", auction, {
      presentation: "plain",
      live: {
        watches: watch.watches,
        limiter: immediate,
        names: { getDisplayNames: async () => ({ [rival]: "@jay" }) },
      },
    });
    await run.bot.init();
    return { ...run, watch };
  };

  const liveEdits = (calls: readonly RecordedCall[]) =>
    calls.filter(
      (call) =>
        call.method === "editMessageText" &&
        (call.payload as { message_id?: number }).message_id === 9,
    );

  it("keeps one button at the next price as the price moves", async () => {
    const { bot, calls, watch } = await setup();
    await bot.handleUpdate(press(lotData));
    const card = lastScreen(calls);
    expect(labels(card)[0]?.map(plain)).toEqual(["Поставить 1 300 ₽"]);
    expect(watch.listeners.size).toBe(1);
    const before = liveEdits(calls).length;
    watch.emit(live(2, 1400));
    await flush();
    const edited = liveEdits(calls).at(-1)?.payload as Shown;
    expect(liveEdits(calls)).toHaveLength(before + 1);
    expect(plain(edited.text ?? "")).toContain("Цена: 1 400 ₽");
    expect(plain(edited.text ?? "")).toContain("Лидер: @jay");
    expect(labels(edited)[0]?.map(plain)).toEqual(["Поставить 1 500 ₽"]);
  });

  it("stops editing once another screen takes the message", async () => {
    const { bot, calls, watch } = await setup();
    await bot.handleUpdate(press(lotData));
    await bot.handleUpdate(press(feedData));
    expect(watch.listeners.size).toBe(0);
    const before = liveEdits(calls).length;
    watch.emit(live(2, 1400));
    await flush();
    expect(liveEdits(calls)).toHaveLength(before);
  });
});

// «События» (PER-669; решение владельца по отзыву тестовой группы 19 октября
// 2026 года): идущий аукцион — событие в меню, вход в него из «Событий»
// возвращает туда же через всё дерево.
describe("events of the hub", () => {
  const going = (stage: AuctionStageView) => (): MeetupAuctionResult => ({
    kind: "ok",
    auctionId,
    auction: {
      auctionId,
      stage,
      opensAt: "2026-10-12T09:00:00Z",
      closesAt: "2026-10-18T14:00:00Z",
      final: true,
    },
  });
  const trading = going("prebidding");
  const menuData = "v1:nav:start";
  const eventsData = "v1:nav:events";

  function command(text: string): Update {
    return {
      update_id: 4,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.length }],
      },
    } as never;
  }

  it("shows a going auction in the menu and reaches its root in two presses", async () => {
    const auction = fakeAuction({ existing: true, current: trading });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(menuData));
    const menu = lastScreen(calls);
    expect(labels(menu)).toEqual([
      ["Сходки", "Ближайшая сходка"],
      ["События"],
      ["Настройки", "Помощь"],
    ]);
    expect(menu.text).toContain("Идут события:");
    expect(menu.text).toContain("🏷️ Аукцион: идут онлайн-торги до");

    await bot.handleUpdate(press(eventsData));
    const events = lastScreen(calls);
    expect(labels(events)).toEqual([["🏷️ Аукцион"], ["‹ Меню"]]);
    expect(data(events, "🏷️ Аукцион")).toBe(
      rootData.replace("v1:auc:", "v1:aue:"),
    );

    await bot.handleUpdate(press(data(events, "🏷️ Аукцион") ?? ""));
    const root = lastScreen(calls);
    expect(labels(root).at(-1)).toEqual(["‹ События"]);
    expect(data(root, "‹ События")).toBe(eventsData);
    // Кнопки дерева несут вход: лента возвращает в корень, а корень — в
    // «События».
    const lots = data(root, "🏷️ Лоты") ?? "";
    expect(lots.startsWith("v1:aue:")).toBe(true);
    await bot.handleUpdate(press(lots));
    const feed = lastScreen(calls);
    expect(data(feed, "‹ Аукцион")).toBe(
      rootData.replace("v1:auc:", "v1:aue:"),
    );
    const card =
      feed.reply_markup?.inline_keyboard
        .flat()
        .find((button) => button.callback_data?.includes(":lot:"))
        ?.callback_data ?? "";
    expect(card.startsWith("v1:aue:")).toBe(true);
    await bot.handleUpdate(press(card));
    expect(
      (data(lastScreen(calls), "‹ Лоты") ?? "").startsWith("v1:aue:"),
    ).toBe(true);
  });

  it("returns from the rules to the root opened from the events", async () => {
    const auction = fakeAuction({ existing: true, current: trading });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(rootData.replace("v1:auc:", "v1:aue:")));
    const faq = data(lastScreen(calls), "Правила и FAQ") ?? "";
    expect(faq.endsWith(":e")).toBe(true);
    await bot.handleUpdate(press(faq));
    expect(data(lastScreen(calls), "‹ Аукцион")).toBe(
      rootData.replace("v1:auc:", "v1:aue:"),
    );
  });

  // Строка состояния (PER-767): под строкой аукциона в меню и «Событиях» —
  // день недели, идущее окно и розыгрыш; текст общий с ботом аукциона.
  it("shows the status line of the auction in the menu and the events", async () => {
    const inHours = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    const auction = fakeAuction({
      existing: true,
      current: () => ({
        kind: "ok",
        auctionId,
        auction: {
          auctionId,
          stage: "prebidding",
          opensAt: inHours(-30),
          closesAt: inHours(140),
          final: true,
          stepWindows: [
            { from: inHours(-1), until: inHours(1), lotIds: ["a"] },
          ],
          raffleClosesAt: inHours(100),
        },
      }),
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(menuData));
    const status =
      /день \d из \d · 🔥 Счастливые часы до (?:\d\d\.\d\d )?\d\d:\d\d · розыгрыш: регистрация до \d\d\.\d\d/;
    expect(lastScreen(calls).text).toMatch(status);

    await bot.handleUpdate(press(eventsData));
    expect(lastScreen(calls).text).toMatch(status);
  });

  // Окно и розыгрыш вокруг часов бота: строку убирает стадия, а не данные.
  it("leaves the status line out once the online week is over", async () => {
    const inHours = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
    const auction = fakeAuction({
      existing: true,
      current: () => ({
        kind: "ok",
        auctionId,
        auction: {
          auctionId,
          stage: "in-final",
          opensAt: inHours(-30),
          closesAt: inHours(140),
          final: true,
          stepWindows: [
            { from: inHours(-1), until: inHours(1), lotIds: ["a"] },
          ],
          raffleClosesAt: inHours(100),
        },
      }),
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(menuData));
    const menu = lastScreen(calls).text;
    expect(menu).toContain("🏷️ Аукцион: идёт финал");
    expect(menu).not.toContain(" · ");
  });

  // Меню — горячий путь: медленный Auction его не держит дольше срока.
  it("opens the menu without the events when Auction is slow", async () => {
    const auction = fakeAuction({
      existing: true,
      current: () => new Promise<MeetupAuctionResult>(() => {}),
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(menuData));
    expect(labels(lastScreen(calls))).toEqual([
      ["Сходки", "Ближайшая сходка"],
      ["Настройки", "Помощь"],
    ]);
  });

  it("keeps the meetup way back for the root opened from the meetup", async () => {
    const auction = fakeAuction({ existing: true, current: trading });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(extensionsData));
    await bot.handleUpdate(press(rootData));
    const root = lastScreen(calls);
    expect(labels(root).at(-1)).toEqual(["‹ Расширения"]);
    expect((data(root, "🏷️ Лоты") ?? "").startsWith("v1:auc:")).toBe(true);
  });

  it("hides the events from the menu while nothing goes and keeps /events with an empty state", async () => {
    const auction = fakeAuction({
      existing: true,
      current: going("draft"),
    });
    const { bot, calls } = harness("member", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(menuData));
    const menu = lastScreen(calls);
    expect(labels(menu)).toEqual([
      ["Сходки", "Ближайшая сходка"],
      ["Настройки", "Помощь"],
    ]);
    expect(menu.text).not.toContain("Идут события");

    await bot.handleUpdate(command("/events"));
    const events = lastScreen(calls);
    expect(events.text).toContain(
      "Сейчас не идут события, привязанные к сходкам.",
    );
    expect(labels(events)).toEqual([["‹ Меню"]]);
  });

  it("opens the menu without the events when Auction does not answer", async () => {
    const auction = fakeAuction({
      existing: true,
      current: () => ({ kind: "unavailable", cause: new Error("down") }),
    });
    const { bot, calls } = harness("admin", auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(menuData));
    expect(labels(lastScreen(calls))).toEqual([
      ["Сходки", "Ближайшая сходка"],
      ["Настройки", "Помощь"],
      ["🛠 Управление"],
    ]);

    // Сбой Auction убирает строки аукциона, а не меню (PER-767).
    expect(lastScreen(calls).text).not.toContain("Аукцион");

    await bot.handleUpdate(press(eventsData));
    expect(labels(lastScreen(calls))).toContainEqual(["Повторить"]);
  });
});

// Победителя проданного лота организатор видит настоящим аккаунтом (PER-648):
// ник отдаёт Identity по праву вести аукцион, участнику остаётся псевдоним.
describe("sold lot card in the hub", () => {
  const winner = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
  const sold: LotView = {
    ...lot,
    status: {
      kind: "sold",
      winnerId: winner,
      price: { minorUnits: 120_000, currency: "RUB" },
    },
  };
  const account = { kind: "resolved" as const, telegramUsername: "owl" };
  const text = (cards: readonly RecordedCall[]) => {
    const card = lastScreen(cards);
    return card.rich_message?.html ?? card.text ?? "";
  };

  it("names the real account of the winner to the organizer", async () => {
    const auction = fakeAuction({
      existing: true,
      lot: sold,
      names: { [winner]: "Сыч*" },
    });
    const { bot, calls } = harness("admin", auction, { account });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(text(calls)).toContain("Победитель: Сыч* (@owl)");
  });

  it("keeps the pseudonym of the winner for a participant", async () => {
    const auction = fakeAuction({
      existing: true,
      lot: sold,
      names: { [winner]: "Сыч*" },
    });
    const { bot, calls } = harness("member", auction, { account });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(text(calls)).toContain("Победитель: Сыч*");
    expect(text(calls)).not.toContain("@owl");
  });
});
