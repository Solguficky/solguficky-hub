import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import {
  type AccessRight,
  type AuctionSummaryView,
  encodeAuctionCallback,
  type LotView,
  type Money,
  type RaffleView,
} from "../../../auction-ui/index.js";
import {
  createDispatcher,
  type Dispatcher,
} from "../application/dispatcher.js";
import type {
  AuctionConsoleView,
  ConsoleAuctionStatus,
  ConsoleLot,
} from "../application/types.js";
import type {
  AuctionConsoles,
  AuctionScreens,
  AuctionWeekConfig,
  ConsoleReadResult,
  FinalistResult,
  LotAdministration,
  LotClosure,
  MeetupAuctions,
} from "../auction/port.js";
import type { IdentityResolver } from "../identity/port.js";
import { createAuctionParents } from "./auction-parents.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Пульт аукциона администратора в боте хаба (PER-320): вход из ленты, сроки
// недели и финал, открытие недели через подтверждение, отметка лотов для
// финала и просроченные лоты. Auction подменён одним состоянием на чтение
// пульта и его команды; бот пересоздаётся там, где проверяется рестарт.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const auctionToken = uuidToToken(auctionId);
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const vaseId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const mugId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
const timeZone = "Europe/Moscow";
const today = () => ({ year: 2026, month: 10, day: 6 });
// Часы бота в тестах: 6 октября 2026 года, 12:00 по Москве.
const now = new Date("2026-10-06T09:00:00Z");

const consoleData = `v1:ac:v:${auctionToken}`;
const feedData = encodeAuctionCallback({ kind: "feed", auctionId, page: 0 });
const rootData = encodeAuctionCallback({ kind: "root", auctionId });

const rub = (minorUnits: number): Money => ({ minorUnits, currency: "RUB" });

const week = {
  opensAt: "2026-10-20T15:00:00Z",
  closesAt: "2026-10-26T21:00:00Z",
  windows: [],
};

function trading(lotId: string, title: string, price: number): LotView {
  return {
    lotId,
    auctionId,
    version: 3,
    card: { title, description: "" },
    proxyEnabled: false,
    status: { kind: "trading", currentPrice: rub(price), phase: "online" },
  };
}

// Права, как их выводит Identity (RFC-016): набор `admin` несёт право вести
// сходки с пультом и каталогом лотов, участник — только права хаба и ставок.
// `rights` задаёт тест, которому нужен держатель части прав набора.
function identity(
  holder: "admin" | "member",
  rights: readonly AccessRight[] = holder === "admin"
    ? [
        "access-hub",
        "place-bids",
        "manage-members",
        "admit-bidders",
        "manage-meetups",
      ]
    : ["access-hub", "place-bids"],
) {
  return {
    resolve: async () => ({
      kind: "resolved" as const,
      identityId,
      rights,
      blocked: false,
    }),
  } satisfies IdentityResolver;
}

type Command = { method: string; args: unknown };

// Auction пульта: одно состояние на чтение и команды. Открытие недели
// принимает повтор того же ключа и отвечает «не запланирован» новому ключу на
// открытом аукционе — как сервис.
function fakeAuction(
  options: {
    status?: ConsoleAuctionStatus;
    week?: AuctionConsoleView["week"];
    lots?: readonly ConsoleLot[];
    // Отказ чтения пульта: Auction не признал администратора сходки.
    refuse?: true;
    // Лоты, у которых дедлайн прошёл: отметка финала им отказана.
    deadlinePassed?: readonly string[];
    // Отбирать некуда: у аукциона в сервисе нет финала.
    notApplicable?: true;
    // У аукциона открыт розыгрыш (ADR-066): лента ставит его кнопку.
    raffle?: true;
    // Финал (PER-337): замороженный состав, ставки активного лота и имена.
    lineup?: readonly string[];
    bids?: readonly { amount: Money; participantId: string }[];
    names?: Readonly<Record<string, string>>;
    // Слот торгов держит другой аукцион (PER-603): открытие недели получает
    // отказ, а чтение активных аукционов — его сроки (PER-618).
    busy?: AuctionSummaryView;
    // Розыгрыш глазами администратора после закрытия регистрации (PER-618).
    consoleRaffle?: RaffleView;
    // Состав финала (PER-619): сколько объявлений подряд Auction недоступен
    // и какие лоты он сам считает удержанными, если не те, что в пульте.
    freezeFailures?: number;
    heldByAuction?: readonly string[];
  } = {},
) {
  let freezeFailures = options.freezeFailures ?? 0;
  const state: {
    status: ConsoleAuctionStatus;
    week?: AuctionConsoleView["week"];
    lots: ConsoleLot[];
    startedBy?: string;
    discarded?: true;
    lineup?: { order: readonly string[]; activeLotId?: string };
    // Ключ принятого объявления состава: его повтор Auction принимает.
    frozenBy?: string;
    // Закрытия по ключу: повтор ключа получает исходный ответ, как в сервисе.
    closures: Map<string, LotClosure>;
  } = {
    status: options.status ?? "draft",
    ...(options.week === undefined ? {} : { week: options.week }),
    lots: [...(options.lots ?? [])],
    ...(options.lineup === undefined
      ? {}
      : { lineup: { order: options.lineup } }),
    closures: new Map(),
  };
  const lotOf = (lotId: string) =>
    state.lots.find((each) => each.lot.lotId === lotId);
  const replaceLot = (lotId: string, lot: LotView) => {
    state.lots = state.lots.map((each) =>
      each.lot.lotId === lotId ? { ...each, lot } : each,
    );
  };
  const commands: Command[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const mark =
    (selected: boolean) =>
    async (
      _person: unknown,
      marked: { auctionId: string; lotId: string; opId: string },
    ): Promise<FinalistResult> => {
      commands.push({
        method: selected ? "selectForFinal" : "deselectForFinal",
        args: marked,
      });
      if (selected && options.notApplicable === true) {
        return { kind: "refused", reason: "selection-not-applicable" };
      }
      if (options.deadlinePassed?.includes(marked.lotId)) {
        return { kind: "refused", reason: "deadline-passed" };
      }
      state.lots = state.lots.map((each) =>
        each.lot.lotId === marked.lotId
          ? { ...each, markedForFinal: selected }
          : each,
      );
      return { kind: "ok" };
    };
  const port: MeetupAuctions &
    AuctionScreens &
    LotAdministration &
    AuctionConsoles = {
    getMeetupAuction: notUsed,
    enableAuction: notUsed,
    createLotCard: notUsed,
    editLotCard: notUsed,
    addLot: notUsed,
    scheduleLot: notUsed,
    getLot: notUsed,
    async getAuctionConsole(): Promise<ConsoleReadResult> {
      commands.push({ method: "getAuctionConsole", args: auctionId });
      if (options.refuse === true) return { kind: "not-administrator" };
      return {
        kind: "ok",
        console: {
          auctionId,
          status: state.status,
          ...(state.week === undefined ? {} : { week: state.week }),
          ...(state.lineup === undefined ? {} : { lineup: state.lineup }),
          lots: state.lots,
        },
      };
    },
    async getAuctionLotStatistics() {
      return {
        kind: "ok" as const,
        lots: state.lots.map((each) => ({
          lotId: each.lot.lotId,
          bidCount: each.bidCount,
          uniqueParticipantCount: each.uniqueParticipantCount,
        })),
      };
    },
    async scheduleAuction(_person, config: AuctionWeekConfig) {
      commands.push({ method: "scheduleAuction", args: config });
      if (state.status !== "draft" && state.status !== "scheduled") {
        return { kind: "already-started" };
      }
      // Окно «Счастливых часов» лежит внутри недели — как в сервисе.
      const outside = config.windows.findIndex(
        (window) =>
          Date.parse(window.from) < Date.parse(config.opensAt) ||
          Date.parse(window.until) > Date.parse(config.closesAt),
      );
      if (outside !== -1) {
        return { kind: "window-outside-week", window: outside };
      }
      // Момент розыгрыша лежит строго внутри недели (ADR-066, п. 5).
      const raffle = config.raffleClosesAt;
      if (raffle !== undefined) {
        if (Date.parse(raffle) <= Date.parse(config.opensAt)) {
          return { kind: "raffle-not-after-opens" };
        }
        if (Date.parse(raffle) >= Date.parse(config.closesAt)) {
          return { kind: "raffle-not-before-closes" };
        }
      }
      state.status = "scheduled";
      state.week = {
        opensAt: config.opensAt,
        closesAt: config.closesAt,
        final: config.final,
        windows: config.windows,
        ...(raffle === undefined ? {} : { raffleClosesAt: raffle }),
      };
      return { kind: "ok" };
    },
    async startPrebidding(_person, start) {
      commands.push({ method: "startPrebidding", args: start });
      if (options.busy !== undefined) {
        return {
          kind: "another-auction-active",
          auctionId: options.busy.auctionId,
        };
      }
      if (state.status === "scheduled") {
        state.status = "prebidding";
        state.startedBy = start.opId;
        return { kind: "ok" };
      }
      return state.startedBy === start.opId
        ? { kind: "ok" }
        : { kind: "not-scheduled" };
    },
    async discardAuction(_person, discard) {
      commands.push({ method: "discardAuction", args: discard });
      if (state.discarded === true) return { kind: "ok" };
      if (state.status !== "draft" && state.status !== "scheduled") {
        return { kind: "already-started" };
      }
      state.discarded = true;
      return { kind: "ok" };
    },
    selectForFinal: mark(true),
    deselectForFinal: mark(false),
    // Объявление состава — как в сервисе: повтор ключа принят до проверок,
    // набор удержанных сверяется, порядок берётся как есть.
    async freezeFinalLineup(_person, freeze) {
      commands.push({ method: "freezeFinalLineup", args: freeze });
      if (freezeFailures > 0) {
        freezeFailures -= 1;
        return { kind: "unavailable", cause: new Error("lots not known yet") };
      }
      if (state.frozenBy === freeze.opId) return { kind: "ok" };
      if (state.status !== "break") return { kind: "not-in-break" };
      const held =
        options.heldByAuction ??
        state.lots
          .filter((each) => each.markedForFinal)
          .map((each) => each.lot.lotId);
      if (held.length === 0) return { kind: "lineup-empty" };
      if (
        held.length !== freeze.lotIds.length ||
        !held.every((lotId) => freeze.lotIds.includes(lotId))
      ) {
        return { kind: "lineup-mismatch" };
      }
      state.status = "lineup-frozen";
      state.lineup = { order: freeze.lotIds };
      state.frozenBy = freeze.opId;
      return { kind: "ok" };
    },
    async startFinal(_person, start) {
      commands.push({ method: "startFinal", args: start });
      if (state.status !== "lineup-frozen") {
        return { kind: "lineup-not-frozen" };
      }
      state.status = "final";
      return { kind: "ok" };
    },
    async startNextLot(_person, start) {
      commands.push({ method: "startNextLot", args: start });
      if (state.status !== "final" || state.lineup === undefined) {
        return { kind: "not-in-final" };
      }
      const active = state.lineup.activeLotId;
      if (active !== undefined) {
        return { kind: "another-lot-active", lotId: active };
      }
      const next = state.lineup.order.find(
        (lotId) => lotOf(lotId)?.lot.status.kind === "held",
      );
      const lot = next === undefined ? undefined : lotOf(next)?.lot;
      if (next === undefined || lot?.status.kind !== "held") {
        return { kind: "lineup-exhausted" };
      }
      replaceLot(next, {
        ...lot,
        nextPrice: rub(lot.status.currentPrice.minorUnits + 10_000),
        status: {
          kind: "trading",
          currentPrice: lot.status.currentPrice,
          ...(lot.status.leaderId === undefined
            ? {}
            : { leaderId: lot.status.leaderId }),
          phase: "live",
        },
      });
      state.lineup = { ...state.lineup, activeLotId: next };
      return { kind: "ok", lotId: next };
    },
    async advanceAsk(_person, ask) {
      commands.push({ method: "advanceAsk", args: ask });
      const lot = lotOf(ask.lotId)?.lot;
      if (lot?.status.kind !== "trading") return { kind: "lot-not-open" };
      if (ask.newAsk.minorUnits <= lot.status.currentPrice.minorUnits) {
        return {
          kind: "ask-below-current-price",
          mustExceed: lot.status.currentPrice,
        };
      }
      replaceLot(ask.lotId, { ...lot, nextPrice: ask.newAsk });
      return { kind: "ok" };
    },
    async closeLot(_person, close) {
      commands.push({ method: "closeLot", args: close });
      const replayed = state.closures.get(close.opId);
      if (replayed !== undefined) return { kind: "ok", closure: replayed };
      const lot = lotOf(close.lotId)?.lot;
      if (lot?.status.kind !== "trading") return { kind: "lot-not-open" };
      const closure: LotClosure =
        lot.status.leaderId === undefined
          ? { kind: "unsold" }
          : {
              kind: "sold",
              winnerId: lot.status.leaderId,
              price: lot.status.currentPrice,
            };
      state.closures.set(close.opId, closure);
      replaceLot(close.lotId, {
        ...lot,
        status:
          closure.kind === "sold"
            ? {
                kind: "sold",
                winnerId: closure.winnerId,
                price: closure.price,
              }
            : { kind: "unsold" },
      });
      if (state.lineup !== undefined) {
        state.lineup = { order: state.lineup.order };
      }
      return { kind: "ok", closure };
    },
    async recentBids() {
      return {
        kind: "ok" as const,
        bids: options.bids ?? [],
        names: options.names ?? {},
      };
    },
    async displayNames() {
      return { kind: "ok" as const, names: options.names ?? {} };
    },
    async activeAuctions() {
      return {
        kind: "ok" as const,
        auctions: options.busy === undefined ? [] : [options.busy],
      };
    },
    async consoleRaffle() {
      return options.consoleRaffle === undefined
        ? { kind: "ok" as const }
        : { kind: "ok" as const, raffle: options.consoleRaffle };
    },
    currentAuction: async () => ({ kind: "ok" as const }),
    screenPorts() {
      return {
        auction: {
          findLot: async () => undefined,
          getLot: notUsed,
          listAuctionLots: async () => ({
            lots: state.lots.map((each) => each.lot),
            nextPageToken: "",
          }),
          listLotHistory: notUsed,
          getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
          getDisplayNames: async () => ({}),
          placeBid: notUsed,
          setProxyLimit: notUsed,
          chooseDisplayName: notUsed,
          getAuction: async () => ({
            auctionId,
            stage: "scheduled" as const,
            final: false,
          }),
          // Розыгрыш открывается с онлайн-неделей, если у недели есть момент
          // закрытия регистрации, — как в сервисе.
          getRaffle: async () =>
            options.raffle === true ||
            (state.status === "prebidding" &&
              state.week?.raffleClosesAt !== undefined)
              ? {
                  auctionId,
                  status: "open" as const,
                  closesAt: "2026-10-29T18:00:00Z",
                  commitment: "ab".repeat(32),
                  beaconRound: 12_345_678,
                  registered: false,
                  tickets: [],
                }
              : undefined,
          registerForRaffle: notUsed,
          cancelRaffleRegistration: notUsed,
        },
        operations: { newOperationId: () => "unused" },
        image: { getLotImage: notUsed },
      };
    },
  };
  return {
    port,
    state,
    commands,
    sent: (method: string) =>
      commands.filter((command) => command.method === method),
  };
}

// Новый бот над тем же Auction и той же историей чата: так выглядит рестарт.
function harness(
  holder: "admin" | "member",
  auction: ReturnType<typeof fakeAuction>,
  calls: RecordedCall[] = [],
  rights?: readonly AccessRight[],
) {
  return createHarness(
    identity(holder, rights),
    createDispatcher(undefined, undefined, today, auction.port, auction.port, {
      auctions: auction.port,
      timeZone,
      now: () => now,
    }),
    calls,
    undefined,
    "plain",
    today,
    { auction: auction.port, communityTimeZone: timeZone },
  );
}

function press(data: string): Update {
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
        text: "Пульт",
      },
    } as never,
  };
}

type Sent = {
  text?: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard: {
      text: string;
      callback_data?: string;
      style?: string;
    }[][];
  };
};

function shown(calls: readonly RecordedCall[]): Sent[] {
  return calls
    .filter((call) => ["editMessageText", "sendMessage"].includes(call.method))
    .map((call) => call.payload as Sent);
}

function last(calls: readonly RecordedCall[]): Sent {
  const screen = shown(calls).at(-1);
  if (screen === undefined) throw new Error("nothing was shown");
  return screen;
}

// Сумму `Intl` пишет с неразрывными пробелами; тест сверяет слова.
function spaced(text: string): string {
  return text.replaceAll(/[  ]/g, " ");
}

function plain(screen: Sent): string {
  return spaced(screen.text ?? "").replaceAll(/<\/?b>/g, "");
}

function labels(screen: Sent): string[][] {
  return (screen.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => button.text),
  );
}

function dataOf(screen: Sent, text: string): string {
  const found = screen.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.text === text)?.callback_data;
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function toasts(calls: readonly RecordedCall[]): unknown[] {
  return calls
    .filter((call) => call.method === "answerCallbackQuery")
    .map((call) => (call.payload as { text?: string }).text)
    .filter((text) => text !== undefined);
}

// Последний вопрос в чате: его текст, клавиатура и номер сообщения, которым
// ответил бы Telegram, — как их вернёт клиент в `reply_to_message`.
function question(calls: readonly RecordedCall[]) {
  const index = calls.findLastIndex(
    (call) =>
      call.method === "sendMessage" &&
      (call.payload as Sent).reply_markup?.force_reply === true,
  );
  if (index === -1) throw new Error("no question was asked");
  const payload = calls[index]?.payload as Sent;
  return { payload, messageId: 100 + index + 1 };
}

function answer(
  calls: readonly RecordedCall[],
  content: Record<string, unknown>,
  from = 42,
): Update {
  const asked = question(calls);
  return {
    update_id: 4,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: from, is_bot: false, first_name: "tester" },
      ...(content as { text?: string }),
      reply_to_message: {
        message_id: asked.messageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "stub" },
        text: asked.payload.text,
        reply_markup: asked.payload.reply_markup,
        // grammY's ReplyMessage intersects Message with a required `undefined`
        // property, which is uninhabitable under exactOptionalPropertyTypes.
      } as never,
    },
  };
}

const vase: ConsoleLot = {
  lot: trading(vaseId, "Ваза", 120_000),
  bidCount: 3,
  uniqueParticipantCount: 2,
  markedForFinal: false,
  overdue: false,
};
const mug: ConsoleLot = {
  lot: trading(mugId, "Кружка", 50_000),
  bidCount: 1,
  uniqueParticipantCount: 1,
  markedForFinal: true,
  overdue: true,
};
// Лот с ценой и шагом откроется вместе с неделей; лот без них — нет.
const priced: ConsoleLot = {
  lot: {
    ...trading(vaseId, "Ваза", 0),
    status: { kind: "scheduled", startingPrice: rub(50_000) },
  },
  bidCount: 0,
  uniqueParticipantCount: 0,
  markedForFinal: false,
  overdue: false,
};
const unpriced: ConsoleLot = {
  lot: { ...trading(mugId, "Кружка", 0), status: { kind: "draft" } },
  bidCount: 0,
  uniqueParticipantCount: 0,
  markedForFinal: false,
  overdue: false,
};

describe("entry into the auction console", () => {
  // Пульт — ряд корня аукциона (PER-605), а «Добавить лот» остаётся над
  // списком лотов.
  it("shows the console in the auction root to the administrator only", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const admin = harness("admin", auction);
    await admin.bot.init();
    await admin.bot.handleUpdate(press(rootData));
    const root = last(admin.calls);
    expect(labels(root).slice(0, 3)).toEqual([
      ["🔨 Лоты"],
      ["Пульт"],
      ["Правила и FAQ"],
    ]);
    expect(dataOf(root, "Пульт")).toBe(consoleData);

    const member = harness("member", auction);
    await member.bot.init();
    await member.bot.handleUpdate(press(rootData));
    expect(JSON.stringify(shown(member.calls))).not.toContain("Пульт");
  });

  // «Добавить лот» — пока онлайн-неделя не открыта (PER-468): после старта
  // Auction отвечает `lots_frozen`, и кнопка вела бы в отказ после вопроса.
  it("shows the lot entry while the auction still accepts lots", async () => {
    for (const status of ["draft", "scheduled"] as const) {
      const auction = fakeAuction({ status, lots: [vase] });
      const { bot, calls } = harness("admin", auction);
      await bot.init();
      await bot.handleUpdate(press(feedData));
      expect(labels(last(calls))[0]).toEqual(["Добавить лот"]);
      expect(auction.sent("getAuctionConsole")).toHaveLength(1);
    }
  });

  // Розыгрыш открыт с онлайн-недели: у администратора он встаёт в корне
  // парой к «Пульту», у участника — своим рядом.
  it("pairs the raffle with the console in the root once the online week is open", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [vase],
      raffle: true,
    });
    const admin = harness("admin", auction);
    await admin.bot.init();
    await admin.bot.handleUpdate(press(rootData));
    expect(labels(last(admin.calls)).slice(1, 3)).toEqual([
      ["Пульт", "Розыгрыш"],
      ["Правила и FAQ"],
    ]);

    const member = harness("member", auction);
    await member.bot.init();
    await member.bot.handleUpdate(press(rootData));
    expect(labels(last(member.calls)).slice(1, 3)).toEqual([
      ["Розыгрыш"],
      ["Правила и FAQ"],
    ]);
  });

  it("hides the lot entry once the online week is open", async () => {
    const auction = fakeAuction({ status: "prebidding", lots: [vase] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    const feed = last(calls);
    expect(JSON.stringify(feed)).not.toContain("Добавить лот");
    expect(labels(feed).at(-1)).toEqual(["‹ Аукцион"]);
  });

  it("keeps the lot entry when the console cannot be read", async () => {
    const auction = fakeAuction({ status: "prebidding", refuse: true });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    expect(labels(last(calls))[0]).toEqual(["Добавить лот"]);
  });

  // Пульт и каталог лотов — одно право вести сходки (RFC-016): держатель
  // управления составом без него не видит ни того, ни другого, и Auction его
  // не спрашивают.
  it("hides the console and the lot entries from a holder of other management rights", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const moderator = [
      "access-hub",
      "place-bids",
      "manage-members",
      "admit-bidders",
    ] as const;
    const { bot, calls } = harness("member", auction, [], moderator);
    await bot.init();

    await bot.handleUpdate(press(feedData));
    expect(JSON.stringify(last(calls))).not.toContain("Пульт");
    expect(JSON.stringify(last(calls))).not.toContain("Добавить лот");
    expect(auction.sent("getAuctionConsole")).toEqual([]);

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    expect(last(calls).text).toContain("Это действие тебе недоступно.");
    expect(auction.commands).toEqual([]);
  });

  it("does not read the console for a member's feed", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot } = harness("member", auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    expect(auction.sent("getAuctionConsole")).toEqual([]);
  });

  it("refuses an old console button of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot, calls, records } = harness("member", auction);
    await bot.init();

    for (const data of [
      consoleData,
      `v1:ac:w:${auctionToken}`,
      `v1:ac:o:${auctionToken}`,
      `v1:ac:s:${auctionToken}:${uuidToToken(vaseId)}:0`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(last(calls).text).toContain("Это действие тебе недоступно.");
    }
    expect(auction.commands).toEqual([]);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
      use_case: "manage_auction",
    });
  });

  it("shows the refusal of Auction to someone it does not take for the administrator of the meetup", async () => {
    const auction = fakeAuction({ refuse: true });
    const { bot, calls, records } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain("Это действие тебе недоступно.");
    expect(labels(last(calls))).toEqual([["‹ Сходки"]]);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
      error: "not_administrator",
    });
  });
});

describe("auction console", () => {
  it("sorts all lots by the selected metric and toggles the active direction", async () => {
    const fewerParticipants: ConsoleLot = {
      ...vase,
      uniqueParticipantCount: 1,
      priceGrowth: rub(90_000),
    };
    const moreParticipants: ConsoleLot = {
      ...mug,
      uniqueParticipantCount: 4,
      priceGrowth: rub(20_000),
    };
    const noGrowthA: ConsoleLot = {
      ...mug,
      lot: {
        ...mug.lot,
        lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e",
        card: { title: "Без роста A", description: "" },
      },
      uniqueParticipantCount: 0,
    };
    const noGrowthB: ConsoleLot = {
      ...mug,
      lot: {
        ...mug.lot,
        lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3f",
        card: { title: "Без роста B", description: "" },
      },
      uniqueParticipantCount: 0,
    };
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [fewerParticipants, moreParticipants, noGrowthB, noGrowthA],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Люди")));
    const descending = plain(last(calls));
    expect(descending.indexOf("Кружка")).toBeLessThan(
      descending.indexOf("Ваза"),
    );
    expect(descending).toContain("Сортировка: по участникам ↓.");

    await bot.handleUpdate(press(dataOf(last(calls), "Люди")));
    const ascending = plain(last(calls));
    expect(ascending.indexOf("Ваза")).toBeLessThan(ascending.indexOf("Кружка"));
    expect(ascending).toContain("Сортировка: по участникам ↑.");

    await bot.handleUpdate(press(dataOf(last(calls), "Рост")));
    const growth = plain(last(calls));
    expect(growth.indexOf("Ваза")).toBeLessThan(growth.indexOf("Кружка"));
    expect(growth.indexOf("Кружка")).toBeLessThan(
      growth.indexOf("Без роста A"),
    );
    expect(growth.indexOf("Без роста A")).toBeLessThan(
      growth.indexOf("Без роста B"),
    );
    expect(growth).toContain("рост 900 ₽");
  });

  it("keeps the current page when changing the sort metric", async () => {
    const lots = Array.from({ length: 9 }, (_, index) => ({
      ...vase,
      lot: {
        ...vase.lot,
        lotId: `01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b${index.toString(16).padStart(2, "0")}`,
        card: { title: `Лот ${index}`, description: "" },
      },
      bidCount: index,
      uniqueParticipantCount: index,
    }));
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots,
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "→")));

    expect(last(calls).text).toContain("Пульт · 2 из 2");
    await bot.handleUpdate(press(dataOf(last(calls), "Люди")));

    expect(last(calls).text).toContain("Пульт · 2 из 2");
    expect(plain(last(calls))).toContain("Сортировка: по участникам ↓.");
  });

  it("shows the state, the lots with price and bids, the final mark and the overdue lots on their own line", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase, mug],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    const screen = last(calls);
    expect(spaced(screen.text ?? "")).toBe(
      [
        "<b>Пульт</b>",
        "Идут онлайн-торги до 27 октября, вт, 00:00.\nФинал: есть.\nРозыгрыш: нет.",
        "Сортировка: по ставкам ↓.",
        [
          "• Ваза — 1 200 ₽ · 3 ставки · 2 уч.",
          "• Кружка — 500 ₽ · 1 ставка · 1 уч. · в финал",
        ].join("\n"),
        "Просрочены, не закрыты: Кружка.",
      ].join("\n\n"),
    );
    expect(labels(screen)).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["В финал · Ваза"],
      ["Снять из финала · Кружка"],
      ["‹ Аукцион"],
    ]);
    expect(dataOf(screen, "‹ Аукцион")).toBe(rootData);
  });

  it("marks a lot for the final and takes the mark off", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "В финал · Ваза")));

    expect(auction.sent("selectForFinal")).toEqual([
      {
        method: "selectForFinal",
        args: { auctionId, lotId: vaseId, opId: expect.any(String) },
      },
    ]);
    // Исход — свой экран без строк пульта; пульт открывает «‹ Пульт».
    expect(last(calls).text).toBe("<b>Лот отмечен для финала</b>");
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "• Ваза — 1 200 ₽ · 3 ставки · 2 уч. · в финал",
    );

    await bot.handleUpdate(
      press(dataOf(last(calls), "Снять из финала · Ваза")),
    );

    expect(auction.sent("deselectForFinal")).toHaveLength(1);
    expect(last(calls).text).toBe("<b>Отметка финала снята</b>");
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(labels(last(calls))[0]).toEqual(["Ставки", "Люди", "Рост"]);
    expect(labels(last(calls))).toContainEqual(["В финал · Ваза"]);
  });

  it("shows the refusal of a passed deadline as an outcome screen instead of a success", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
      deadlinePassed: [vaseId],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "В финал · Ваза")));

    const screen = plain(last(calls));
    expect(last(calls).text).toBe(
      "<b>Дедлайн лота прошёл</b>\n\nОтметку финала уже не изменить.",
    );
    expect(screen).not.toContain("Лот отмечен для финала");
    // Строк пульта на экране исхода нет; пульт за «‹ Пульт» без отметки.
    expect(screen).not.toContain("• Ваза");
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("• Ваза — 1 200 ₽ · 3 ставки · 2 уч.");
    expect(plain(last(calls))).not.toContain("в финал");
  });
});

describe("week of the auction", () => {
  it("asks the dates, keeps the step over a restart and schedules the week closing the lots, with the final, without lot defaults", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    expect(plain(last(calls))).toContain("Сроки недели не заданы.");
    expect(labels(last(calls))).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["Сроки недели"],
      ["🗑 Удалить аукцион"],
      ["‹ Аукцион"],
    ]);

    await next((history) => press(dataOf(last(history), "Сроки недели")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:aw:${auctionToken}:42`);
    expect(asked.text).toContain(
      "Например: 20.10.2026 18:00 — 27.10.2026 00:00",
    );

    // Ответ, который не разобран, — экран исхода с причиной в заголовке и
    // «Ввести заново»; тот же вопрос задаёт только эта кнопка.
    await next((history) => answer(history, { text: "на следующей неделе" }));
    expect(last(calls).text).toBe(
      "<b>Не получилось разобрать сроки</b>\n\nНужны начало и конец: ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ.",
    );
    expect(last(calls).reply_markup?.force_reply).toBeUndefined();
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    expect(question(calls).payload.text).toContain(
      "Например: 20.10.2026 18:00 — 27.10.2026 00:00",
    );
    await next((history) =>
      answer(history, { text: "27.10.2026 00:00 — 20.10.2026 18:00" }),
    );
    expect(last(calls).text).toBe(
      "<b>Конец недели должен быть позже начала</b>",
    );
    expect(auction.sent("scheduleAuction")).toEqual([]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));

    await next((history) =>
      answer(history, { text: "20.10.2026 18:00 — 27.10.2026 00:00" }),
    );

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: {
          auctionId,
          opId: expect.any(String),
          ...week,
          final: true,
        },
      },
    ]);
    // Исход сохранения — свой экран и называет сохранённое (PER-618); кнопки
    // пульта — за «‹ Пульт».
    expect(last(calls).text).toBe(
      "<b>Сроки недели сохранены: с 20 октября, вт, 18:00 до 27 октября, вт, 00:00</b>",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    const screen = last(calls);
    expect(plain(screen)).toContain(
      "Онлайн-неделя: с 20 октября, вт, 18:00 до 27 октября, вт, 00:00.\nФинал: есть.",
    );
    expect(labels(screen)).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["Сроки недели"],
      ["Вкл · Финал"],
      ["Счастливые часы"],
      ["Розыгрыш"],
      ["Открыть онлайн-неделю"],
      ["🗑 Удалить аукцион"],
      ["‹ Аукцион"],
    ]);
  });

  it("shows an outcome screen with a retry when the answer is not text", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));

    await bot.handleUpdate(
      answer(calls, { sticker: { file_id: "s", file_unique_id: "s" } }),
    );

    expect(last(calls).text).toBe("<b>Нужен ответ текстом</b>");
    expect(last(calls).reply_markup?.force_reply).toBeUndefined();
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });

  it("names the current dates in the question in the form they are typed", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: false },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));
    expect(question(calls).payload.text?.split("\n")[0]).toBe(
      "Сейчас: 20.10.2026 18:00 — 27.10.2026 00:00",
    );
    await bot.handleUpdate(
      answer(calls, { text: "21.10.2026 18:00 - 28.10.2026 00:00" }),
    );

    // Новые сроки не трогают выбранный финал.
    expect(auction.sent("scheduleAuction").at(-1)?.args).toMatchObject({
      opensAt: "2026-10-21T15:00:00Z",
      closesAt: "2026-10-27T21:00:00Z",
      final: false,
    });
  });

  it("switches the final with the same dates and confirms the switch with a toast", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    const toggle = dataOf(last(calls), "Вкл · Финал");
    // Кнопка несёт целевое состояние, а не переворот.
    expect(toggle).toBe(`v1:ac:f:${auctionToken}:0`);
    await bot.handleUpdate(press(toggle));

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: { auctionId, opId: expect.any(String), ...week, final: false },
      },
    ]);
    expect(toasts(calls)).toContain("Выключено: финал.");
    expect(plain(last(calls))).toContain("Финал: нет.");
    expect(labels(last(calls))).toContainEqual(["Выкл · Финал"]);

    // Повтор той же кнопки команды не шлёт: финал уже такой.
    await bot.handleUpdate(press(toggle));
    expect(auction.sent("scheduleAuction")).toHaveLength(1);
  });

  it("switches the final back on right after it was switched off", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Вкл · Финал")));
    // Новое чтение видит выключенный финал, и «Вкл» шлёт команду.
    await bot.handleUpdate(press(dataOf(last(calls), "Выкл · Финал")));

    expect(
      auction.sent("scheduleAuction").map((command) => command.args),
    ).toEqual([
      expect.objectContaining({ final: false }),
      expect.objectContaining({ final: true }),
    ]);
    expect(toasts(calls)).toContain("Включено: финал.");
    expect(labels(last(calls))).toContainEqual(["Вкл · Финал"]);
  });

  it("shows an outcome screen with a retry when the end of the week has already come", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));

    await bot.handleUpdate(
      answer(calls, { text: "01.10.2026 18:00 — 06.10.2026 12:00" }),
    );

    expect(last(calls).text).toBe("<b>Конец недели уже прошёл</b>");
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });
});

// Розыгрыш (PER-593): момент закрытия регистрации — свой вопрос на пульте,
// «Убрать» снимает его, а сроки, финал и окна его не стирают.
describe("raffle of the week", () => {
  const moment = "2026-10-22T15:00:00Z";

  it("asks the moment, keeps the step over a restart, opens the raffle with the week", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    expect(plain(last(calls))).toContain("Розыгрыш: нет.");
    expect(dataOf(last(calls), "Розыгрыш")).toBe(`v1:ac:r:${auctionToken}`);
    expect(labels(last(calls)).flat()).not.toContain("🗑 Убрать розыгрыш");

    await next((history) => press(dataOf(last(history), "Розыгрыш")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:ar:${auctionToken}:42`);
    expect(asked.text).toContain("Неделя: 20.10.2026 18:00 — 27.10.2026 00:00");
    expect(asked.text).toContain("Например: 22.10.2026 18:00");

    // Момент вне недели бот отклоняет сам, без команды.
    await next((history) => answer(history, { text: "28.10.2026 18:00" }));
    expect(last(calls).text).toBe(
      "<b>Регистрация в розыгрыше должна закрыться раньше конца недели</b>",
    );
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    expect(auction.sent("scheduleAuction")).toEqual([]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));

    await next((history) => answer(history, { text: "22.10.2026 18:00" }));
    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: {
          auctionId,
          opId: expect.any(String),
          ...week,
          final: true,
          raffleClosesAt: moment,
        },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Регистрация в розыгрыше закроется 22 октября, чт, 18:00</b>",
    );
    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "Розыгрыш: регистрация до 22 октября, чт, 18:00.",
    );
    expect(labels(last(calls))).toContainEqual(["Розыгрыш"]);
    expect(labels(last(calls))).toContainEqual(["🗑 Убрать розыгрыш"]);

    // Вопрос называет текущий момент в том виде, в каком его вводят.
    await next((history) => press(dataOf(last(history), "Розыгрыш")));
    expect(question(calls).payload.text).toContain("Сейчас: 22.10.2026 18:00");
    await next((history) => press(dataOf(question(history).payload, "Отмена")));

    // Неделя с моментом после открытия торгов ставит «Розыгрыш» в корень
    // аукциона парой к «Пульту» (PER-605).
    await next(() => press(consoleData));
    await next((history) =>
      press(dataOf(last(history), "Открыть онлайн-неделю")),
    );
    await next((history) =>
      press(dataOf(last(history), "✔️ Да, открыть неделю")),
    );
    await next(() => press(rootData));
    expect(labels(last(calls))[1]).toEqual(["Пульт", "Розыгрыш"]);
  });

  it("keeps the moment over new dates and the final and names it when new dates cut it off", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true, raffleClosesAt: moment },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Вкл · Финал")));
    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));
    await bot.handleUpdate(
      answer(calls, { text: "20.10.2026 18:00 — 28.10.2026 00:00" }),
    );
    expect(
      auction.sent("scheduleAuction").map((command) => command.args),
    ).toEqual([
      expect.objectContaining({ final: false, raffleClosesAt: moment }),
      expect.objectContaining({
        closesAt: "2026-10-27T21:00:00Z",
        raffleClosesAt: moment,
      }),
    ]);

    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));
    await bot.handleUpdate(
      answer(calls, { text: "23.10.2026 18:00 — 28.10.2026 00:00" }),
    );
    expect(last(calls).text).toBe(
      "<b>Момент розыгрыша не помещается в новые сроки</b>\n\nСдвинь или убери его кнопкой «Розыгрыш» на пульте или задай сроки шире.",
    );
    expect(auction.state.week?.raffleClosesAt).toBe(moment);
  });

  it("removes the moment: the week goes without the raffle", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true, raffleClosesAt: moment },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    const remove = dataOf(last(calls), "🗑 Убрать розыгрыш");
    expect(remove).toBe(`v1:ac:rx:${auctionToken}`);
    await bot.handleUpdate(press(remove));

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: {
          auctionId,
          opId: expect.any(String),
          ...week,
          final: true,
          raffleClosesAt: undefined,
        },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Розыгрыш убран</b>\n\nНеделя пройдёт без него.",
    );
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("Розыгрыш: нет.");
    expect(labels(last(calls)).flat()).not.toContain("🗑 Убрать розыгрыш");

    // Неделя без момента открывается без розыгрыша, как раньше.
    await bot.handleUpdate(press(feedData));
    expect(labels(last(calls)).flat()).not.toContain("Розыгрыш");
  });
});

// PER-618: торги другого аукциона пульт называет до подтверждения, а отказ
// после «Да» — тоже называет аукцион.
describe("opening the week while another auction is trading", () => {
  const busy: AuctionSummaryView = {
    auctionId: "0190f2a0-0000-7000-8000-000000000021",
    stage: "prebidding",
    opensAt: "2026-10-05T15:00:00Z",
    closesAt: "2026-10-12T15:00:00Z",
    final: true,
  };
  const scheduled = () =>
    fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
      busy,
    });

  it("warns before the confirmation and offers no «Yes»", async () => {
    const auction = scheduled();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Открыть онлайн-неделю")));

    expect(last(calls).text).toBe(
      "<b>Торги уже идут у аукциона с онлайн-неделей с 5 октября, пн, 18:00 до 12 октября, пн, 18:00: открыть неделю можно, когда они закончатся</b>",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    expect(auction.sent("startPrebidding")).toEqual([]);
  });

  it("names the meetup of the trading auction when the bot knows it", async () => {
    const auction = scheduled();
    const parents = createAuctionParents();
    const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3400";
    parents.remember(busy.auctionId, meetupId);
    const dispatcher = createDispatcher(
      undefined,
      undefined,
      today,
      auction.port,
      auction.port,
      { auctions: auction.port, timeZone, now: () => now },
    );
    const withMeetup: Dispatcher = {
      execute: (request) =>
        request.intent === "view-meetup-extensions" &&
        request.meetupId === meetupId
          ? {
              kind: "meetup-card",
              meetup: {
                id: meetupId,
                author: identityId,
                title: "Осенняя сходка",
                description: "",
                venue: "",
                lifecycle: "planned",
                visibility: "visible",
                version: 1,
                materials: [],
              },
            }
          : dispatcher.execute(request),
    };
    const calls: RecordedCall[] = [];
    const { bot } = createHarness(
      identity("admin"),
      withMeetup,
      calls,
      undefined,
      "plain",
      today,
      {
        auction: auction.port,
        communityTimeZone: timeZone,
        auctionParents: parents,
      },
    );
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Торги уже идут у сходки «Осенняя сходка»: открыть неделю можно, когда они закончатся</b>",
    );
  });

  // Слот заняли между подтверждением и «Да»: отказ Auction называет аукцион.
  it("names the trading auction when the start is refused after «Yes»", async () => {
    const free = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const { bot, calls } = harness("admin", free);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    const yes = dataOf(last(calls), "✔️ Да, открыть неделю");

    const taken = scheduled();
    const after = harness("admin", taken, calls);
    await after.bot.init();
    await after.bot.handleUpdate(press(yes));

    expect(taken.sent("startPrebidding")).toHaveLength(1);
    expect(last(calls).text).toBe(
      "<b>Торги уже идут у аукциона с онлайн-неделей с 5 октября, пн, 18:00 до 12 октября, пн, 18:00: открыть неделю можно, когда они закончатся</b>",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
  });
});

// PER-618: строка розыгрыша пульта идёт по статусу после закрытия регистрации.
describe("the raffle line of the console", () => {
  const raffleWeek = {
    opensAt: "2026-10-05T15:00:00Z",
    closesAt: "2026-10-12T15:00:00Z",
    final: true,
    windows: [],
    raffleClosesAt: "2026-10-05T16:12:00Z",
  };
  const raffle = (extra: Partial<RaffleView>): RaffleView => ({
    auctionId,
    status: "open",
    closesAt: raffleWeek.raffleClosesAt,
    commitment: "ab".repeat(32),
    beaconRound: 1,
    registered: false,
    tickets: [],
    ...extra,
  });

  it.each([
    [undefined, "Розыгрыш: регистрация до 5 октября, пн, 19:12."],
    [
      raffle({ status: "awaiting-beacon", tickets: [{ number: 1 }] }),
      "Розыгрыш: регистрация закрыта, жеребьёвка идёт.",
    ],
    [
      raffle({ status: "closing" }),
      "Розыгрыш: регистрация закрыта, жеребьёвка идёт.",
    ],
    [
      raffle({
        status: "drawn",
        tickets: [{ number: 1, displayName: "Сова*" }, { number: 2 }],
        reveal: { seed: "cd".repeat(32), winningTicket: 1 },
      }),
      "Розыгрыш: выиграл билет №1 — Сова*, билетов: 2.",
    ],
    [
      raffle({
        status: "drawn",
        tickets: [{ number: 1 }, { number: 2 }],
        reveal: { seed: "cd".repeat(32), winningTicket: 2 },
      }),
      "Розыгрыш: выиграл билет №2, билетов: 2.",
    ],
    [
      raffle({ status: "no-tickets" }),
      "Розыгрыш: не состоялся, никто не зарегистрировался.",
    ],
  ] as const)("shows the raffle %# by its status", async (read, line) => {
    const auction = fakeAuction({
      status: "prebidding",
      week: raffleWeek,
      ...(read === undefined ? {} : { consoleRaffle: read }),
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain(line);
  });

  it("keeps the drawn raffle on the console of a finished auction", async () => {
    const auction = fakeAuction({
      status: "finished",
      week: raffleWeek,
      consoleRaffle: raffle({
        status: "drawn",
        tickets: [{ number: 1, displayName: "Сова*" }],
        reveal: { seed: "cd".repeat(32), winningTicket: 1 },
      }),
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain(
      "Аукцион завершён.\nРозыгрыш: выиграл билет №1 — Сова*, билетов: 1.",
    );
  });
});

describe("opening the online week", () => {
  it("opens the week only after the confirmation and sends the same key on a repeated press", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced, unpriced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Открыть онлайн-неделю")));
    const confirm = last(calls);
    expect(plain(confirm)).toContain("Онлайн-неделя");
    // Подтверждение называет, сколько лотов откроется и сколько останется
    // без торгов.
    expect(plain(confirm)).toContain(
      "К ставкам сразу откроются: 1 лот. Торги закроются 27 октября, вт, 00:00.",
    );
    expect(plain(confirm)).toContain(
      "Без цены и шага останутся без торгов: 1 лот.",
    );
    expect(labels(confirm)).toEqual([["✔️ Да, открыть неделю", "✖️ Нет"]]);
    expect(dataOf(confirm, "✖️ Нет")).toBe(consoleData);
    expect(auction.sent("startPrebidding")).toEqual([]);

    const yes = dataOf(confirm, "✔️ Да, открыть неделю");
    await bot.handleUpdate(press(yes));

    expect(auction.state.status).toBe("prebidding");
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя открыта</b>\n\nЛоты принимают ставки.",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("Идут онлайн-торги до");

    await bot.handleUpdate(press(yes));

    const [first, second] = auction.sent("startPrebidding");
    expect(second?.args).toEqual(first?.args);
    expect(auction.sent("startPrebidding")).toHaveLength(2);
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя открыта</b>\n\nЛоты принимают ставки.",
    );
  });

  it("shows a refusal of an already opened auction as an open week outcome, not as an error", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    const firstYes = dataOf(last(calls), "✔️ Да, открыть неделю");
    // Второе подтверждение, полученное до открытия, несёт свой ключ.
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    const secondYes = dataOf(last(calls), "✔️ Да, открыть неделю");
    expect(secondYes).not.toBe(firstYes);

    await bot.handleUpdate(press(firstYes));
    await bot.handleUpdate(press(secondYes));

    expect(auction.sent("startPrebidding")).toHaveLength(2);
    const screen = plain(last(calls));
    expect(last(calls).text).toBe("<b>Неделя уже открыта</b>");
    expect(screen).not.toContain("Не получилось");
    // Старая кнопка открытия на открытом аукционе подтверждения не даёт.
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    expect(last(calls).text).toBe("<b>Неделя уже открыта</b>");
    expect(labels(last(calls))).not.toContainEqual(["✔️ Да, открыть неделю"]);
  });

  it("names an ended week on an outcome screen instead of a confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: {
        opensAt: "2026-09-28T15:00:00Z",
        closesAt: "2026-10-05T21:00:00Z",
        final: true,
        windows: [],
      },
      lots: [priced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Конец недели уже прошёл</b>\n\nЗадай новые сроки.",
    );
    expect(labels(last(calls))).not.toContainEqual(["✔️ Да, открыть неделю"]);
  });

  it("names a registry without priced lots on an outcome screen instead of a confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [unpriced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Нет лотов с ценой и шагом</b>\n\nОткрывать нечего.",
    );
    expect(labels(last(calls))).not.toContainEqual(["✔️ Да, открыть неделю"]);
    expect(auction.sent("startPrebidding")).toEqual([]);
  });
});

describe("final selection", () => {
  it("offers no selection for a week without a final but lets the old mark go", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: false },
      lots: [vase, mug],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(labels(last(calls))).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["Снять из финала · Кружка"],
      ["‹ Аукцион"],
    ]);
  });

  it("shows the refusal of a selection without a final as an outcome screen of the console", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
      notApplicable: true,
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:ac:s:${auctionToken}:${uuidToToken(vaseId)}:0`),
    );

    const screen = plain(last(calls));
    expect(last(calls).text).toBe(
      "<b>У недели нет финала</b>\n\nОтбирать лоты некуда.",
    );
    expect(screen).not.toContain("Лот отмечен для финала");
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
  });

  it("marks a held lot as a finalist without buttons", async () => {
    const held: ConsoleLot = {
      lot: {
        ...trading(vaseId, "Ваза", 120_000),
        status: { kind: "held", currentPrice: rub(120_000) },
      },
      bidCount: 4,
      uniqueParticipantCount: 3,
      markedForFinal: true,
      overdue: false,
    };
    const auction = fakeAuction({
      status: "settling",
      week: { ...week, final: true },
      lots: [held],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain(
      "• Ваза — 1 200 ₽ · 4 ставки · 3 уч. · в финал",
    );
    expect(labels(last(calls))).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["‹ Аукцион"],
    ]);
  });
});

describe("discarding the auction", () => {
  it("offers the discard while the week is not open and discards only after the confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "🗑 Удалить аукцион")));
    const confirm = last(calls);
    expect(plain(confirm)).toContain("Удалить аукцион?");
    expect(plain(confirm)).toContain("Из аукциона уйдут: 1 лот.");
    expect(plain(confirm)).toContain(
      "Лоты и сроки пропадут. Включить аукцион у сходки можно заново.",
    );
    expect(labels(confirm)).toEqual([["✔️ Да, удалить", "✖️ Нет"]]);
    expect(dataOf(confirm, "✖️ Нет")).toBe(consoleData);
    expect(auction.sent("discardAuction")).toEqual([]);

    const yes = dataOf(confirm, "✔️ Да, удалить");
    await bot.handleUpdate(press(yes));
    expect(auction.state.discarded).toBe(true);
    expect(last(calls).text).toBe(
      "<b>Аукцион удалён</b>\n\nВключить его у сходки можно заново.",
    );
    expect(labels(last(calls))).toEqual([["‹ Сходки"]]);

    // Повторное «Да» несёт тот же ключ: Auction примет его как повтор.
    await bot.handleUpdate(press(yes));
    const [first, second] = auction.sent("discardAuction");
    expect(second?.args).toEqual(first?.args);
  });

  it("offers no discard once the week is open and names it for an old button", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(JSON.stringify(last(calls))).not.toContain("🗑 Удалить аукцион");

    await bot.handleUpdate(press(`v1:ac:x:${auctionToken}`));
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя уже открыта</b>\n\nУдалить аукцион нельзя.",
    );
    expect(auction.sent("discardAuction")).toEqual([]);
  });

  it("refuses an old discard button of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot, calls } = harness("member", auction);
    await bot.init();

    for (const data of [
      `v1:ac:x:${auctionToken}`,
      `v1:ac:z:${auctionToken}:${uuidToToken(vaseId)}`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(last(calls).text).toContain("Это действие тебе недоступно.");
    }
    expect(auction.commands).toEqual([]);
  });
});

describe("final of the auctioneer", () => {
  const leaderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ee";
  const finalist = (
    lotId: string,
    title: string,
    price: number,
    leader?: string,
  ): ConsoleLot => ({
    lot: {
      ...trading(lotId, title, price),
      status: {
        kind: "held",
        currentPrice: rub(price),
        ...(leader === undefined ? {} : { leaderId: leader }),
      },
    },
    bidCount: 2,
    uniqueParticipantCount: 1,
    markedForFinal: true,
    overdue: false,
  });
  const frozen = () =>
    fakeAuction({
      status: "lineup-frozen",
      week: { ...week, final: true },
      lots: [
        finalist(vaseId, "Ваза", 120_000, leaderId),
        finalist(mugId, "Кружка", 50_000),
      ],
      lineup: [vaseId, mugId],
      bids: [
        { amount: rub(120_000), participantId: leaderId },
        { amount: rub(110_000), participantId: "someone" },
      ],
      names: { [leaderId]: "Бэтмен" },
    });

  it("runs a lot from its opening to the sale over restarts of the bot", async () => {
    const auction = frozen();
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    expect(plain(last(calls))).toContain(
      "Состав финала объявлен.\n\n1. Ваза — 1 200 ₽\n2. Кружка — 500 ₽",
    );
    expect(labels(last(calls))).toEqual([
      ["Начать финал"],
      ["Обновить"],
      ["‹ Аукцион"],
    ]);

    await next((history) => press(dataOf(last(history), "Начать финал")));
    expect(last(calls).text).toBe("<b>Финал начат</b>\n\nОткрой первый лот.");
    // Первый лот открывается прямо с исхода (PER-639), без захода в пульт.
    expect(labels(last(calls))).toEqual([["Открыть первый лот"], ["‹ Пульт"]]);

    await next((history) => press(dataOf(last(history), "Открыть первый лот")));
    const panel = last(calls);
    expect(plain(panel)).toContain("1. Ваза — 1 200 ₽ · торгуется");
    expect(plain(panel)).toContain(
      "Сейчас: Ваза.\nЦена: 1 200 ₽, следующая: 1 300 ₽.\nЛидер: Бэтмен.\nПоследние ставки:\n1 200 ₽ — Бэтмен\n1 100 ₽",
    );
    expect(labels(panel)).toEqual([
      ["Поднять цену"],
      ["Продать"],
      ["Обновить"],
      ["‹ Аукцион"],
    ]);

    // Ask не выше текущей цены Auction отвергает, и бот называет порог.
    await next((history) => press(dataOf(last(history), "Поднять цену")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:fa:${auctionToken}:0:42`);
    expect(spaced(asked.text ?? "")).toContain(
      "Лот: Ваза\nСейчас следующая цена: 1 300 ₽",
    );
    await next((history) => answer(history, { text: "1000" }));
    expect(spaced(last(calls).text ?? "")).toBe(
      "<b>Новая цена должна быть выше 1 200 ₽</b>",
    );
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) => answer(history, { text: "1 500" }));
    expect(auction.sent("advanceAsk").map((each) => each.args)).toEqual([
      {
        auctionId,
        lotId: vaseId,
        opId: expect.any(String),
        newAsk: rub(100_000),
      },
      {
        auctionId,
        lotId: vaseId,
        opId: expect.any(String),
        newAsk: rub(150_000),
      },
    ]);
    expect(plain(last(calls))).toContain("Цена: 1 200 ₽, следующая: 1 500 ₽.");

    await next((history) => press(dataOf(last(history), "Продать")));
    const confirm = last(calls);
    expect(plain(confirm)).toBe(
      "Закрыть лот «Ваза»?\n\nПродажа за 1 200 ₽, покупатель — Бэтмен.\n\nОтменить закрытие нельзя: торги по лоту закончатся.",
    );
    expect(labels(confirm)).toEqual([["✔️ Да, продать", "✖️ Нет"]]);
    expect(dataOf(confirm, "✖️ Нет")).toBe(consoleData);
    expect(auction.sent("closeLot")).toEqual([]);

    // Продажа — свой экран исхода; пульт ведущего за «‹ Пульт».
    const sold =
      "<b>Лот продан</b>\n\n<b>Ваза</b>\n\nЦена: 1 200 ₽, покупатель — Бэтмен.";
    const yes = dataOf(confirm, "✔️ Да, продать");
    await next(() => press(yes));
    expect(spaced(last(calls).text ?? "")).toBe(sold);
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    expect(plain(last(calls))).toContain("1. Ваза — продан за 1 200 ₽");
    expect(labels(last(calls))).toEqual([
      ["Открыть следующий лот"],
      ["Обновить"],
      ["‹ Аукцион"],
    ]);

    // Повторное «Да» несёт тот же ключ: Auction отвечает исходной продажей,
    // и второй продажи нет.
    await next(() => press(yes));
    const [first, second] = auction.sent("closeLot");
    expect(second?.args).toEqual(first?.args);
    expect(auction.state.closures.size).toBe(1);
    expect(spaced(last(calls).text ?? "")).toBe(sold);
  });

  // Лот, выбывший до своей очереди, открытием не считается: первый лот
  // финала ещё не открывали.
  it("keeps the first-lot button when a lot of the lineup is gone before the start", async () => {
    const auction = frozen();
    auction.state.lots = auction.state.lots.map((each) =>
      each.lot.lotId === mugId
        ? { ...each, lot: { ...each.lot, status: { kind: "withdrawn" } } }
        : each,
    );
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:g:${auctionToken}`));

    expect(labels(last(calls))).toEqual([["Открыть первый лот"], ["‹ Пульт"]]);
  });

  // Повтор «Начать финал», когда лот уже открыт, — тот же исход, но без
  // «Открыть первый лот»: первый лот уже открывали (PER-639).
  it("drops the first-lot button on a repeated start of a running final", async () => {
    const auction = frozen();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:g:${auctionToken}`));
    await bot.handleUpdate(press(`v1:ac:n:${auctionToken}`));
    await bot.handleUpdate(press(`v1:ac:g:${auctionToken}`));

    expect(last(calls).text).toBe("<b>Финал начат</b>\n\nОткрой первый лот.");
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
  });

  it("confirms the sale again instead of closing when the hall bid after the confirmation", async () => {
    const auction = frozen();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:g:${auctionToken}`));
    await bot.handleUpdate(press(`v1:ac:n:${auctionToken}`));
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Продать")));
    const yes = dataOf(last(calls), "✔️ Да, продать");

    // Зал перебил, пока подтверждение было открыто.
    auction.state.lots = auction.state.lots.map((each) =>
      each.lot.lotId === vaseId && each.lot.status.kind === "trading"
        ? {
            ...each,
            lot: {
              ...each.lot,
              status: { ...each.lot.status, currentPrice: rub(130_000) },
            },
          }
        : each,
    );
    await bot.handleUpdate(press(yes));

    expect(auction.sent("closeLot")).toEqual([]);
    expect(plain(last(calls))).toContain(
      "Лот изменился, пока было открыто подтверждение. Проверь заново.\n\nПродажа за 1 300 ₽, покупатель — Бэтмен.",
    );
    expect(dataOf(last(calls), "✔️ Да, продать")).not.toBe(yes);
  });

  // Последний лот состава завершает аукцион (PER-639): исход говорит об этом
  // со счётом продаж всего аукциона, а «Итоги» ведут в пульт.
  it("says the auction is finished when the last lot of the lineup is sold", async () => {
    const soldVase = finalist(vaseId, "Ваза", 120_000);
    const auction = fakeAuction({
      status: "final",
      lots: [
        {
          ...soldVase,
          lot: {
            ...soldVase.lot,
            status: { kind: "sold", winnerId: "someone", price: rub(120_000) },
          },
        },
        finalist(mugId, "Кружка", 50_000, leaderId),
      ],
      lineup: [vaseId, mugId],
      bids: [{ amount: rub(50_000), participantId: leaderId }],
      names: { [leaderId]: "Бэтмен" },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Открыть следующий лот")));
    await bot.handleUpdate(press(dataOf(last(calls), "Продать")));
    await bot.handleUpdate(press(dataOf(last(calls), "✔️ Да, продать")));

    expect(spaced(last(calls).text ?? "")).toBe(
      "<b>Лот продан</b>\n\n<b>Кружка</b>\n\nЦена: 500 ₽, покупатель — Бэтмен. Это был последний лот — аукцион завершён: 2 лота, 1 700 ₽.",
    );
    expect(labels(last(calls))).toEqual([["Итоги"], ["‹ Аукцион"]]);
    expect(dataOf(last(calls), "Итоги")).toBe(consoleData);
  });

  it("closes a lot without bids without a sale", async () => {
    const auction = fakeAuction({
      status: "final",
      lots: [finalist(mugId, "Кружка", 50_000)],
      lineup: [mugId],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Открыть следующий лот")));
    expect(plain(last(calls))).toContain("Ставок нет.");

    await bot.handleUpdate(press(dataOf(last(calls), "Закрыть без продажи")));
    expect(plain(last(calls))).toContain(
      "Ставок нет: лот закроется без продажи.",
    );
    await bot.handleUpdate(press(dataOf(last(calls), "✔️ Да, закрыть")));

    // Лот единственный в составе, то есть последний: исход говорит, что
    // аукцион завершён, и «Итоги» ведут в пульт (PER-639).
    expect(last(calls).text).toBe(
      "<b>Лот закрыт без продажи</b>\n\n<b>Кружка</b>\n\nСтавок не было. Это был последний лот — аукцион завершён, продаж нет.",
    );
    expect(dataOf(last(calls), "‹ Аукцион")).toBeDefined();
    await bot.handleUpdate(press(dataOf(last(calls), "Итоги")));
    expect(plain(last(calls))).toContain("1. Кружка — не продан");
  });

  it("names a lot still trading instead of opening a second one", async () => {
    const auction = frozen();
    auction.state.status = "final";
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:n:${auctionToken}`));
    await bot.handleUpdate(press(`v1:ac:n:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Лот ещё торгуется</b>\n\nЗакрой его, прежде чем открыть следующий.",
    );
  });

  it("refuses the final buttons of someone who is not an administrator before Auction is asked", async () => {
    const auction = frozen();
    const { bot, calls } = harness("member", auction);
    await bot.init();

    for (const data of [
      `v1:ac:g:${auctionToken}`,
      `v1:ac:n:${auctionToken}`,
      `v1:ac:a:${auctionToken}:0`,
      `v1:ac:c:${auctionToken}:0`,
      `v1:ac:k:${auctionToken}:0:${auctionToken}:x`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(last(calls).text).toContain("Это действие тебе недоступно.");
    }
    expect(auction.commands).toEqual([]);
  });
});

describe("final lineup", () => {
  // Кнопка лота на экране порядка: название и цена с неразрывными пробелами.
  const lotData = (screen: Sent, title: string): string => {
    const found = screen.reply_markup?.inline_keyboard
      .flat()
      .find((button) => button.text.startsWith(`${title} — `))?.callback_data;
    if (found === undefined) throw new Error(`no lot button "${title}"`);
    return found;
  };
  const spacedLabels = (screen: Sent): string[][] =>
    labels(screen).map((row) => row.map(spaced));
  const lampId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
  const bookId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3f";
  const held = (lotId: string, title: string, price: number): ConsoleLot => ({
    lot: {
      ...trading(lotId, title, price),
      status: { kind: "held", currentPrice: rub(price) },
    },
    bidCount: 1,
    uniqueParticipantCount: 1,
    markedForFinal: true,
    overdue: false,
  });
  const unsold = (lotId: string, title: string): ConsoleLot => ({
    lot: { ...trading(lotId, title, 10_000), status: { kind: "unsold" } },
    bidCount: 0,
    uniqueParticipantCount: 0,
    markedForFinal: false,
    overdue: false,
  });
  // Перерыв: три удержанных лота и один, закрытый без продажи.
  const onBreak = (
    options: {
      freezeFailures?: number;
      heldByAuction?: readonly string[];
    } = {},
  ) =>
    fakeAuction({
      status: "break",
      week: { ...week, final: true },
      lots: [
        held(vaseId, "Ваза", 120_000),
        held(mugId, "Кружка", 50_000),
        held(lampId, "Лампа", 80_000),
        unsold(bookId, "Книга"),
      ],
      ...options,
    });

  it("announces the lineup in the order the administrator picks, then the final starts and sells a lot, over restarts of the bot", async () => {
    const auction = onBreak();
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    expect(plain(last(calls))).toContain(
      "Онлайн-торги закончились: перерыв перед финалом.\nВ финал отмечены: 3 лота.",
    );
    expect(labels(last(calls))).toContainEqual(["Объявить состав финала"]);

    await next((history) =>
      press(dataOf(last(history), "Объявить состав финала")),
    );
    expect(plain(last(calls))).toBe("Порядок финала\n\nКто выходит первым?");
    expect(spacedLabels(last(calls))).toEqual([
      ["Все — как в списке"],
      ["Ваза — 1 200 ₽"],
      ["Кружка — 500 ₽"],
      ["Лампа — 800 ₽"],
      ["‹ Пульт"],
    ]);

    await next((history) => press(lotData(last(history), "Кружка")));
    expect(plain(last(calls))).toBe(
      "Порядок финала\n\nУже по порядку:\n1. Кружка — 500 ₽\n\nКто выходит следующим?",
    );
    expect(spacedLabels(last(calls))).toEqual([
      ["Остальные — как в списке"],
      ["Заново"],
      ["Ваза — 1 200 ₽"],
      ["Лампа — 800 ₽"],
      ["‹ Пульт"],
    ]);

    // Предпоследний выбор дозаполняет порядок: последний лот встаёт в конец.
    await next((history) => press(lotData(last(history), "Лампа")));
    const confirm = last(calls);
    expect(plain(confirm)).toBe(
      "Объявить состав финала?\n\n1. Кружка — 500 ₽\n2. Лампа — 800 ₽\n3. Ваза — 1 200 ₽\n\nОтменить объявление нельзя: состав и порядок финала после него не меняются.",
    );
    expect(labels(confirm)).toEqual([["✔️ Да, объявить", "✖️ Нет"]]);
    expect(dataOf(confirm, "✖️ Нет")).toBe(consoleData);
    expect(auction.sent("freezeFinalLineup")).toEqual([]);

    const yes = dataOf(confirm, "✔️ Да, объявить");
    await next(() => press(yes));
    expect(auction.sent("freezeFinalLineup").map((each) => each.args)).toEqual([
      {
        auctionId,
        opId: expect.any(String),
        lotIds: [mugId, lampId, vaseId],
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Состав финала объявлен</b>\n\nНачать финал — в пульте.",
    );
    expect(spacedLabels(last(calls))).toEqual([["‹ Пульт"]]);

    // Повторное «Да» застаёт состав объявленным и к Auction не идёт.
    await next(() => press(yes));
    expect(auction.sent("freezeFinalLineup")).toHaveLength(1);
    expect(last(calls).text).toBe(
      "<b>Состав финала объявлен</b>\n\nНачать финал — в пульте.",
    );

    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "Состав финала объявлен.\n\n1. Кружка — 500 ₽\n2. Лампа — 800 ₽\n3. Ваза — 1 200 ₽",
    );
    await next((history) => press(dataOf(last(history), "Начать финал")));
    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    await next((history) =>
      press(dataOf(last(history), "Открыть следующий лот")),
    );
    expect(plain(last(calls))).toContain("1. Кружка — 500 ₽ · торгуется");
    await next((history) =>
      press(dataOf(last(history), "Закрыть без продажи")),
    );
    await next((history) => press(dataOf(last(history), "✔️ Да, закрыть")));
    expect(last(calls).text).toBe(
      "<b>Лот закрыт без продажи</b>\n\n<b>Кружка</b>\n\nСтавок не было.",
    );
  });

  it("fills the rest of the order as listed and starts the pick over", async () => {
    const auction = onBreak();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:l:${auctionToken}`));
    await bot.handleUpdate(press(lotData(last(calls), "Лампа")));
    await bot.handleUpdate(press(dataOf(last(calls), "Заново")));
    expect(plain(last(calls))).toBe("Порядок финала\n\nКто выходит первым?");

    await bot.handleUpdate(press(lotData(last(calls), "Лампа")));
    await bot.handleUpdate(
      press(dataOf(last(calls), "Остальные — как в списке")),
    );
    expect(plain(last(calls))).toContain(
      "1. Лампа — 800 ₽\n2. Ваза — 1 200 ₽\n3. Кружка — 500 ₽",
    );
  });

  it("offers no announcement without marked lots and names it for an old button", async () => {
    const auction = fakeAuction({
      status: "break",
      week: { ...week, final: true },
      lots: [unsold(bookId, "Книга")],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(plain(last(calls))).toContain(
      "В финал не отмечено ни одного лота. Объявлять нечего.",
    );
    expect(labels(last(calls)).flat()).not.toContain("Объявить состав финала");

    await bot.handleUpdate(press(`v1:ac:l:${auctionToken}`));
    expect(last(calls).text).toBe(
      "<b>В финал не отмечено ни одного лота</b>\n\nОбъявлять нечего.",
    );
    expect(auction.sent("freezeFinalLineup")).toEqual([]);
  });

  it("starts the pick over instead of announcing when a held lot is sold after the confirmation", async () => {
    const auction = onBreak();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:l:${auctionToken}`));
    await bot.handleUpdate(press(dataOf(last(calls), "Все — как в списке")));
    const yes = dataOf(last(calls), "✔️ Да, объявить");

    // Удержанный лот продан в перерыве, пока подтверждение было открыто.
    auction.state.lots = auction.state.lots.map((each) =>
      each.lot.lotId === mugId
        ? {
            ...each,
            markedForFinal: false,
            lot: {
              ...each.lot,
              status: {
                kind: "sold",
                winnerId: "someone",
                price: rub(50_000),
              },
            },
          }
        : each,
    );
    await bot.handleUpdate(press(yes));

    expect(auction.sent("freezeFinalLineup")).toEqual([]);
    expect(plain(last(calls))).toBe(
      "Порядок финала\n\nОтметки финала изменились, пока выбирался порядок. Выбери заново.\n\nКто выходит первым?",
    );
    expect(spacedLabels(last(calls))).toEqual([
      ["Все — как в списке"],
      ["Ваза — 1 200 ₽"],
      ["Лампа — 800 ₽"],
      ["‹ Пульт"],
    ]);
  });

  it("starts the pick over when Auction holds other lots than the console read", async () => {
    const auction = onBreak({ heldByAuction: [vaseId, mugId] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:l:${auctionToken}`));
    await bot.handleUpdate(press(dataOf(last(calls), "Все — как в списке")));
    await bot.handleUpdate(press(dataOf(last(calls), "✔️ Да, объявить")));

    expect(auction.sent("freezeFinalLineup")).toHaveLength(1);
    expect(auction.state.status).toBe("break");
    expect(plain(last(calls))).toContain(
      "Отметки финала изменились, пока выбирался порядок. Выбери заново.",
    );
  });

  it("retries the same order when Auction does not know the held lots yet", async () => {
    const auction = onBreak({ freezeFailures: 1 });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:l:${auctionToken}`));
    await bot.handleUpdate(press(dataOf(last(calls), "Все — как в списке")));
    const yes = dataOf(last(calls), "✔️ Да, объявить");
    await bot.handleUpdate(press(yes));
    expect(dataOf(last(calls), "Повторить")).toBe(yes);

    await bot.handleUpdate(press(dataOf(last(calls), "Повторить")));
    expect(auction.state.status).toBe("lineup-frozen");
    expect(auction.state.lineup?.order).toEqual([vaseId, mugId, lampId]);
    expect(last(calls).text).toBe(
      "<b>Состав финала объявлен</b>\n\nНачать финал — в пульте.",
    );
  });

  it("names a lineup announced elsewhere instead of announcing again", async () => {
    const auction = onBreak();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:l:${auctionToken}`));
    await bot.handleUpdate(press(dataOf(last(calls), "Все — как в списке")));
    const yes = dataOf(last(calls), "✔️ Да, объявить");
    auction.state.status = "lineup-frozen";
    auction.state.lineup = { order: [lampId, mugId, vaseId] };

    await bot.handleUpdate(press(yes));
    expect(auction.sent("freezeFinalLineup")).toEqual([]);
    expect(last(calls).text).toBe(
      "<b>Состав финала объявлен</b>\n\nНачать финал — в пульте.",
    );
  });

  it("refuses the lineup buttons of someone who is not an administrator before Auction is asked", async () => {
    const auction = onBreak();
    const { bot, calls } = harness("member", auction);
    await bot.init();

    for (const data of [
      `v1:ac:l:${auctionToken}`,
      `v1:ac:lo:${auctionToken}:abcde:1`,
      `v1:ac:ly:${auctionToken}:abcde:012`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(last(calls).text).toContain("Это действие тебе недоступно.");
    }
    expect(auction.commands).toEqual([]);
  });
});

describe("happy hours", () => {
  const evening = {
    from: "2026-10-21T15:00:00Z",
    until: "2026-10-21T18:00:00Z",
    step: rub(5_000),
  };

  it("adds a window with every lot, takes a lot out, keeps the last one and survives a restart at every step", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced, unpriced],
    });
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    await next((history) => press(dataOf(last(history), "Счастливые часы")));
    expect(plain(last(calls))).toContain("Окон пока нет.");
    expect(labels(last(calls))).toEqual([["Добавить окно"], ["‹ Пульт"]]);

    await next((history) => press(dataOf(last(history), "Добавить окно")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:ah:${auctionToken}:42`);
    expect(asked.text).toContain("Неделя: 20.10.2026 18:00 — 27.10.2026 00:00");
    expect(asked.text).toContain(
      "Например: 21.10.2026 18:00 — 21.10.2026 21:00, 50",
    );

    // Окно вне недели отклоняет Auction; пульт называет сроки недели.
    await next((history) =>
      answer(history, { text: "28.10.2026 18:00 — 28.10.2026 21:00, 50" }),
    );
    expect(last(calls).text).toBe(
      "<b>Окно должно лежать внутри онлайн-недели: 20.10.2026 18:00 — 27.10.2026 00:00</b>",
    );
    expect(labels(last(calls))).toEqual([
      ["Ввести заново"],
      ["‹ Счастливые часы"],
    ]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) =>
      answer(history, { text: "21.10.2026 18:00 — 21.10.2026 21:00, 50" }),
    );

    expect(auction.sent("scheduleAuction").at(-1)?.args).toEqual({
      auctionId,
      opId: expect.any(String),
      ...week,
      final: true,
      windows: [{ ...evening, lotIds: [vaseId, mugId] }],
    });
    expect(last(calls).text).toBe(
      "<b>Окно 1 сохранено</b>\n\nВ нём все лоты аукциона — лишние сними на экране окна.",
    );
    await next((history) => press(dataOf(last(history), "‹ Счастливые часы")));
    expect(plain(last(calls))).toContain(
      "1. с 21 октября, ср, 18:00 до 21 октября, ср, 21:00, шаг 50 ₽ · лотов 2 из 2",
    );
    expect(labels(last(calls))).toEqual([
      ["Окно 1"],
      ["Добавить окно"],
      ["‹ Пульт"],
    ]);

    await next((history) => press(dataOf(last(history), "Окно 1")));
    expect(labels(last(calls))).toEqual([
      ["Вкл · Ваза"],
      ["Вкл · Кружка"],
      ["🗑 Удалить окно"],
      ["‹ Счастливые часы"],
    ]);
    await next((history) => press(dataOf(last(history), "Вкл · Кружка")));
    expect(toasts(calls).at(-1)).toBe("Лот убран из окна.");
    expect(auction.state.week?.windows).toEqual([
      { ...evening, lotIds: [vaseId] },
    ]);
    expect(labels(last(calls))).toEqual([
      ["Вкл · Ваза"],
      ["Выкл · Кружка"],
      ["🗑 Удалить окно"],
      ["‹ Счастливые часы"],
    ]);

    const commands = auction.sent("scheduleAuction").length;
    await next((history) => press(dataOf(last(history), "Вкл · Ваза")));
    expect(last(calls).text).toBe(
      "<b>Это последний лот окна 1</b>\n\nОкна без лотов не бывает — удали окно целиком.",
    );
    expect(auction.sent("scheduleAuction")).toHaveLength(commands);

    await next(() => press(consoleData));
    expect(plain(last(calls))).toContain("Счастливые часы: 1 окно.");
  });

  it("names the window that new dates cut off and keeps it", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: {
        ...week,
        final: true,
        windows: [{ ...evening, lotIds: [vaseId] }],
      },
      lots: [priced],
    });
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    await next((history) => press(dataOf(last(history), "Сроки недели")));
    await next((history) =>
      answer(history, { text: "20.10.2026 18:00 — 21.10.2026 19:00" }),
    );

    expect(auction.sent("scheduleAuction").at(-1)?.args).toMatchObject({
      windows: [{ ...evening, lotIds: [vaseId] }],
    });
    expect(last(calls).text).toBe(
      "<b>Окно 1 счастливых часов не помещается в новые сроки</b>\n\nУдали его или задай сроки шире.",
    );
    expect(auction.state.week?.closesAt).toBe(week.closesAt);
  });

  it("removes a window from its screen", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: {
        ...week,
        final: true,
        windows: [{ ...evening, lotIds: [vaseId] }],
      },
      lots: [priced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Счастливые часы")));
    await bot.handleUpdate(press(dataOf(last(calls), "Окно 1")));
    await bot.handleUpdate(press(dataOf(last(calls), "🗑 Удалить окно")));

    expect(last(calls).text).toBe("<b>Окно 1 удалено</b>");
    expect(auction.state.week?.windows).toEqual([]);
  });

  it("shows the windows of an opened week without changing them", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: {
        ...week,
        final: true,
        windows: [{ ...evening, lotIds: [vaseId] }],
      },
      lots: [vase, mug],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));
    expect(plain(last(calls))).toContain("Счастливые часы: 1 окно.");
    await bot.handleUpdate(press(dataOf(last(calls), "Счастливые часы")));
    expect(plain(last(calls))).toContain("лотов 1 из 2");
    expect(labels(last(calls))).toEqual([["Окно 1"], ["‹ Пульт"]]);
    // Окно открывается только для чтения: переключателей и удаления нет.
    await bot.handleUpdate(press(dataOf(last(calls), "Окно 1")));
    expect(plain(last(calls))).toContain("• Ваза");
    expect(labels(last(calls))).toEqual([["‹ Счастливые часы"]]);
  });
});
