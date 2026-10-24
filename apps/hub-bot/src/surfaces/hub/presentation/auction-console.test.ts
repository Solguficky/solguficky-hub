import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  type HarnessOptions,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import {
  type AccessRight,
  type AuctionSummaryView,
  encodeAuctionCallback,
  type LotHistoryEntryView,
  type LotView,
  type Money,
  type RaffleView,
} from "../../../auction-ui/index.js";
import type {
  AuctionWatches,
  AuctionWatchState,
} from "../../../core/auction/watch.js";
import {
  type Clock,
  createEditLimiter,
  type EditLimiter,
} from "../../../core/bot/edit-limiter.js";
import {
  createDispatcher,
  type Dispatcher,
} from "../application/dispatcher.js";
import type {
  AuctionConsoleView,
  ConsoleAuctionStatus,
  ConsoleLot,
  Invoice,
  InvoiceMark,
  LotSet,
} from "../application/types.js";
import type {
  AuctionConsoles,
  AuctionScreens,
  AuctionVisibilityResult,
  AuctionWeekConfig,
  ConsoleReadResult,
  DayLotStatistics,
  FinalistResult,
  FinalTimeResult,
  FloorBid,
  LaunchStepWindowResult,
  LotAdministration,
  LotClosure,
  MeetupAuctions,
  PaymentInstructionsResult,
  RemovalTarget,
  SaveLotSetResult,
} from "../auction/port.js";
import type { IdentityResolver } from "../identity/port.js";
import { createAuctionParents } from "./auction-parents.js";
import { uuidToToken } from "./meetup-deep-link.js";
import { type CallbackAction, parseCallback } from "./parse-callback.js";

// Пульт аукциона администратора в боте хаба (PER-320): вход из ленты, сроки
// недели и финал, открытие недели через подтверждение, отметка лотов для
// финала и просроченные лоты. Auction подменён одним состоянием на чтение
// пульта и его команды; бот пересоздаётся там, где проверяется рестарт.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const auctionToken = uuidToToken(auctionId);
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const vaseId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const mugId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
// Счета проданных лотов (PER-321): UUIDv5 от ставки продажи.
const vaseInvoiceId = "5b0d3c1e-8a2f-5c4d-9e6f-1a2b3c4d5e6f";
const mugInvoiceId = "5b0d3c1e-8a2f-5c4d-9e6f-1a2b3c4d5e70";
const timeZone = "Europe/Moscow";
const today = () => ({ year: 2026, month: 10, day: 6 });
// Часы бота в тестах: 6 октября 2026 года, 12:00 по Москве.
const now = new Date("2026-10-06T09:00:00Z");

const consoleData = `v1:ac:v:${auctionToken}`;

// Права части набора `admin` (ADR-070): помощник ведущего с одной записью
// run_auctions и держатель права вести сходки без неё.
const runAuctionsOnly: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "run-auctions",
];
const manageMeetupsOnly: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "manage-meetups",
];

type AuctionPress = Extract<
  CallbackAction,
  { kind: `console-${string}` | `lot-${string}` }
>["kind"];

// По кнопке на каждый вид пульта и формы лота (PER-654).
const forgedAuctionPresses = {
  "lot-new": `v1:lot:new:${auctionToken}`,
  "lot-form": `v1:lot:form:${uuidToToken(vaseId)}`,
  "lot-view": `v1:lot:view:${uuidToToken(vaseId)}`,
  "lot-ask": `v1:lot:ask:${uuidToToken(vaseId)}:title`,
  "lot-step-mode": `v1:lot:sm:${uuidToToken(vaseId)}:100:single`,
  "lot-skip": `v1:lot:skip:${uuidToToken(vaseId)}`,
  "lot-keep-step": `v1:lot:sk:${uuidToToken(vaseId)}:100`,
  "lot-image-remove": `v1:lot:rm:${uuidToToken(vaseId)}`,
  "lot-image-remove-confirm": `v1:lot:ry:${uuidToToken(vaseId)}:abcde`,
  "lot-scope": `v1:lot:sc:${uuidToToken(vaseId)}:title`,
  "lot-set-retry": `v1:lot:sr:${uuidToToken(vaseId)}:title`,
  "lot-copy": `v1:lot:cp:${uuidToToken(vaseId)}`,
  "lot-remove": `v1:lot:dl:${uuidToToken(vaseId)}`,
  "lot-remove-confirm": `v1:lot:dy:${uuidToToken(vaseId)}`,
  "console-view": consoleData,
  "console-week": `v1:ac:w:${auctionToken}`,
  "console-raffle": `v1:ac:r:${auctionToken}`,
  "console-raffle-remove": `v1:ac:rx:${auctionToken}`,
  "console-raffle-prize": `v1:ac:rp:${auctionToken}`,
  "console-raffle-prize-remove": `v1:ac:rz:${auctionToken}`,
  "console-final": `v1:ac:f:${auctionToken}:1`,
  "console-final-time": `v1:ac:ft:${auctionToken}`,
  "console-final-time-remove": `v1:ac:fx:${auctionToken}`,
  "console-visibility": `v1:ac:p:${auctionToken}:1`,
  "console-open": `v1:ac:o:${auctionToken}`,
  "console-confirm": `v1:ac:y:${auctionToken}:${uuidToToken(mugId)}`,
  "console-discard": `v1:ac:x:${auctionToken}`,
  "console-discard-confirm": `v1:ac:z:${auctionToken}:${uuidToToken(mugId)}`,
  "console-cancel": `v1:ac:u:${auctionToken}`,
  "console-cancel-confirm": `v1:ac:uy:${auctionToken}:${uuidToToken(mugId)}`,
  "console-mark": `v1:ac:s:${auctionToken}:${uuidToToken(vaseId)}:0`,
  "console-windows": `v1:ac:h:${auctionToken}`,
  "console-day-summary": `v1:ac:ds:${auctionToken}`,
  "console-window": `v1:ac:hw:${auctionToken}:0:abcde`,
  "console-window-ask": `v1:ac:ha:${auctionToken}`,
  "console-window-lot": `v1:ac:hs:${auctionToken}:0:abcde:${uuidToToken(vaseId)}`,
  "console-window-remove": `v1:ac:hx:${auctionToken}:0:abcde`,
  "console-window-launch": `v1:ac:hl:${auctionToken}`,
  "console-window-launch-go": `v1:ac:hm:${auctionToken}:n000000000000000AAAAAAAAAAA`,
  "console-window-launch-lot": `v1:ac:ht:${auctionToken}:n000000000000000AAAAAAAAAAA:0`,
  "console-window-launch-page": `v1:ac:hp:${auctionToken}:n000000000000000AAAAAAAAAAA`,
  "console-sets": `v1:ac:t:${auctionToken}`,
  "console-set-ask": `v1:ac:ta:${auctionToken}`,
  "console-set": `v1:ac:tw:${auctionToken}:0:abcde`,
  "console-set-lot": `v1:ac:ts:${auctionToken}:0:abcde:${uuidToToken(mugId)}`,
  "console-set-delete": `v1:ac:tx:${auctionToken}:0:abcde`,
  "console-set-delete-confirm": `v1:ac:ty:${auctionToken}:0:abcde`,
  "console-lineup": `v1:ac:l:${auctionToken}`,
  "console-lineup-confirm": `v1:ac:ly:${auctionToken}:abcde:0`,
  "console-start-final": `v1:ac:g:${auctionToken}`,
  "console-next-lot": `v1:ac:n:${auctionToken}`,
  "console-ask": `v1:ac:a:${auctionToken}:1`,
  "console-close": `v1:ac:c:${auctionToken}:1`,
  "console-close-confirm": `v1:ac:k:${auctionToken}:1:${uuidToToken(mugId)}:x`,
  "console-floor": `v1:ac:b:${auctionToken}`,
  "console-floor-search": `v1:ac:bs:${auctionToken}`,
  "console-floor-leader": `v1:ac:bl:${auctionToken}`,
  "console-floor-pick": `v1:ac:bp:${uuidToToken(vaseId)}:${uuidToToken(identityId)}:1hc`,
  "console-floor-confirm": `v1:ac:by:${uuidToToken(vaseId)}:${uuidToToken(identityId)}:1hc`,
  "console-removal": `v1:ac:e:${uuidToToken(vaseId)}`,
  "console-removal-pick": `v1:ac:ep:${uuidToToken(vaseId)}:${uuidToToken(identityId)}`,
  "console-removal-confirm": `v1:ac:ey:${uuidToToken(vaseId)}:${uuidToToken(identityId)}:3`,
  "console-invoices": `v1:ac:iv:${auctionToken}`,
  "console-invoice": `v1:ac:ic:${auctionToken}:${uuidToToken(vaseInvoiceId)}`,
  "console-invoice-mark": `v1:ac:ip:${auctionToken}:${uuidToToken(vaseInvoiceId)}:p`,
  "console-invoice-mark-confirm": `v1:ac:iy:${auctionToken}:${uuidToToken(vaseInvoiceId)}:p`,
  "console-payment-text": `v1:ac:it:${auctionToken}`,
  "console-payment-text-remove": `v1:ac:ix:${auctionToken}`,
} satisfies Record<AuctionPress, string>;
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
// аукцион с пультом и каталогом лотов (ADR-070), участник — только права хаба
// и ставок.
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
        "run-auctions",
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
    // Сводка дня (PER-492): агрегаты окна, которые отдаёт Auction; окно,
    // которое назвал бот, тест читает по `windows`.
    day?: readonly DayLotStatistics[];
    // «Ставки зала» (PER-565): имена аукциона, отказ их чтения и автоставка,
    // которая отвечает на ставку зала той же транзакцией шагом выше.
    people?: readonly { participantId: string; name: string }[];
    peopleFail?: true;
    proxyAnswer?: string;
    // Ставка зала остаётся без ответа: транспорт оборвался.
    floorTimeout?: true;
    // Запущенные по ходу торгов окна (PER-615): конфигурация их не знает.
    launchedWindows?: AuctionConsoleView["launchedWindows"];
    // Отказ запуска (PER-615): Auction не принял окно — пульт показывает текст.
    launch?: LaunchStepWindowResult;
    // Видимость до торгов (PER-673): аукцион скрыт, и отказ Auction вместо
    // принятия публикации или снятия.
    hidden?: boolean;
    visibility?: AuctionVisibilityResult;
    // Ориентировочное время финала (PER-663): выставленный анонс и отказ
    // Auction вместо принятия.
    finalAt?: string;
    finalTime?: FinalTimeResult;
    // Снятие участника (PER-659): участники лотов по первой ставке. Снятие
    // переигрывает лот упрощённо: ведёт последний неснятый, цена — на шаг
    // ниже, но не выше прежней.
    participants?: readonly { participantId: string; name: string }[];
    // Сеты лотов (PER-509): сеты аукциона до теста.
    lotSets?: readonly LotSet[];
    // Счета (PER-321): счета проданных лотов до теста.
    invoices?: readonly Invoice[];
    // Текст «Как оплатить и получить» (PER-322) до теста и отказ Auction
    // вместо принятия команды над ним.
    paymentText?: string;
    paymentTextRefusal?: PaymentInstructionsResult;
  } = {},
) {
  let freezeFailures = options.freezeFailures ?? 0;
  const state: {
    status: ConsoleAuctionStatus;
    week?: AuctionConsoleView["week"];
    lots: ConsoleLot[];
    // Запущенные по ходу торгов окна (PER-615): конфигурация их не знает.
    launchedWindows?: AuctionConsoleView["launchedWindows"];
    hidden: boolean;
    // Ориентировочное время финала (PER-663): анонс трансляции.
    finalAt?: string;
    startedBy?: string;
    discarded?: true;
    cancelledBy?: string;
    lineup?: { order: readonly string[]; activeLotId?: string };
    // Ключ принятого объявления состава: его повтор Auction принимает.
    frozenBy?: string;
    // Закрытия по ключу: повтор ключа получает исходный ответ, как в сервисе.
    closures: Map<string, LotClosure>;
    // Принятые ask по ключу (PER-699): повтор ключа цену второй раз не
    // поднимает; счётчик — сколько раз цену подняли на деле.
    asks: Set<string>;
    raisedAsks: number;
    // Снятые с лотов участники (PER-659).
    removed: Set<string>;
    // Сеты лотов (PER-509) в порядке идентификатора, как их отдаёт Auction.
    lotSets: LotSet[];
    // Счета (PER-321): статус меняют только отметки.
    invoices: Invoice[];
    // Переходы счетов: повтор отметки, как в Auction, перехода не пишет.
    transitions: { invoiceId: string; mark: InvoiceMark }[];
    // Текст «Как оплатить и получить» (PER-322).
    paymentText?: string;
  } = {
    status: options.status ?? "draft",
    hidden: options.hidden ?? false,
    ...(options.finalAt === undefined ? {} : { finalAt: options.finalAt }),
    ...(options.week === undefined ? {} : { week: options.week }),
    ...(options.launchedWindows === undefined
      ? {}
      : { launchedWindows: options.launchedWindows }),
    lots: [...(options.lots ?? [])],
    ...(options.lineup === undefined
      ? {}
      : { lineup: { order: options.lineup } }),
    closures: new Map(),
    asks: new Set(),
    raisedAsks: 0,
    removed: new Set(),
    lotSets: [...(options.lotSets ?? [])],
    invoices: [...(options.invoices ?? [])],
    transitions: [],
    ...(options.paymentText === undefined
      ? {}
      : { paymentText: options.paymentText }),
  };
  // Сеты как в Auction (ADR-073): меняются до открытия недели, лот — в одном
  // сете и только из реестра, тот же идентификатор заменяет сет целиком.
  const frozen = () => state.status !== "draft" && state.status !== "scheduled";
  const saveSet = (set: {
    lotSetId: string;
    name: string;
    lotIds: readonly string[];
  }): SaveLotSetResult => {
    if (frozen()) return { kind: "lots-frozen" };
    if (set.name.trim() === "") return { kind: "name-empty" };
    for (const lotId of set.lotIds) {
      if (lotOf(lotId) === undefined) {
        return { kind: "lot-not-in-auction", lotId };
      }
      const holder = state.lotSets.find(
        (each) => each.lotSetId !== set.lotSetId && each.lotIds.includes(lotId),
      );
      if (holder !== undefined) {
        return { kind: "lot-in-another-set", lotId, lotSetId: holder.lotSetId };
      }
    }
    state.lotSets = [
      ...state.lotSets.filter((each) => each.lotSetId !== set.lotSetId),
      { lotSetId: set.lotSetId, name: set.name, lotIds: [...set.lotIds] },
    ].sort((a, b) => (a.lotSetId < b.lotSetId ? -1 : 1));
    return { kind: "ok" };
  };
  const lotOf = (lotId: string) =>
    state.lots.find((each) => each.lot.lotId === lotId);
  const replaceLot = (lotId: string, lot: LotView) => {
    state.lots = state.lots.map((each) =>
      each.lot.lotId === lotId ? { ...each, lot } : each,
    );
  };
  const commands: Command[] = [];
  // Видимость как в Auction: только до открытия недели, повтор пишет ещё раз.
  const visibility = (hidden: boolean): AuctionVisibilityResult => {
    if (options.visibility !== undefined) return options.visibility;
    if (state.status !== "draft" && state.status !== "scheduled") {
      return { kind: "already-started" };
    }
    state.hidden = hidden;
    return { kind: "ok" };
  };
  // Окно, которое бот назвал суточному чтению (PER-492): день сообщества и
  // часы бота, а не то, что придумал бы Auction.
  const windows: { auctionId: string; from: string; until: string }[] = [];
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
  const decideRemoval = (target: RemovalTarget) => {
    const found = lotOf(target.lotId);
    const status = found?.lot.status;
    if (found === undefined || status === undefined) {
      return {
        kind: "refused" as const,
        reason: "lot-not-in-auction" as const,
      };
    }
    if (status.kind === "trading" && status.phase === "live") {
      return {
        kind: "refused" as const,
        reason: "not-in-online-phase" as const,
      };
    }
    if (status.kind !== "trading" && status.kind !== "held") {
      return { kind: "refused" as const, reason: "lot-not-open" as const };
    }
    const known = (options.participants ?? []).some(
      (each) => each.participantId === target.participantId,
    );
    if (!known) {
      return {
        kind: "refused" as const,
        reason: "not-a-lot-participant" as const,
      };
    }
    if (state.removed.has(target.participantId)) {
      return { kind: "refused" as const, reason: "already-removed" as const };
    }
    const leaderId = (options.participants ?? [])
      .filter(
        (each) =>
          each.participantId !== target.participantId &&
          !state.removed.has(each.participantId),
      )
      .at(-1)?.participantId;
    return {
      kind: "ok" as const,
      lot: found.lot,
      leaderId,
      price: rub(Math.max(0, status.currentPrice.minorUnits - 10_000)),
    };
  };
  const port: MeetupAuctions &
    AuctionScreens &
    LotAdministration &
    AuctionConsoles = {
    getMeetupAuction: notUsed,
    soldLots: notUsed,
    enableAuction: notUsed,
    createLotCard: notUsed,
    editLotCard: notUsed,
    addLot: notUsed,
    scheduleLot: notUsed,
    getLot: notUsed,
    removeLot: notUsed,
    getLotImage: notUsed,
    async getAuctionConsole(): Promise<ConsoleReadResult> {
      commands.push({ method: "getAuctionConsole", args: auctionId });
      if (options.refuse === true) return { kind: "not-administrator" };
      return {
        kind: "ok",
        console: {
          auctionId,
          status: state.status,
          hidden: state.hidden,
          ...(state.finalAt === undefined ? {} : { finalAt: state.finalAt }),
          ...(state.week === undefined ? {} : { week: state.week }),
          ...(state.lineup === undefined ? {} : { lineup: state.lineup }),
          launchedWindows: state.launchedWindows ?? [],
          lots: state.lots,
          lotSets: state.lotSets,
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
          ...(each.priceGrowth === undefined
            ? {}
            : { priceGrowth: each.priceGrowth }),
        })),
      };
    },
    async getAuctionDaySummary(
      _person: unknown,
      day: { auctionId: string; from: string; until: string },
    ) {
      windows.push(day);
      return { kind: "ok" as const, lots: options.day ?? [] };
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
      // Приз розыгрыша (PER-649): без розыгрыша, пустой и длиннее предела он
      // не принимается — как в сервисе.
      const prize = config.rafflePrize;
      if (prize !== undefined) {
        if (raffle === undefined) {
          return { kind: "raffle-prize-without-raffle" };
        }
        if (prize.trim() === "") return { kind: "raffle-prize-blank" };
        if (prize.length > 200) return { kind: "raffle-prize-too-long" };
      }
      state.status = "scheduled";
      state.week = {
        opensAt: config.opensAt,
        closesAt: config.closesAt,
        final: config.final,
        windows: config.windows,
        ...(raffle === undefined ? {} : { raffleClosesAt: raffle }),
        ...(prize === undefined ? {} : { rafflePrize: prize }),
      };
      return { kind: "ok" };
    },
    async launchStepWindow(_person, launch) {
      commands.push({ method: "launchStepWindow", args: launch });
      if (options.launch !== undefined) {
        return options.launch;
      }
      if (state.status !== "prebidding") {
        return { kind: "not-in-prebidding" };
      }
      state.launchedWindows = [
        ...(state.launchedWindows ?? []),
        {
          from: launch.from ?? "2026-10-20T15:00:00Z",
          until: launch.until,
          step: launch.step,
          lotIds: [...launch.lotIds],
        },
      ];
      return {
        kind: "ok",
        from: launch.from ?? "2026-10-20T15:00:00Z",
        until: launch.until,
      };
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
    async publishAuction(_person, publish) {
      commands.push({ method: "publishAuction", args: publish });
      return visibility(false);
    },
    // Время финала (PER-663): выставляется, меняется и снимается, пока финал
    // впереди; после его старта Auction отказывает.
    async setFinalTime(_person, command) {
      commands.push({ method: "setFinalTime", args: command });
      if (options.finalTime !== undefined) return options.finalTime;
      if (state.status === "final") return { kind: "final-already-started" };
      if (state.status === "finished")
        return { kind: "auction-already-finished" };
      if (state.status === "cancelled") {
        return { kind: "auction-already-cancelled" };
      }
      if (command.finalAt === undefined) {
        delete state.finalAt;
      } else {
        state.finalAt = command.finalAt;
      }
      return { kind: "ok" };
    },
    async hideAuction(_person, hide) {
      commands.push({ method: "hideAuction", args: hide });
      return visibility(true);
    },
    async saveLotSet(_person, set) {
      commands.push({ method: "saveLotSet", args: set });
      return saveSet(set);
    },
    async deleteLotSet(_person, set) {
      commands.push({ method: "deleteLotSet", args: set });
      if (frozen()) return { kind: "lots-frozen" };
      if (!state.lotSets.some((each) => each.lotSetId === set.lotSetId)) {
        return { kind: "lot-set-not-found" };
      }
      state.lotSets = state.lotSets.filter(
        (each) => each.lotSetId !== set.lotSetId,
      );
      return { kind: "ok" };
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
    // Отмена — как в сервисе: до торгов `not-started`, после конца
    // `already-finished`, повтор на отменённом принят.
    async cancelAuction(_person, cancel) {
      commands.push({ method: "cancelAuction", args: cancel });
      if (state.status === "cancelled") return { kind: "ok" };
      if (state.status === "draft" || state.status === "scheduled") {
        return { kind: "not-started" };
      }
      if (state.status === "finished") return { kind: "already-finished" };
      state.status = "cancelled";
      state.cancelledBy = cancel.opId;
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
      // Окно `op_id` Auction (ADR-047): повтор той же команды получает исходный
      // ответ и цену второй раз не поднимает.
      if (state.asks.has(ask.opId)) return { kind: "ok" };
      const lot = lotOf(ask.lotId)?.lot;
      if (lot?.status.kind !== "trading") return { kind: "lot-not-open" };
      if (ask.newAsk.minorUnits <= lot.status.currentPrice.minorUnits) {
        return {
          kind: "ask-below-current-price",
          mustExceed: lot.status.currentPrice,
        };
      }
      state.asks.add(ask.opId);
      state.raisedAsks += 1;
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
    async listAuctionNames() {
      commands.push({ method: "listAuctionNames", args: auctionId });
      return options.peopleFail === true
        ? { kind: "unavailable" as const, cause: new Error("down") }
        : { kind: "ok" as const, names: options.people ?? [] };
    },
    async floorLot(_person: unknown, read: { lotId: string }) {
      const found = lotOf(read.lotId);
      return found === undefined
        ? { kind: "not-found" as const }
        : { kind: "ok" as const, lot: found.lot };
    },
    // Ставка живого финала — ровно по следующей цене (ADR-049), как в
    // сервисе: лот под шардингом решает ставки по одной.
    async placeFloorBid(_person: unknown, bid: FloorBid) {
      commands.push({ method: "placeFloorBid", args: bid });
      if (options.floorTimeout === true) {
        return { kind: "timeout" as const, cause: new Error("deadline") };
      }
      const found = lotOf(bid.lotId);
      const status = found?.lot.status;
      if (
        found === undefined ||
        status?.kind !== "trading" ||
        status.phase !== "live"
      ) {
        return { kind: "lot-not-open" as const };
      }
      const next = found.lot.nextPrice;
      if (next === undefined || next.minorUnits !== bid.amount.minorUnits) {
        return {
          kind: "bid-not-at-next-price" as const,
          expected: next ?? bid.amount,
        };
      }
      if (status.leaderId === bid.participantId) {
        return { kind: "bidder-is-leader" as const };
      }
      const step = 10_000;
      const answer = options.proxyAnswer;
      const price =
        answer === undefined ? next.minorUnits : next.minorUnits + step;
      const version = found.lot.version + (answer === undefined ? 1 : 2);
      replaceLot(bid.lotId, {
        ...found.lot,
        version,
        nextPrice: rub(price + step),
        status: {
          ...status,
          currentPrice: rub(price),
          leaderId: answer ?? bid.participantId,
        },
      });
      return { kind: "accepted" as const, lotVersion: version };
    },
    async lotParticipants(
      _person: unknown,
      read: { auctionId: string; lotId: string },
    ) {
      commands.push({ method: "lotParticipants", args: read });
      return {
        kind: "ok" as const,
        participants: (options.participants ?? []).map((each) => ({
          ...each,
          removed: state.removed.has(each.participantId),
        })),
      };
    },
    // Лот решает снятие так же, как сервис: сначала фаза и участник, номер
    // лота — последней проверкой (ADR-072, дополнение 2026-10-21).
    async previewParticipantRemoval(_person: unknown, target: RemovalTarget) {
      commands.push({ method: "previewParticipantRemoval", args: target });
      const decided = decideRemoval(target);
      return decided.kind === "ok"
        ? {
            kind: "ok" as const,
            preview: {
              price: decided.price,
              ...(decided.leaderId === undefined
                ? {}
                : { leaderId: decided.leaderId }),
              version: decided.lot.version,
            },
          }
        : decided;
    },
    async removeParticipant(
      _person: unknown,
      removal: RemovalTarget & { expectedVersion: number; opId: string },
    ) {
      commands.push({ method: "removeParticipant", args: removal });
      const decided = decideRemoval(removal);
      if (decided.kind !== "ok") return decided;
      if (decided.lot.version !== removal.expectedVersion) {
        return { kind: "lot-changed" as const };
      }
      const status = decided.lot.status;
      if (status.kind !== "trading" && status.kind !== "held") {
        throw new Error("decided removal from a closed lot");
      }
      state.removed.add(removal.participantId);
      const version = decided.lot.version + 1;
      const { leaderId: _, ...rest } = status;
      replaceLot(removal.lotId, {
        ...decided.lot,
        version,
        status: {
          ...rest,
          currentPrice: decided.price,
          ...(decided.leaderId === undefined
            ? {}
            : { leaderId: decided.leaderId }),
        },
      });
      return { kind: "ok" as const, lotVersion: version };
    },
    async listAuctionInvoices() {
      commands.push({ method: "listAuctionInvoices", args: auctionId });
      if (options.refuse === true) return { kind: "not-administrator" };
      return {
        kind: "ok" as const,
        invoices: state.invoices,
        ...(state.paymentText === undefined
          ? {}
          : { paymentInstructions: state.paymentText }),
      };
    },
    // Текст оплаты (PER-322): Auction хранит его как есть; текст без —
    // снятие.
    async setPaymentInstructions(
      _person: unknown,
      command: { auctionId: string; opId: string; text?: string },
    ) {
      commands.push({ method: "setPaymentInstructions", args: command });
      if (options.paymentTextRefusal !== undefined) {
        return options.paymentTextRefusal;
      }
      if (command.text === undefined) delete state.paymentText;
      else state.paymentText = command.text;
      return { kind: "ok" as const };
    },
    // Счёт решает отметку, как в Auction: выдача — только после оплаты,
    // повтор уже стоящей отметки принимается без перехода.
    async markInvoice(
      _person: unknown,
      mark: { invoiceId: string; mark: InvoiceMark; opId: string },
    ) {
      commands.push({ method: "markInvoice", args: mark });
      const found = state.invoices.find(
        (each) => each.invoiceId === mark.invoiceId,
      );
      if (found === undefined) return { kind: "invoice-not-found" as const };
      const next =
        mark.mark === "paid"
          ? found.status === "awaiting-payment"
            ? "paid"
            : undefined
          : found.status === "awaiting-payment"
            ? "not-paid"
            : found.status === "paid"
              ? "handed-over"
              : undefined;
      if (next === "not-paid") return { kind: "invoice-not-paid" as const };
      if (next !== undefined) {
        state.transitions.push({ invoiceId: found.invoiceId, mark: mark.mark });
        state.invoices = state.invoices.map((each) =>
          each === found ? { ...each, status: next } : each,
        );
      }
      return { kind: "ok" as const };
    },
    currentAuction: async () => ({ kind: "ok" as const }),
    screenPorts() {
      return {
        auction: {
          findLot: async () => undefined,
          getLot: async (request: { lotId: string }) => {
            const found = lotOf(request.lotId);
            if (found === undefined) throw new Error("lot not in the fake");
            return found.lot;
          },
          listAuctionLots: async () => ({
            lots: state.lots.map((each) => each.lot),
            nextPageToken: "",
          }),
          // Хронология снятия (PER-659): по ставке на участника, снятые — с
          // пометкой.
          listLotHistory: async () => ({
            entries: (options.participants ?? []).map(
              (each, index): LotHistoryEntryView => ({
                kind: "bid",
                sequence: index + 1,
                occurredAt: "2026-10-06T08:00:00Z",
                bidId: `bid-${index}`,
                participantId: each.participantId,
                amount: rub(10_000 * (index + 1)),
                origin: { kind: "proxy" },
                ...(state.removed.has(each.participantId)
                  ? { removed: true as const }
                  : {}),
              }),
            ),
            nextPageToken: "",
          }),
          getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
          getDisplayNames: async (request: {
            participantIds: readonly string[];
          }) =>
            Object.fromEntries(
              (options.participants ?? [])
                .filter((each) =>
                  request.participantIds.includes(each.participantId),
                )
                .map((each) => [each.participantId, each.name]),
            ),
          placeBid: notUsed,
          setProxyLimit: notUsed,
          chooseDisplayName: notUsed,
          getAuction: async () => ({
            auctionId,
            // Стадия финала ставит в корень вход «Ставок зала» (PER-565).
            stage:
              state.status === "final"
                ? ("in-final" as const)
                : state.status === "lineup-frozen"
                  ? ("lineup-frozen" as const)
                  : ("scheduled" as const),
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
          listMyInvoices: async () => ({ invoices: [] }),
          chooseFulfillment: async () => {
            throw new Error("not used");
          },
          getMyPredictions: async () => [],
          getPredictionResults: async () => {
            throw new Error("not used");
          },
          submitPrediction: notUsed,
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
    windows,
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
  auctionBotUsername?: string,
  // Живой пульт (PER-566): поток, темп правок и ответы Telegram на правки.
  extra: Pick<HarnessOptions, "live" | "respond"> = {},
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
    {
      auction: auction.port,
      communityTimeZone: timeZone,
      ...(auctionBotUsername === undefined ? {} : { auctionBotUsername }),
      ...extra,
    },
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
        text: "🛠 Пульт",
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
  // Пульт — ряд корня аукциона (PER-605) своим рядом над возвратом
  // (PER-669), а «Добавить лот» остаётся над списком лотов.
  it("shows the console in the auction root to the administrator only", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const admin = harness("admin", auction);
    await admin.bot.init();
    await admin.bot.handleUpdate(press(rootData));
    const root = last(admin.calls);
    expect(labels(root).slice(0, 3)).toEqual([
      ["🔨 Лоты"],
      ["Правила и FAQ"],
      ["🛠 Пульт", "🛠 Сеты"],
    ]);
    expect(dataOf(root, "🛠 Пульт")).toBe(consoleData);
    expect(dataOf(root, "🛠 Сеты")).toBe(`v1:ac:t:${auctionToken}`);

    const member = harness("member", auction);
    await member.bot.init();
    await member.bot.handleUpdate(press(rootData));
    expect(JSON.stringify(shown(member.calls))).not.toContain("🛠 Пульт");
    expect(JSON.stringify(shown(member.calls))).not.toContain("🛠 Сеты");
  });

  // «Добавить лот» — пока онлайн-неделя не открыта (PER-468): после старта
  // Auction отвечает `lots_frozen`, и кнопка вела бы в отказ после вопроса.
  it("shows the lot entry while the auction still accepts lots", async () => {
    for (const status of ["draft", "scheduled"] as const) {
      const auction = fakeAuction({ status, lots: [vase] });
      const { bot, calls } = harness("admin", auction);
      await bot.init();
      await bot.handleUpdate(press(feedData));
      expect(labels(last(calls))[0]).toEqual(["🛠 Добавить лот"]);
      expect(auction.sent("getAuctionConsole")).toHaveLength(1);
    }
  });

  // Розыгрыш открыт с онлайн-недели: он встаёт в корне одним рядом с «Лотами»
  // (прогон 14.10, №66), и «🛠 Пульт» ряд с ним не делит (PER-669).
  it("puts the raffle next to the lots apart from the console once the online week is open", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [vase],
      raffle: true,
    });
    const admin = harness("admin", auction);
    await admin.bot.init();
    await admin.bot.handleUpdate(press(rootData));
    expect(labels(last(admin.calls)).slice(0, 3)).toEqual([
      ["🔨 Лоты", "Розыгрыш"],
      ["Правила и FAQ"],
      ["🛠 Пульт", "🛠 Сеты"],
    ]);

    const member = harness("member", auction);
    await member.bot.init();
    await member.bot.handleUpdate(press(rootData));
    expect(labels(last(member.calls)).slice(0, 2)).toEqual([
      ["🔨 Лоты", "Розыгрыш"],
      ["Правила и FAQ"],
    ]);
  });

  it("hides the lot entry once the online week is open", async () => {
    const auction = fakeAuction({ status: "prebidding", lots: [vase] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    const feed = last(calls);
    expect(JSON.stringify(feed)).not.toContain("🛠 Добавить лот");
    expect(labels(feed).at(-1)).toEqual(["‹ Аукцион"]);
  });

  it("keeps the lot entry when the console cannot be read", async () => {
    const auction = fakeAuction({ status: "prebidding", refuse: true });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    expect(labels(last(calls))[0]).toEqual(["🛠 Добавить лот"]);
  });

  // Пульт и каталог лотов — одно право вести аукцион (ADR-070, RFC-016):
  // держатель управления составом без него не видит ни того, ни другого, и
  // Auction его не спрашивают.
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
    expect(JSON.stringify(last(calls))).not.toContain("🛠 Пульт");
    expect(JSON.stringify(last(calls))).not.toContain("🛠 Добавить лот");
    expect(auction.sent("getAuctionConsole")).toEqual([]);

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    expect(last(calls).text).toContain("Это действие тебе недоступно.");
    expect(auction.commands).toEqual([]);
  });

  // Помощник ведущего (ADR-070, PER-654): одна запись run_auctions без права
  // вести сходки открывает пульт и каталог лотов.
  it("shows the console and the lot entries to a holder of the right to run auctions alone", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot, calls } = harness("member", auction, [], runAuctionsOnly);
    await bot.init();

    await bot.handleUpdate(press(rootData));
    expect(dataOf(last(calls), "🛠 Пульт")).toBe(consoleData);
    await bot.handleUpdate(press(feedData));
    expect(labels(last(calls))[0]).toEqual(["🛠 Добавить лот"]);

    await bot.handleUpdate(press(consoleData));
    expect(last(calls).text).not.toContain("Это действие тебе недоступно.");
    expect(auction.sent("getAuctionConsole")).not.toEqual([]);
  });

  // Право вести сходки аукциона больше не несёт (ADR-070): ни входа в пульт,
  // ни в каталог лотов.
  it("hides the console and the lot entries from a holder of the right to manage meetups alone", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot, calls } = harness("member", auction, [], manageMeetupsOnly);
    await bot.init();

    await bot.handleUpdate(press(rootData));
    expect(JSON.stringify(last(calls))).not.toContain("🛠 Пульт");
    await bot.handleUpdate(press(feedData));
    expect(JSON.stringify(last(calls))).not.toContain("🛠 Добавить лот");
    expect(auction.commands).toEqual([]);
  });

  // Каждая кнопка пульта, пульта ведущего и формы лота: таблица держит все
  // виды разбора, и новый вид без строки роняет typecheck, а не ревью.
  // Подделанное нажатие без права вести аукцион получает отказ до Auction.
  it.each(Object.entries(forgedAuctionPresses))(
    "refuses a forged %s press of a holder of the right to manage meetups before Auction",
    async (kind, data) => {
      expect(parseCallback(data).kind).toBe(kind);
      const auction = fakeAuction({ lots: [vase] });
      const { bot, calls, records } = harness(
        "member",
        auction,
        [],
        manageMeetupsOnly,
      );
      await bot.init();

      await bot.handleUpdate(press(data));

      expect(last(calls).text).toContain("Это действие тебе недоступно.");
      expect(auction.commands).toEqual([]);
      expect(records.at(-1)?.fields).toMatchObject({
        result: "error",
        error_category: "authorization",
      });
    },
  );

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
      // Сводка дня (PER-492): кнопка пульта — того же права, что и пульт.
      `v1:ac:ds:${auctionToken}`,
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
        "Идут онлайн-торги до 27 октября, вт, 00:00.\nФинал: есть.\nВремя финала: не выставлено.\nРозыгрыш: нет.",
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
      ["Время финала"],
      ["Счастливые часы", "Сводка дня", "Отменить аукцион"],
      ["В финал · Ваза"],
      ["Снять из финала · Кружка"],
      ["‹ Аукцион"],
    ]);
    expect(dataOf(screen, "‹ Аукцион")).toBe(rootData);
  });

  // Прогон 14.10, №76: строка лота называет лидера по имени в аукционе. Имя —
  // подсказка: не прочиталось — строка без лидера, пульт открывается.
  it("names the leader of a lot in the console list when the name is read", async () => {
    const leaderId = "0192f0a0-0000-7000-8000-0000000000aa";
    const led: ConsoleLot = {
      ...vase,
      lot: {
        ...vase.lot,
        status: {
          kind: "trading",
          currentPrice: rub(120_000),
          phase: "online",
          leaderId,
        },
      },
    };
    const named = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [led],
      names: { [leaderId]: "Pem*" },
    });
    const first = harness("admin", named);
    await first.bot.init();
    await first.bot.handleUpdate(press(consoleData));
    expect(plain(last(first.calls))).toContain(
      "• Ваза — 1 200 ₽ · лидер Pem* · 3 ставки · 2 уч.",
    );

    const nameless = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [led],
    });
    const second = harness("admin", nameless);
    await second.bot.init();
    await second.bot.handleUpdate(press(consoleData));
    expect(plain(last(second.calls))).toContain(
      "• Ваза — 1 200 ₽ · 3 ставки · 2 уч.",
    );
    expect(plain(last(second.calls))).not.toContain("лидер");
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
    expect(last(calls).text).toBe(
      "<b>Лот отмечен для финала</b>\n\n<b>Ваза</b>",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "• Ваза — 1 200 ₽ · 3 ставки · 2 уч. · в финал",
    );

    await bot.handleUpdate(
      press(dataOf(last(calls), "Снять из финала · Ваза")),
    );

    expect(auction.sent("deselectForFinal")).toHaveLength(1);
    expect(last(calls).text).toBe("<b>Отметка финала снята</b>\n\n<b>Ваза</b>");
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
      ["Сроки недели", "Снять с публикации"],
      ["Сводка дня"],
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
      ["Сроки недели", "Снять с публикации"],
      ["Время финала"],
      ["Вкл · Финал в зале"],
      ["Счастливые часы", "Сводка дня"],
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

    const toggle = dataOf(last(calls), "Вкл · Финал в зале");
    // Кнопка несёт целевое состояние, а не переворот.
    expect(toggle).toBe(`v1:ac:f:${auctionToken}:0`);
    await bot.handleUpdate(press(toggle));

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: { auctionId, opId: expect.any(String), ...week, final: false },
      },
    ]);
    expect(toasts(calls)).toContain("Выключено: финал в зале.");
    expect(plain(last(calls))).toContain("Финал: нет.");
    expect(labels(last(calls))).toContainEqual(["Выкл · Финал в зале"]);

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

    await bot.handleUpdate(press(dataOf(last(calls), "Вкл · Финал в зале")));
    // Новое чтение видит выключенный финал, и «Вкл» шлёт команду.
    await bot.handleUpdate(press(dataOf(last(calls), "Выкл · Финал в зале")));

    expect(
      auction.sent("scheduleAuction").map((command) => command.args),
    ).toEqual([
      expect.objectContaining({ final: false }),
      expect.objectContaining({ final: true }),
    ]);
    expect(toasts(calls)).toContain("Включено: финал в зале.");
    expect(labels(last(calls))).toContainEqual(["Вкл · Финал в зале"]);
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
    expect(labels(last(calls))[0]).toEqual(["🔨 Лоты", "Розыгрыш"]);
  });

  it("keeps the moment over new dates and the final and names it when new dates cut it off", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true, raffleClosesAt: moment },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Вкл · Финал в зале")));
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

// Приз розыгрыша (PER-649) — поле пульта: администратор задаёт его у
// розыгрыша, видит в сводке, а участники — на экране розыгрыша и в вести.
describe("prize of the raffle", () => {
  const moment = "2026-10-22T15:00:00Z";
  const prize = "сертификат в книжный на 5000 ₽";

  const withMoment = () =>
    fakeAuction({
      status: "scheduled",
      week: { ...week, final: true, raffleClosesAt: moment },
    });

  const withPrize = () =>
    fakeAuction({
      status: "scheduled",
      week: {
        ...week,
        final: true,
        raffleClosesAt: moment,
        rafflePrize: prize,
      },
    });

  // Пульт с моментом розыгрыша и открытым вопросом о призе.
  async function askPrize(auction = withMoment()) {
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Приз")));
    return { auction, bot, calls };
  }

  it("offers the prize at the raffle and asks for one line", async () => {
    const auction = withMoment();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain(
      "Розыгрыш: регистрация до 22 октября, чт, 18:00.",
    );
    expect(plain(last(calls))).not.toContain("Приз:");
    expect(labels(last(calls))).toContainEqual(["Приз"]);
    expect(labels(last(calls)).flat()).not.toContain("🗑 Убрать приз");

    await bot.handleUpdate(press(dataOf(last(calls), "Приз")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:ap:${auctionToken}:42`);
    expect(asked.text).toContain("Приз одной строкой");
    expect(asked.text).not.toContain("Сейчас:");
  });

  it("refuses a blank prize and does not save it", async () => {
    const { auction, bot, calls } = await askPrize();
    await bot.handleUpdate(answer(calls, { text: "   " }));

    expect(last(calls).text).toBe(
      "<b>Пустой приз призом не считается: напиши, что получит победитель</b>",
    );
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });

  it("refuses a prize longer than the limit of the message", async () => {
    const { auction, bot, calls } = await askPrize();
    await bot.handleUpdate(answer(calls, { text: "я".repeat(201) }));

    expect(last(calls).text).toContain("Приз длиннее 200 знаков");
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });

  // Пробелы по краям срезаются: приз едет одной строкой и в том же виде
  // возвращается в сводку.
  it("saves the prize as one line and shows it in the summary", async () => {
    const { auction, bot, calls } = await askPrize();
    await bot.handleUpdate(answer(calls, { text: `  ${prize}  ` }));
    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: {
          auctionId,
          opId: expect.any(String),
          ...week,
          final: true,
          raffleClosesAt: moment,
          rafflePrize: prize,
        },
      },
    ]);
    expect(last(calls).text).toBe(`<b>Приз розыгрыша сохранён: ${prize}</b>`);

    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain(`Приз: ${prize}`);
    expect(labels(last(calls))).toContainEqual(["Изменить приз"]);
    expect(labels(last(calls))).toContainEqual(["🗑 Убрать розыгрыш"]);
    expect(labels(last(calls))).toContainEqual(["🗑 Убрать приз"]);
  });

  it("shows the saved prize in the question", async () => {
    const auction = withPrize();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Изменить приз")));

    expect(question(calls).payload.text).toContain(`Сейчас: ${prize}`);
  });

  it("removes the prize and keeps the raffle", async () => {
    const auction = withPrize();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "🗑 Убрать приз")));

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: {
          auctionId,
          opId: expect.any(String),
          ...week,
          final: true,
          raffleClosesAt: moment,
          rafflePrize: undefined,
        },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Приз розыгрыша убран</b>\n\nПобедитель получит весть без приза.",
    );
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).not.toContain("Приз:");
    expect(labels(last(calls))).toContainEqual(["Приз"]);
    expect(labels(last(calls)).flat()).not.toContain("🗑 Убрать приз");
  });

  it("keeps the prize over new dates and the final", async () => {
    const auction = withPrize();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Вкл · Финал в зале")));
    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));
    await bot.handleUpdate(
      answer(calls, { text: "20.10.2026 18:00 — 28.10.2026 00:00" }),
    );
    // Команды не стирают приз молча: он едет с новыми сроками и финалом.
    expect(
      auction.sent("scheduleAuction").map((command) => command.args),
    ).toEqual([
      expect.objectContaining({ final: false, rafflePrize: prize }),
      expect.objectContaining({
        closesAt: "2026-10-27T21:00:00Z",
        rafflePrize: prize,
      }),
    ]);
  });

  it("drops the prize together with the raffle", async () => {
    const auction = withPrize();
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "🗑 Убрать розыгрыш")));

    // Розыгрыша нет — нет и приза: победителя у такой недели не будет.
    expect(auction.sent("scheduleAuction").at(-1)?.args).toEqual({
      auctionId,
      opId: expect.any(String),
      ...week,
      final: true,
      raffleClosesAt: undefined,
      rafflePrize: undefined,
    });
    expect(auction.state.week?.rafflePrize).toBeUndefined();
  });

  it("answers a stale prize button on a week without a raffle", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:rp:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Приз задаётся у розыгрыша: сначала нажми «Розыгрыш» и назови момент</b>",
    );
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });
});

// Ориентировочное время финала (PER-663): анонс трансляции в пульте. Момент
// задаётся вопросом, снимается кнопкой, а после старта финала кнопок нет.
describe("the final time of the auction", () => {
  it("asks the moment, keeps it over a restart and shows it on the console", async () => {
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
    expect(plain(last(calls))).toContain("Время финала: не выставлено.");
    expect(dataOf(last(calls), "Время финала")).toBe(
      `v1:ac:ft:${auctionToken}`,
    );
    expect(labels(last(calls)).flat()).not.toContain("🗑 Убрать время финала");

    await next((history) => press(dataOf(last(history), "Время финала")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:ft:${auctionToken}:42`);
    expect(asked.text).toContain("Например: 31.10.2026 19:00");

    // Момент в прошлом бот отклоняет сам, без команды.
    await next((history) => answer(history, { text: "01.10.2026 18:00" }));
    expect(last(calls).text).toBe("<b>Этот момент уже прошёл</b>");
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    expect(auction.sent("setFinalTime")).toEqual([]);

    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) => answer(history, { text: "31.10.2026 19:00" }));
    expect(auction.sent("setFinalTime")).toEqual([
      {
        method: "setFinalTime",
        args: {
          auctionId,
          opId: expect.any(String),
          finalAt: "2026-10-31T16:00:00Z",
        },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Время финала сохранено: 31 октября, сб, 19:00</b>",
    );

    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "Время финала: 31 октября, сб, 19:00.",
    );
    expect(labels(last(calls)).flat()).toContain("🗑 Убрать время финала");

    // Вопрос называет текущее время в том виде, в каком его вводят.
    await next((history) => press(dataOf(last(history), "Время финала")));
    expect(question(calls).payload.text).toContain("Сейчас: 31.10.2026 19:00");
  });

  it("takes the announcement back without a confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      finalAt: "2026-10-31T16:00:00Z",
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(plain(last(calls))).toContain(
      "Время финала: 31 октября, сб, 19:00.",
    );

    await bot.handleUpdate(press(dataOf(last(calls), "🗑 Убрать время финала")));
    expect(auction.sent("setFinalTime")).toEqual([
      {
        method: "setFinalTime",
        args: { auctionId, opId: expect.any(String) },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Время финала убрано</b>\n\nАнонса больше нет.",
    );
  });

  it("offers to take the announcement back after the final is switched off", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: false },
      finalAt: "2026-10-31T16:00:00Z",
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(plain(last(calls))).toContain("Финал: нет.");
    expect(plain(last(calls))).toContain(
      "Время финала: 31 октября, сб, 19:00.",
    );
    // Выключенный финал оставляет время у аукциона, и убрать его больше
    // нечем: ряд несёт только снятие.
    expect(labels(last(calls)).flat()).toContain("🗑 Убрать время финала");
    expect(labels(last(calls)).flat()).not.toContain("Время финала");
  });

  it("offers no button once the lineup is frozen", async () => {
    const auction = fakeAuction({
      status: "lineup-frozen",
      week: { ...week, final: true },
      finalAt: "2026-10-31T16:00:00Z",
      lineup: [vase.lot.lotId],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(labels(last(calls)).flat()).not.toContain("Время финала");
    expect(plain(last(calls))).toContain(
      "Время финала: 31 октября, сб, 19:00.",
    );
  });

  it("names the refusal of an old button once the final has started", async () => {
    const auction = fakeAuction({
      status: "final",
      week: { ...week, final: true },
      finalAt: "2026-10-31T16:00:00Z",
      lineup: [vase.lot.lotId],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(labels(last(calls)).flat()).not.toContain("Время финала");

    await bot.handleUpdate(press(`v1:ac:ft:${auctionToken}`));
    expect(last(calls).text).toBe(
      "<b>Финал уже начался</b>\n\nВремя финала больше не меняется.",
    );
    expect(auction.sent("setFinalTime")).toEqual([]);
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
    expect(labels(last(calls))).toEqual([["Идущий аукцион"], ["‹ Пульт"]]);
    // Переход к идущему аукциону — в его корень (PER-606).
    expect(dataOf(last(calls), "Идущий аукцион")).toBe(
      encodeAuctionCallback({ kind: "root", auctionId: busy.auctionId }),
    );
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
    expect(labels(last(calls))).toEqual([["Идущий аукцион"], ["‹ Пульт"]]);
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
    // Аукцион отменили между чтением пульта и чтением розыгрыша (PER-698):
    // строка называет отмену, а не роняет пульт.
    [raffle({ status: "cancelled" }), "Розыгрыш: отменён вместе с аукционом."],
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
      "Аукцион завершён.\nВремя финала: не выставлено.\nРозыгрыш: выиграл билет №1 — Сова*, билетов: 1.",
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
      "К ставкам сразу откроются: 1 лот. Ставки начнут приниматься с подтверждения, не дожидаясь начала недели 20 октября, вт, 18:00. Торги закроются 27 октября, вт, 00:00.",
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
      "<b>Онлайн-неделя открыта</b>\n\nСтавки принимаются с этой минуты.",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("Идут онлайн-торги до");

    await bot.handleUpdate(press(yes));

    const [first, second] = auction.sent("startPrebidding");
    expect(second?.args).toEqual(first?.args);
    expect(auction.sent("startPrebidding")).toHaveLength(2);
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя открыта</b>\n\nСтавки принимаются с этой минуты.",
    );
  });

  it("warns about the publication only when the week opens a hidden auction", async () => {
    const publication =
      "Аукцион сейчас скрыт: с открытием недели участники увидят его и лоты.";
    const confirmOf = async (hidden: boolean) => {
      const auction = fakeAuction({
        status: "scheduled",
        week: { ...week, final: true },
        lots: [priced],
        hidden,
      });
      const { bot, calls } = harness("admin", auction);
      await bot.init();
      await bot.handleUpdate(press(consoleData));
      await bot.handleUpdate(
        press(dataOf(last(calls), "Открыть онлайн-неделю")),
      );
      return plain(last(calls));
    };

    expect(await confirmOf(true)).toContain(publication);
    expect(await confirmOf(false)).not.toContain(publication);
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
      ["Счастливые часы", "Сводка дня", "Отменить аукцион"],
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
      ["Время финала"],
      ["Сводка дня", "Отменить аукцион"],
      // Удержанный лот в перерыве продаётся ведущим, и с перерыва у
      // аукциона есть счета (PER-321).
      ["Счета"],
      ["‹ Аукцион"],
    ]);
  });
});

describe("auction visibility", () => {
  it("publishes a hidden auction and hides it again from the console", async () => {
    const auction = fakeAuction({ hidden: true, lots: [priced] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(plain(last(calls))).toContain(
      "Скрыт от участников: они его не видят, пока не опубликуешь.",
    );

    await bot.handleUpdate(press(dataOf(last(calls), "Опубликовать")));
    expect(auction.state.hidden).toBe(false);
    expect(last(calls).text).toBe(
      "<b>Аукцион опубликован</b>\n\nУчастники видят его и лоты.",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("Виден участникам.");

    await bot.handleUpdate(press(dataOf(last(calls), "Снять с публикации")));
    expect(auction.state.hidden).toBe(true);
    expect(last(calls).text).toBe(
      "<b>Аукцион снят с публикации</b>\n\nУчастники его не видят.",
    );
    const [published, hidden] = [
      ...auction.sent("publishAuction"),
      ...auction.sent("hideAuction"),
    ];
    expect(published?.args).toMatchObject({ auctionId });
    expect(hidden?.args).toMatchObject({ auctionId });
  });

  it("keeps the fullest console before the week within thirteen rows", async () => {
    const lots = Array.from({ length: 9 }, (_, index) => ({
      ...priced,
      lot: {
        ...priced.lot,
        lotId: `01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b${index.toString(16).padStart(2, "0")}`,
      },
    }));
    const auction = fakeAuction({
      status: "scheduled",
      week: {
        ...week,
        final: true,
        raffleClosesAt: "2026-10-22T15:00:00Z",
        rafflePrize: "Кружка",
      },
      lots,
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    expect(labels(last(calls))[1]).toEqual([
      "Сроки недели",
      "Снять с публикации",
    ]);
    expect(labels(last(calls)).length).toBeLessThanOrEqual(13);
  });

  it("offers neither button once the week is open and names it for an old button", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(JSON.stringify(last(calls))).not.toContain("Опубликовать");
    expect(JSON.stringify(last(calls))).not.toContain("Снять с публикации");
    expect(plain(last(calls))).not.toContain("Виден участникам.");

    await bot.handleUpdate(press(`v1:ac:p:${auctionToken}:0`));
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя уже открыта</b>\n\nАукцион виден участникам, снять его нельзя.",
    );
  });

  it("answers a cancelled meetup with text, not a failure", async () => {
    const auction = fakeAuction({
      hidden: true,
      visibility: { kind: "meetup-cancelled" },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:p:${auctionToken}:1`));
    expect(auction.sent("publishAuction")).toHaveLength(1);
    expect(plain(last(calls))).toContain(
      "Сходку отменили. Управлять её аукционом больше нельзя.",
    );
  });

  it("answers Auction not taking the person for the administrator with text, not a failure", async () => {
    const auction = fakeAuction({
      hidden: true,
      visibility: { kind: "not-administrator" },
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:p:${auctionToken}:1`));
    expect(auction.sent("publishAuction")).toHaveLength(1);
    expect(last(calls).text).toContain("Это действие тебе недоступно.");
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

// Отмена после старта торгов (PER-606; ADR-047, дополнение 2026-10-12): та же
// форма, что у удаления, но подтверждение называет проданные лоты.
describe("cancelling the auction", () => {
  const soldMug: ConsoleLot = {
    ...mug,
    lot: {
      ...mug.lot,
      status: {
        kind: "sold",
        winnerId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ee",
        price: rub(50_000),
      },
    },
    markedForFinal: false,
    overdue: false,
  };

  it("offers the cancel once trading is open and cancels only after the confirmation", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase, soldMug],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(JSON.stringify(last(calls))).not.toContain("Удалить аукцион");

    await bot.handleUpdate(press(dataOf(last(calls), "Отменить аукцион")));
    const confirm = last(calls);
    expect(plain(confirm)).toContain("Отменить аукцион?");
    expect(plain(confirm)).toContain(
      "У сходки идут торги: аукцион будет отменён, проданные лоты (1) останутся проданными.",
    );
    expect(plain(confirm)).toContain(
      "Отменить нельзя: нового аукциона у этой сходки не будет.",
    );
    expect(labels(confirm)).toEqual([["✔️ Да, отменить аукцион", "✖️ Нет"]]);
    expect(dataOf(confirm, "✖️ Нет")).toBe(consoleData);
    expect(auction.sent("cancelAuction")).toEqual([]);

    const yes = dataOf(confirm, "✔️ Да, отменить аукцион");
    await bot.handleUpdate(press(yes));
    expect(auction.state.status).toBe("cancelled");
    expect(last(calls).text).toBe(
      "<b>Аукцион отменён</b>\n\nПроданные лоты остались проданными, остальные сняты с торгов.",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);

    // Пульт отменённого — статус без команд отмены и удаления.
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "Аукцион отменён: проданные лоты остались проданными.",
    );
    expect(JSON.stringify(last(calls))).not.toContain("Отменить аукцион");

    // Повторное «Да» несёт тот же ключ: Auction примет его как повтор.
    await bot.handleUpdate(press(yes));
    const [first, second] = auction.sent("cancelAuction");
    expect(second?.args).toEqual(first?.args);
  });

  it("offers no cancel before trading and names it for an old button", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(JSON.stringify(last(calls))).not.toContain("Отменить аукцион");

    await bot.handleUpdate(press(`v1:ac:u:${auctionToken}`));
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя ещё не открыта</b>\n\nОтменять нечего: аукцион можно удалить.",
    );
    expect(auction.sent("cancelAuction")).toEqual([]);
  });

  it("refuses an old cancel button of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ status: "prebidding", lots: [vase] });
    const { bot, calls } = harness("member", auction);
    await bot.init();

    for (const data of [
      `v1:ac:u:${auctionToken}`,
      `v1:ac:uy:${auctionToken}:${uuidToToken(vaseId)}`,
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
      "Состав финала объявлен.\nВремя финала: не выставлено.\n\n1. Ваза — 1 200 ₽\n2. Кружка — 500 ₽",
    );
    expect(labels(last(calls))).toEqual([
      ["Начать финал"],
      ["Отменить аукцион"],
      ["🔄 Обновить"],
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
      ["Отменить аукцион"],
      ["🔄 Обновить"],
      ["‹ Аукцион"],
    ]);

    // Порог вопроса — следующая цена (PER-640): сумма не выше неё до Auction
    // не доходит, и исход называет тот же порог.
    await next((history) => press(dataOf(last(history), "Поднять цену")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:fa:${auctionToken}:0:42`);
    expect(spaced(asked.text ?? "")).toContain(
      "Лот: Ваза\nСейчас следующая цена: 1 300 ₽\nНовая следующая цена в целых рублях, выше 1 300 ₽. Например: 1400",
    );
    await next((history) => answer(history, { text: "1250" }));
    expect(spaced(last(calls).text ?? "")).toBe(
      "<b>Новая цена должна быть выше 1 300 ₽</b>",
    );
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Пульт"]]);
    expect(auction.sent("advanceAsk")).toEqual([]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) => answer(history, { text: "1300" }));
    expect(spaced(last(calls).text ?? "")).toBe(
      "<b>Новая цена должна быть выше 1 300 ₽</b>",
    );
    expect(auction.sent("advanceAsk")).toEqual([]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) => answer(history, { text: "1 500" }));
    expect(auction.sent("advanceAsk").map((each) => each.args)).toEqual([
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
      ["Отменить аукцион"],
      ["🔄 Обновить"],
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

  // Повторная доставка того же сообщения Telegram (PER-699): ключ команды —
  // из самого сообщения, и Auction отвечает исходным исходом, не поднимая
  // цену второй раз. Новое сообщение с той же ценой — новая команда.
  describe("repeated answer of the host", () => {
    async function openAsk() {
      const auction = frozen();
      const calls: RecordedCall[] = [];
      const next = async (update: (history: RecordedCall[]) => Update) => {
        const { bot } = harness("admin", auction, calls);
        await bot.init();
        await bot.handleUpdate(update(calls));
      };
      await next(() => press(consoleData));
      await next((history) => press(dataOf(last(history), "Начать финал")));
      await next((history) =>
        press(dataOf(last(history), "Открыть первый лот")),
      );
      await next((history) => press(dataOf(last(history), "Поднять цену")));
      return { auction, calls, next };
    }
    // Ключи отправленных `AdvanceAsk`: журнал команд фейка хранит аргументы
    // без типа, а у этой команды ключ всегда есть.
    const askKeys = (auction: ReturnType<typeof fakeAuction>) =>
      auction
        .sent("advanceAsk")
        .map((each) => (each.args as { opId: string }).opId);

    it("raises the ask once when the same message of the host is delivered twice at once", async () => {
      const { auction, calls } = await openAsk();
      const reply = answer(calls, { text: "1 500" });
      // Два процесса получили то же сообщение одновременно (повтор доставки
      // во время выкладки): оба прочитали пульт до команды и оба прошли порог.
      const one = harness("admin", auction, calls);
      const other = harness("admin", auction, calls);
      await Promise.all([one.bot.init(), other.bot.init()]);

      await Promise.all([
        one.bot.handleUpdate(reply),
        other.bot.handleUpdate(reply),
      ]);

      const keys = askKeys(auction);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
      expect(auction.state.raisedAsks).toBe(1);
    });

    it("refuses a later repeat of the same message before Auction", async () => {
      const { auction, calls, next } = await openAsk();
      const reply = answer(calls, { text: "1 500" });

      await next(() => reply);
      await next(() => reply);

      // Последовательный повтор отсекает порог бота: следующая цена уже 1 500.
      expect(auction.sent("advanceAsk")).toHaveLength(1);
      expect(auction.state.raisedAsks).toBe(1);
    });

    it("sends a new command for a new message of the host with the same price", async () => {
      const { auction, calls, next } = await openAsk();
      // Два сообщения ответом на один вопрос: второе — новое, со своим id.
      const first = answer(calls, { text: "1 500" });
      const second = answer(calls, { text: "1 500" });
      // `Update` отдаёт сообщение только для чтения: id правится приведением.
      (second.message as { message_id: number }).message_id = 11;
      await next(() => first);
      // Следующая цена снова 1 300 ₽: иначе 1 500 не прошло бы порог бота, и
      // второе сообщение не дошло бы до Auction.
      auction.state.lots = auction.state.lots.map((each) =>
        each.lot.lotId === vaseId
          ? { ...each, lot: { ...each.lot, nextPrice: rub(130_000) } }
          : each,
      );
      await next(() => second);

      const keys = askKeys(auction);
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });
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
      "Онлайн-торги закончились: перерыв перед финалом.\nВремя финала: не выставлено.\nВ финал отмечены: 3 лота.",
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
      "Состав финала объявлен.\nВремя финала: не выставлено.\n\n1. Кружка — 500 ₽\n2. Лампа — 800 ₽\n3. Ваза — 1 200 ₽",
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
    // В онлайн-торгах ряд запуска окна есть (PER-615).
    expect(labels(last(calls))).toEqual([
      ["Окно 1"],
      ["Запустить окно"],
      ["‹ Пульт"],
    ]);
    // Окно открывается только для чтения: переключателей и удаления нет.
    await bot.handleUpdate(press(dataOf(last(calls), "Окно 1")));
    expect(plain(last(calls))).toContain("• Ваза");
    expect(labels(last(calls))).toEqual([["‹ Счастливые часы"]]);
  });

  it("launches a window from the console and shows it next to the announced ones", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true, windows: [] },
      lots: [vase, mug],
    });
    const calls: RecordedCall[] = [];
    // Новый бот на каждом шаге — рестарт посреди запуска: шаг вопроса едет в
    // кнопке «Отмена», а черновик — в кнопках экрана запуска.
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    await next((history) => press(dataOf(last(history), "Счастливые часы")));
    await next((history) => press(dataOf(last(history), "Запустить окно")));

    const asked = question(calls);
    expect(dataOf(asked.payload, "Отмена")).toBe(`v1:q:al:${auctionToken}:42`);
    expect(asked.payload.text).toContain("Неделя:");

    await next((history) =>
      answer(history, { text: "сейчас — 21.10.2026 21:00, 50" }),
    );

    // Экран запуска: сроки и шаг окна, лоты реестра переключателями и ряд
    // запуска.
    expect(plain(last(calls))).toContain("шаг 50 ₽");
    expect(plain(last(calls))).toContain("лотов 2 из 2");
    expect(labels(last(calls))).toEqual([
      ["Вкл · Ваза"],
      ["Вкл · Кружка"],
      ["Запустить окно"],
      ["‹ Счастливые часы"],
    ]);

    await next((history) => press(dataOf(last(history), "Запустить окно")));

    expect(plain(last(calls))).toContain("Окно запущено");
    expect(auction.sent("launchStepWindow").map((call) => call.args)).toEqual([
      expect.objectContaining({
        auctionId: expect.any(String),
        until: "2026-10-21T18:00:00Z",
        step: { minorUnits: 5_000, currency: "RUB" },
        lotIds: [vaseId, mugId],
      }),
    ]);
  });

  it("covers the first sixty four lots of a bigger registry and says so", async () => {
    const many = Array.from({ length: 70 }, (_, index) => ({
      ...vase,
      lot: trading(
        `01929b7e-5c1d-7a3f-8e4b-2d6c9f0a${index.toString(16).padStart(4, "0")}`,
        `Лот ${index + 1}`,
        120_000,
      ),
    }));
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true, windows: [] },
      lots: many,
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Счастливые часы")));
    await bot.handleUpdate(press(dataOf(last(calls), "Запустить окно")));
    await bot.handleUpdate(
      answer(calls, { text: "сейчас — 21.10.2026 21:00, 50" }),
    );

    // Набор лотов едет в кнопке маской на 64 лота: окно накрывает первые
    // 64 лота реестра, и пульт говорит об этом прямо.
    expect(plain(last(calls))).toContain("лотов 64 из 64");
    expect(plain(last(calls))).toContain(
      "Окно накрывает первые 64 лотов реестра",
    );
  });

  it("shows the launched window next to the announced ones", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true, windows: [] },
      lots: [vase],
      launchedWindows: [
        {
          from: "2026-10-21T15:00:00Z",
          until: "2026-10-21T18:00:00Z",
          step: { minorUnits: 5_000, currency: "RUB" },
          lotIds: [vaseId],
        },
      ],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "Счастливые часы")));

    expect(plain(last(calls))).toContain("Запущенные окна:");
    expect(plain(last(calls))).toContain("шаг 50 ₽");
  });
});

// Сеты лотов (ADR-073, PER-509): вход «🛠 Сеты» корня аукциона, сет
// рождается пустым по названию, лоты выбираются переключателями, после
// открытия недели сеты только видны.
describe("lot sets", () => {
  const lampId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
  const lamp: ConsoleLot = {
    lot: { ...trading(lampId, "Лампа", 0), status: { kind: "draft" } },
    bidCount: 0,
    uniqueParticipantCount: 0,
    markedForFinal: false,
    overdue: false,
  };
  const setsData = `v1:ac:t:${auctionToken}`;
  const mugsId = "0199a000-0000-7000-8000-000000000001";
  const othersId = "0199a000-0000-7000-8000-000000000002";

  function steps(auction: ReturnType<typeof fakeAuction>) {
    const calls: RecordedCall[] = [];
    // Каждый шаг — новый бот: состояния у сетов нет, всё едет в кнопке.
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };
    return { calls, next };
  }

  // Повтор того же ответа (PER-699): идентификатор сета и ключ команды — из
  // сообщения, поэтому повтор открывает уже заведённый сет, а не заводит
  // второй и не шлёт пустой состав поверх лотов, которые в сет уже добавили.
  it("keeps one set when the same name answer is delivered twice", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced, unpriced, lamp],
    });
    const { calls, next } = steps(auction);
    await next(() => press(rootData));
    await next((history) => press(dataOf(last(history), "🛠 Сеты")));
    await next((history) => press(dataOf(last(history), "Новый сет")));
    const reply = answer(calls, { text: "Кружки" });

    await next(() => reply);
    await next(() => reply);

    expect(auction.sent("saveLotSet")).toHaveLength(1);
    expect(auction.state.lotSets.map((set) => set.name)).toEqual(["Кружки"]);
    // Повтор открыл тот же сет, как и первый ответ.
    expect(plain(last(calls))).toContain("Кружки");
  });

  it("names a new set, fills it with three lots and survives a restart at every step", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced, unpriced, lamp],
    });
    const { calls, next } = steps(auction);

    await next(() => press(rootData));
    await next((history) => press(dataOf(last(history), "🛠 Сеты")));
    expect(plain(last(calls))).toContain("Сетов пока нет.");
    expect(labels(last(calls))).toEqual([["Новый сет"], ["‹ Аукцион"]]);

    await next((history) => press(dataOf(last(history), "Новый сет")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:as:${auctionToken}:42`);
    expect(asked.text).toContain("Название сета одной строкой");

    // Пустое название бот не отдаёт Auction: тот же вопрос заново.
    await next((history) => answer(history, { text: "   " }));
    expect(last(calls).text).toBe(
      "<b>Название пустое</b>\n\nНапиши название сета.",
    );
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Сеты"]]);
    expect(auction.sent("saveLotSet")).toEqual([]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) => answer(history, { text: " Кружки " }));

    expect(auction.sent("saveLotSet")).toEqual([
      {
        method: "saveLotSet",
        args: {
          auctionId,
          lotSetId: expect.any(String),
          name: "Кружки",
          lotIds: [],
          opId: expect.any(String),
        },
      },
    ]);
    expect(plain(last(calls))).toContain(
      "В сете 0 лотов. Неполный: участники увидят сет, когда в нём будет хотя бы два лота.",
    );
    expect(labels(last(calls))).toEqual([
      ["Выкл · Ваза"],
      ["Выкл · Кружка"],
      ["Выкл · Лампа"],
      ["🗑 Удалить сет"],
      ["‹ Сеты"],
    ]);

    await next((history) => press(dataOf(last(history), "Выкл · Ваза")));
    expect(toasts(calls).at(-1)).toBe("Лот добавлен в сет.");
    await next((history) => press(dataOf(last(history), "Выкл · Кружка")));
    await next((history) => press(dataOf(last(history), "Выкл · Лампа")));
    // Каждая команда несёт весь состав: второе нажатие видит лот первого.
    expect(
      auction
        .sent("saveLotSet")
        .map((each) => (each.args as { lotIds: string[] }).lotIds),
    ).toEqual([[], [vaseId], [vaseId, mugId], [vaseId, mugId, lampId]]);
    expect(auction.state.lotSets).toEqual([
      {
        lotSetId: expect.any(String),
        name: "Кружки",
        lotIds: [vaseId, mugId, lampId],
      },
    ]);
    expect(plain(last(calls))).toContain("В сете 3 лота.");

    // Повтор нажатия с прежнего экрана — целевое состояние: команды нет.
    const sent = auction.sent("saveLotSet").length;
    const full = last(calls);
    await next(() => press(dataOf(full, "Вкл · Лампа")));
    expect(toasts(calls).at(-1)).toBe("Лот убран из сета.");
    await next(() => press(dataOf(full, "Вкл · Лампа")));
    expect(auction.sent("saveLotSet")).toHaveLength(sent + 1);
    await next((history) => press(dataOf(last(history), "Выкл · Лампа")));
    expect(auction.sent("saveLotSet")).toHaveLength(sent + 2);
    expect(auction.state.lotSets[0]?.lotIds).toEqual([vaseId, mugId, lampId]);

    await next((history) => press(dataOf(last(history), "‹ Сеты")));
    expect(plain(last(calls))).toContain("1. Кружки — 3 лота");
    expect(labels(last(calls))).toEqual([
      ["Кружки · 3 лота"],
      ["Новый сет"],
      ["‹ Аукцион"],
    ]);
  });

  it("refuses a change after the online week opened with a plain text and sends nothing", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced, unpriced],
      lotSets: [{ lotSetId: mugsId, name: "Кружки", lotIds: [vaseId] }],
    });
    const { calls, next } = steps(auction);
    await next(() => press(setsData));
    expect(plain(last(calls))).toContain("1. Кружки — 1 лот, неполный");
    expect(plain(last(calls))).toContain(
      "Неполный сет участники не видят: в сете нужно хотя бы два лота.",
    );
    await next((history) => press(dataOf(last(history), "Кружки · 1 лот")));
    const editable = last(calls);

    // Неделю открыли, пока экран сета висел в чате.
    auction.state.status = "prebidding";
    await next(() => press(dataOf(editable, "Выкл · Кружка")));
    expect(last(calls).text).toBe(
      "<b>Торги уже начались</b>\n\nСеты этого аукциона больше не меняются.",
    );
    expect(labels(last(calls))).toEqual([["‹ Сеты"]]);
    await next(() => press(dataOf(editable, "🗑 Удалить сет")));
    expect(last(calls).text).toBe(
      "<b>Торги уже начались</b>\n\nСеты этого аукциона больше не меняются.",
    );
    expect(auction.sent("saveLotSet")).toEqual([]);
    expect(auction.sent("deleteLotSet")).toEqual([]);

    // После открытия сеты видны только для просмотра.
    await next(() => press(setsData));
    expect(plain(last(calls))).toContain("сеты больше не меняются");
    expect(labels(last(calls))).toEqual([["Кружки · 1 лот"], ["‹ Аукцион"]]);
    await next((history) => press(dataOf(last(history), "Кружки · 1 лот")));
    expect(plain(last(calls))).toContain("• Ваза");
    expect(labels(last(calls))).toEqual([["‹ Сеты"]]);
  });

  it("answers Auction's frozen refusal with the same text", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
      lotSets: [{ lotSetId: mugsId, name: "Кружки", lotIds: [] }],
    });
    const { calls, next } = steps(auction);
    await next(() => press(setsData));
    await next((history) => press(dataOf(last(history), "Кружки · 0 лотов")));
    // Чтение пульта отстаёт от открытия недели: отказ приходит от Auction.
    const save = auction.port.saveLotSet;
    auction.port.saveLotSet = async () => ({ kind: "lots-frozen" });
    await next((history) => press(dataOf(last(history), "Выкл · Ваза")));
    auction.port.saveLotSet = save;
    expect(last(calls).text).toBe(
      "<b>Торги уже начались</b>\n\nСеты этого аукциона больше не меняются.",
    );
  });

  it("names the set that holds a lot and does not ask Auction to move it", async () => {
    const auction = fakeAuction({
      status: "draft",
      lots: [priced, unpriced],
      lotSets: [
        { lotSetId: mugsId, name: "Кружки", lotIds: [] },
        { lotSetId: othersId, name: "Вазы", lotIds: [vaseId] },
      ],
    });
    const { calls, next } = steps(auction);
    await next(() => press(setsData));
    await next((history) => press(dataOf(last(history), "Кружки · 0 лотов")));
    expect(labels(last(calls))).toContainEqual(["Выкл · Ваза · в сете «Вазы»"]);
    await next((history) =>
      press(dataOf(last(history), "Выкл · Ваза · в сете «Вазы»")),
    );
    expect(last(calls).text).toBe(
      "<b>Лот уже в сете «Вазы»</b>\n\nСначала убери его оттуда.",
    );
    expect(auction.sent("saveLotSet")).toEqual([]);
  });

  it("deletes a set after the confirmation and refuses a button of a set gone since", async () => {
    const auction = fakeAuction({
      status: "draft",
      lots: [priced],
      lotSets: [
        { lotSetId: mugsId, name: "Кружки", lotIds: [vaseId] },
        { lotSetId: othersId, name: "Вазы", lotIds: [] },
      ],
    });
    const { calls, next } = steps(auction);
    await next(() => press(setsData));
    await next((history) => press(dataOf(last(history), "Кружки · 1 лот")));
    await next((history) => press(dataOf(last(history), "🗑 Удалить сет")));
    expect(plain(last(calls))).toContain("Удалить сет?");
    expect(labels(last(calls))).toEqual([["✔️ Да, удалить", "✖️ Нет"]]);
    const confirm = last(calls);
    await next(() => press(dataOf(confirm, "✔️ Да, удалить")));
    expect(auction.sent("deleteLotSet")).toEqual([
      {
        method: "deleteLotSet",
        args: { auctionId, lotSetId: mugsId, opId: expect.any(String) },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Сет удалён</b>\n\n<b>Кружки</b>\n\nЛоты остались в аукционе.",
    );
    expect(auction.state.lotSets.map((each) => each.name)).toEqual(["Вазы"]);

    // Номер «Кружек» теперь у «Ваз», но отпечаток не тот: команды нет.
    await next(() => press(dataOf(confirm, "✔️ Да, удалить")));
    expect(last(calls).text).toBe(
      "<b>Сеты изменились</b>\n\nОткрой сет заново.",
    );
    expect(auction.sent("deleteLotSet")).toHaveLength(1);
  });
});

describe("day summary screen", () => {
  const auctionBot = "solguficky_auction_bot";
  const summaryData = `v1:ac:ds:${auctionToken}`;

  it("shows the three metrics of the day with links to the lots in the auction bot", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [vase, mug],
      day: [
        {
          lotId: vaseId,
          bidCount: 4,
          maxPrice: rub(180_000),
          growth: rub(60_000),
          leaderChangeCount: 2,
          longestDuel: 2,
        },
        {
          lotId: mugId,
          bidCount: 7,
          maxPrice: rub(50_000),
          growth: rub(10_000),
          leaderChangeCount: 5,
          longestDuel: 3,
        },
      ],
    });
    const { bot, calls } = harness("admin", auction, [], undefined, auctionBot);
    await bot.init();

    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(summaryData));

    const screen = plain(last(calls));
    expect(screen).toContain("Сводка дня");
    expect(screen).toContain("Новые максимумы цены:");
    expect(screen).toContain("Спорнее всех:");
    expect(screen).toContain("Больше всех выросла цена:");
    expect(screen).toContain(
      `https://t.me/${auctionBot}?start=l_${uuidToToken(vaseId)}`,
    );
    expect(screen).toContain(
      `https://t.me/${auctionBot}?start=l_${uuidToToken(mugId)}`,
    );
    // Оба лота — в сводке: дороже всех Ваза, оспореннее всех Кружка — по
    // сменам лидера, а не по числу ставок (PER-511).
    expect(screen).toContain("5 смен лидера");
    expect(screen).toContain("Ваза");
    expect(screen).toContain("Кружка");
    expect(labels(last(calls))).toEqual([["‹ Пульт"]]);
    expect(auction.windows).toEqual([
      {
        auctionId,
        from: "2026-10-05T21:00:00Z",
        until: now.toISOString(),
      },
    ]);
  });

  // PER-511: «тёмная лошадка» — среди лотов, у которых до суток было не больше
  // трёх ставок, «эпичная дуэль» — от четырёх перебиваний подряд вдвоём.
  it("names the dark horse among the lots with few bids before the day and the epic duel", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [
        { ...vase, bidCount: 4, priceGrowth: rub(90_000) },
        { ...mug, bidCount: 20, priceGrowth: rub(200_000) },
      ],
      day: [
        {
          lotId: vaseId,
          bidCount: 3,
          maxPrice: rub(210_000),
          leaderChangeCount: 2,
          longestDuel: 2,
        },
        {
          lotId: mugId,
          bidCount: 3,
          maxPrice: rub(250_000),
          leaderChangeCount: 5,
          longestDuel: 5,
        },
      ],
    });
    const { bot, calls } = harness("admin", auction, [], undefined, auctionBot);
    await bot.init();

    await bot.handleUpdate(press(summaryData));

    const lines = plain(last(calls)).split("\n");
    const lineUnder = (heading: string): string =>
      lines[lines.indexOf(heading) + 1] ?? "";
    // Кружка выросла больше, но до этого дня у неё было 17 ставок.
    expect(lineUnder("Тёмная лошадка:")).toContain("Ваза");
    expect(lineUnder("Тёмная лошадка:")).toContain("1 ставка до этого дня");
    expect(lineUnder("Эпичная дуэль:")).toContain("Кружка");
    expect(lineUnder("Эпичная дуэль:")).toContain(
      "5 перебиваний подряд вдвоём",
    );
  });

  it("leaves the dark horse and the duel out below their thresholds", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [{ ...vase, bidCount: 7, priceGrowth: rub(90_000) }],
      day: [
        {
          lotId: vaseId,
          bidCount: 3,
          maxPrice: rub(210_000),
          leaderChangeCount: 3,
          longestDuel: 3,
        },
      ],
    });
    const { bot, calls } = harness("admin", auction, [], undefined, auctionBot);
    await bot.init();

    await bot.handleUpdate(press(summaryData));

    const screen = plain(last(calls));
    expect(screen).toContain("Спорнее всех:");
    expect(screen).not.toContain("Тёмная лошадка:");
    expect(screen).not.toContain("Эпичная дуэль:");
  });

  it("says a day without bids had none instead of an empty screen", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [vase, mug],
      day: [
        { lotId: vaseId, bidCount: 0, leaderChangeCount: 0, longestDuel: 0 },
        { lotId: mugId, bidCount: 0, leaderChangeCount: 0, longestDuel: 0 },
      ],
    });
    const { bot, calls } = harness("admin", auction, [], undefined, auctionBot);
    await bot.init();

    await bot.handleUpdate(press(summaryData));

    const screen = plain(last(calls));
    expect(screen).toContain("Сводка дня");
    expect(screen).toContain("Ставок не было.");
    expect(screen).not.toContain("Новые максимумы цены:");
  });

  it("leaves the lots without links when the auction bot has no name", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      lots: [vase],
      day: [
        {
          lotId: vaseId,
          bidCount: 1,
          maxPrice: rub(120_000),
          leaderChangeCount: 0,
          longestDuel: 0,
        },
      ],
    });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(summaryData));

    const screen = plain(last(calls));
    expect(screen).toContain("Ваза");
    expect(screen).not.toContain("https://t.me/");
  });
});

describe("day summary without lots", () => {
  it("says the auction has no lots instead of a day without bids", async () => {
    const auction = fakeAuction({ status: "prebidding", lots: [], day: [] });
    const { bot, calls } = harness("admin", auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:ds:${auctionToken}`));

    const screen = plain(last(calls));
    expect(screen).toContain("Лотов в аукционе пока нет.");
    expect(screen).not.toContain("Ставок не было.");
  });
});

// Живой пульт ведущего (PER-566): после чужой ставки пульт финала правится по
// потоку аукциона без нажатия, а состояние потока — только повод перечитать
// пульт тем же чтением, что «Обновить». Поток подменён: тест сам кладёт в него
// состояния, обрыв и конец.
// Поток аукциона в тестах живых экранов (PER-566, PER-565): подписчики,
// состояние, обрыв и конец.
type Subscriber = {
  listener: (state: AuctionWatchState) => void;
  ended?: () => void;
  interrupted?: () => void;
};

function stream() {
  const subscribers = new Set<Subscriber>();
  const watches: AuctionWatches = {
    subscribe(_auctionId, _viewer, listener, ended, interrupted) {
      const subscriber: Subscriber = {
        listener,
        ...(ended === undefined ? {} : { ended }),
        ...(interrupted === undefined ? {} : { interrupted }),
      };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    open: () => (subscribers.size > 0 ? 1 : 0),
    close: () => subscribers.clear(),
  };
  const each = (run: (subscriber: Subscriber) => void) => {
    for (const subscriber of [...subscribers]) run(subscriber);
  };
  return {
    watches,
    subscribers,
    emit(activeLot: LotView, finished = false) {
      each((subscriber) =>
        subscriber.listener({
          auctionId,
          finished,
          activeLot,
          lineup: [activeLot],
        }),
      );
    },
    interrupt: () => each((subscriber) => subscriber.interrupted?.()),
    end: () => each((subscriber) => subscriber.ended?.()),
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

describe("live console of the auctioneer", () => {
  const leaderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ee";
  const live = (lotId: string, version: number, price: number): LotView => ({
    ...trading(lotId, lotId === vaseId ? "Ваза" : "Кружка", price),
    version,
    nextPrice: rub(price + 10_000),
    status: {
      kind: "trading",
      currentPrice: rub(price),
      leaderId,
      phase: "live",
    },
  });
  const entry = (lot: LotView): ConsoleLot => ({
    lot,
    bidCount: 2,
    uniqueParticipantCount: 1,
    markedForFinal: true,
    overdue: false,
  });
  // Финал идёт, Ваза торгуется первой.
  const running = () => {
    const auction = fakeAuction({
      status: "final",
      week: { ...week, final: true },
      lots: [entry(live(vaseId, 3, 120_000)), entry(live(mugId, 3, 50_000))],
      lineup: [vaseId, mugId],
      bids: [{ amount: rub(120_000), participantId: leaderId }],
      names: { [leaderId]: "Бэтмен" },
    });
    auction.state.lineup = { order: [vaseId, mugId], activeLotId: vaseId };
    return auction;
  };

  // Ставка в Auction: цена лота растёт вместе с его версией.
  const bid = (
    auction: ReturnType<typeof running>,
    version: number,
    price: number,
  ) => {
    const lot = live(vaseId, version, price);
    auction.state.lots = auction.state.lots.map((each) =>
      each.lot.lotId === vaseId ? entry(lot) : each,
    );
    return lot;
  };

  // Правки сообщения пульта: нажатие правит сообщение 9 тоже, поэтому тест
  // считает правки после него.
  const edits = (calls: readonly RecordedCall[]) =>
    calls.filter(
      (call) =>
        call.method === "editMessageText" &&
        (call.payload as { message_id?: number }).message_id === 9,
    );

  const setup = async (
    limiter: EditLimiter = immediate,
    respond?: HarnessOptions["respond"],
  ) => {
    const watch = stream();
    const auction = running();
    const { bot, calls } = harness("admin", auction, [], undefined, undefined, {
      live: {
        watches: watch.watches,
        limiter,
        names: { getDisplayNames: async () => ({}) },
      },
      ...(respond === undefined ? {} : { respond }),
    });
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    return { bot, calls, auction, watch };
  };

  it("shows the new price after a bid without a press", async () => {
    const { calls, auction, watch } = await setup();
    expect(plain(last(calls))).toContain("Цена: 1 200 ₽, следующая: 1 300 ₽.");
    expect(watch.subscribers.size).toBe(1);
    const before = edits(calls).length;
    const reads = auction.sent("getAuctionConsole").length;

    watch.emit(bid(auction, 4, 130_000));
    await flush();

    expect(edits(calls)).toHaveLength(before + 1);
    const edited = edits(calls).at(-1)?.payload as Sent;
    expect(plain(edited)).toContain("Цена: 1 300 ₽, следующая: 1 400 ₽.");
    expect(plain(edited)).toContain("Лидер: Бэтмен.");
    expect(labels(edited)).toEqual([
      ["Поднять цену"],
      ["Продать"],
      ["Отменить аукцион"],
      ["🔄 Обновить"],
      ["‹ Аукцион"],
    ]);
    expect(auction.sent("getAuctionConsole")).toHaveLength(reads + 1);
  });

  it("does not read the console again for a state it already shows", async () => {
    const { calls, auction, watch } = await setup();
    const before = edits(calls).length;
    const reads = auction.sent("getAuctionConsole").length;

    watch.emit(live(vaseId, 3, 120_000));
    await flush();

    expect(edits(calls)).toHaveLength(before);
    expect(auction.sent("getAuctionConsole")).toHaveLength(reads);
  });

  // Рестарт Auction посреди финала: поток рвётся, и пульт говорит, что цена
  // могла устареть, не спрашивая лежащий Auction; первое состояние после
  // переподключения перечитывает пульт и пометку снимает.
  it("marks the price stale while the stream reconnects", async () => {
    const { calls, auction, watch } = await setup();
    const before = edits(calls).length;
    const reads = auction.sent("getAuctionConsole").length;

    watch.interrupt();
    watch.interrupt();
    await flush();

    expect(edits(calls)).toHaveLength(before + 1);
    const marked = edits(calls).at(-1)?.payload as Sent;
    expect(plain(marked)).toContain(
      "Связь с аукционом прервалась — цена могла устареть. Нажми «Обновить».",
    );
    expect(plain(marked)).toContain("Цена: 1 200 ₽, следующая: 1 300 ₽.");
    expect(auction.sent("getAuctionConsole")).toHaveLength(reads);

    watch.emit(live(vaseId, 3, 120_000));
    await flush();

    expect(edits(calls)).toHaveLength(before + 2);
    const restored = edits(calls).at(-1)?.payload as Sent;
    expect(plain(restored)).not.toContain("Связь с аукционом прервалась");
    expect(plain(restored)).toContain("Цена: 1 200 ₽, следующая: 1 300 ₽.");
  });

  it("marks the price stale when the console cannot be read", async () => {
    const { calls, auction, watch } = await setup();
    auction.port.getAuctionConsole = async () => {
      throw new Error("unavailable");
    };

    watch.emit(bid(auction, 4, 130_000));
    await flush();

    const marked = edits(calls).at(-1)?.payload as Sent;
    expect(plain(marked)).toContain("Связь с аукционом прервалась");
    expect(plain(marked)).toContain("Цена: 1 200 ₽");
  });

  // Чтение по потоку снимает пульт сразу, а отдаёт по сигналу теста: так
  // видно, что случилось, пока оно было в полёте.
  const heldRead = (auction: ReturnType<typeof running>) => {
    const original = auction.port.getAuctionConsole;
    let release: () => void = () => {};
    let held = true;
    auction.port.getAuctionConsole = async (...args) => {
      const result = await original(...args);
      if (held) {
        held = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return result;
    };
    return () => release();
  };

  it("keeps the stale mark when the stream breaks off during a read", async () => {
    const { calls, auction, watch } = await setup();
    const release = heldRead(auction);

    watch.emit(bid(auction, 4, 130_000));
    await flush();
    watch.interrupt();
    await flush();
    release();
    await flush();

    const shown = edits(calls).at(-1)?.payload as Sent;
    expect(plain(shown)).toContain("Связь с аукционом прервалась");
    expect(plain(shown)).toContain("Цена: 1 300 ₽");
  });

  it("does not paint a read older than the press over it", async () => {
    const { bot, calls, auction, watch } = await setup();
    const release = heldRead(auction);

    watch.emit(bid(auction, 4, 130_000));
    await flush();
    bid(auction, 5, 140_000);
    await bot.handleUpdate(press(consoleData));
    expect(plain(last(calls))).toContain("Цена: 1 400 ₽");
    release();
    await flush();

    expect(plain(last(calls))).toContain("Цена: 1 400 ₽");
  });

  it("stops following the stream once another screen takes the message", async () => {
    const { bot, calls, auction, watch } = await setup();
    await bot.handleUpdate(press(rootData));
    expect(watch.subscribers.size).toBe(0);
    const before = edits(calls).length;

    watch.emit(bid(auction, 4, 130_000));
    await flush();

    expect(edits(calls)).toHaveLength(before);
  });

  it("shows the last state and leaves the stream when the final is over", async () => {
    const { calls, auction, watch } = await setup();
    auction.state.status = "finished";
    auction.state.lineup = { order: [vaseId, mugId] };

    watch.emit(live(vaseId, 5, 130_000), true);
    watch.end();
    await flush();

    expect(plain(last(calls))).toContain("Аукцион завершён.");
    expect(watch.subscribers.size).toBe(0);
  });

  // Залп ставок: правка идёт не чаще раза в секунду на чат, чтение — одно на
  // правку, последняя цена не теряется, а `429` встаёт паузой, которую назвал
  // Telegram, а не повтором подряд.
  it("keeps to the edit limits of Telegram under a volley of bids", async () => {
    let now = 0;
    const timers: { at: number; run: () => void; live: boolean }[] = [];
    const clock: Clock = {
      now: () => now,
      later(run, ms) {
        const timer = { at: now + ms, run, live: true };
        timers.push(timer);
        return () => {
          timer.live = false;
        };
      },
    };
    const advance = async (ms: number) => {
      const until = now + ms;
      await flush();
      for (;;) {
        const due = timers
          .filter((t) => t.live && t.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.live = false;
        now = Math.max(now, due.at);
        due.run();
        await flush();
      }
      now = until;
      await flush();
    };
    let tooMany = 0;
    const { calls, auction, watch } = await setup(
      createEditLimiter({ clock }),
      (method, payload) => {
        if (
          method !== "editMessageText" ||
          (payload as { message_id?: number }).message_id !== 9 ||
          tooMany === 0
        ) {
          return undefined;
        }
        tooMany -= 1;
        return {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 2",
          parameters: { retry_after: 2 },
        };
      },
    );
    const before = edits(calls).length;
    const reads = auction.sent("getAuctionConsole").length;

    for (let step = 1; step <= 50; step += 1) {
      watch.emit(bid(auction, 3 + step, 120_000 + step * 10_000));
    }
    await advance(0);
    expect(edits(calls)).toHaveLength(before + 1);
    await advance(999);
    expect(edits(calls)).toHaveLength(before + 1);
    await advance(1);
    expect(edits(calls)).toHaveLength(before + 2);
    expect(plain(edits(calls).at(-1)?.payload as Sent)).toContain(
      "Цена: 6 200 ₽",
    );
    expect(auction.sent("getAuctionConsole")).toHaveLength(reads + 2);

    tooMany = 1;
    watch.emit(bid(auction, 60, 700_000));
    await advance(1_000);
    const refused = edits(calls).length;
    await advance(1_999);
    expect(edits(calls)).toHaveLength(refused);
    await advance(1);
    expect(edits(calls)).toHaveLength(refused + 1);
    expect(plain(edits(calls).at(-1)?.payload as Sent)).toContain(
      "Цена: 7 000 ₽",
    );
  });
});

// «Ставки зала» помощника ведущего (PER-565, ADR-070 пп. 4–6): люди зала по
// алфавиту с объявленной ценой, подтверждение, ставка `source = FLOOR` и её
// исходы, правка по потоку и права.
describe("floor bids of the assistant", () => {
  const leaderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ee";
  const anyaId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
  const vovaId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
  // Ответ Auction — не по алфавиту: порядок экрана держит бот.
  const people = [
    { participantId: vovaId, name: "Вова" },
    { participantId: leaderId, name: "Бэтмен" },
    { participantId: anyaId, name: "Аня" },
  ];
  const floorData = `v1:ac:b:${auctionToken}`;
  // Сумму `Intl` пишет с неразрывными пробелами: кнопка ищется по словам.
  const pick = (screen: Sent, text: string) => {
    const found = screen.reply_markup?.inline_keyboard
      .flat()
      .find((button) => spaced(button.text) === text)?.callback_data;
    if (found === undefined) throw new Error(`no button "${text}"`);
    return found;
  };
  const live = (lotId: string, version: number, price: number): LotView => ({
    ...trading(lotId, lotId === vaseId ? "Ваза" : "Кружка", price),
    version,
    nextPrice: rub(price + 10_000),
    status: {
      kind: "trading",
      currentPrice: rub(price),
      leaderId,
      phase: "live",
    },
  });
  const entry = (lot: LotView): ConsoleLot => ({
    lot,
    bidCount: 2,
    uniqueParticipantCount: 1,
    markedForFinal: true,
    overdue: false,
  });
  // Финал идёт, Ваза торгуется первой, лидер — Бэтмен на 1 200 ₽.
  const running = (
    options: Omit<Parameters<typeof fakeAuction>[0], "status" | "lots"> = {},
  ) => {
    const auction = fakeAuction({
      status: "final",
      week: { ...week, final: true },
      lots: [entry(live(vaseId, 3, 120_000)), entry(live(mugId, 3, 50_000))],
      lineup: [vaseId, mugId],
      names: { [leaderId]: "Бэтмен" },
      people,
      ...options,
    });
    auction.state.lineup = { order: [vaseId, mugId], activeLotId: vaseId };
    return auction;
  };
  // Ставка из бота: цена Вазы растёт вместе с версией, лидер — Бэтмен.
  const botBid = (auction: ReturnType<typeof running>, price: number) => {
    const current = auction.state.lots.find(
      (each) => each.lot.lotId === vaseId,
    );
    const lot = live(vaseId, (current?.lot.version ?? 3) + 1, price);
    auction.state.lots = auction.state.lots.map((each) =>
      each.lot.lotId === vaseId ? entry(lot) : each,
    );
    return lot;
  };

  const open = async (
    auction: ReturnType<typeof running>,
    holder: "admin" | "member" = "admin",
    rights?: readonly AccessRight[],
  ) => {
    const { bot, calls } = harness(holder, auction, [], rights);
    await bot.init();
    await bot.handleUpdate(press(floorData));
    return { bot, calls };
  };

  it("puts the floor bids next to the console while the final runs", async () => {
    const auction = running();
    const { bot, calls } = harness("admin", auction, [], runAuctionsOnly);
    await bot.init();
    await bot.handleUpdate(press(rootData));
    expect(labels(last(calls))).toContainEqual(["🛠 Пульт", "🛠 Ставки зала"]);
    // В финале пару пульта занимают «Ставки зала», и сеты встают своим рядом.
    expect(labels(last(calls))).toContainEqual(["🛠 Сеты"]);
    expect(dataOf(last(calls), "🛠 Ставки зала")).toBe(floorData);
  });

  it("keeps the floor bids out of the root before the final", async () => {
    const auction = running();
    auction.state.status = "prebidding";
    const { bot, calls } = harness("admin", auction);
    await bot.init();
    await bot.handleUpdate(press(rootData));
    expect(labels(last(calls)).flat()).not.toContain("🛠 Ставки зала");
    expect(labels(last(calls))).toContainEqual(["🛠 Пульт", "🛠 Сеты"]);
  });

  it("shows the lot and the room in alphabetical order with the leader in place", async () => {
    const { calls } = await open(running());
    const screen = last(calls);
    expect(plain(screen)).toContain("Сейчас: Ваза.");
    expect(plain(screen)).toContain("Цена: 1 200 ₽, следующая: 1 300 ₽.");
    expect(plain(screen)).toContain("Лидер: Бэтмен.");
    expect(labels(screen).map((row) => row.map(spaced))).toEqual([
      ["Аня — 1 300 ₽", "Бэтмен — лидер"],
      ["Вова — 1 300 ₽"],
      ["Другой человек…"],
      ["🔄 Обновить"],
      ["‹ Аукцион"],
    ]);
  });

  it("places a floor bid from the person through the confirmation to the new leader", async () => {
    const auction = running();
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));

    const confirm = last(calls);
    expect(plain(confirm)).toContain("Ставка зала: Аня — 1 300 ₽?");
    expect(plain(confirm)).toContain("Лот: Ваза.");
    expect(auction.sent("placeFloorBid")).toEqual([]);
    const yes = confirm.reply_markup?.inline_keyboard[0]?.[0];
    expect(spaced(yes?.text ?? "")).toBe("✔️ Да, Аня — 1 300 ₽");
    expect(yes?.style).toBe("danger");

    await bot.handleUpdate(press(yes?.callback_data ?? ""));

    expect(auction.sent("placeFloorBid")).toHaveLength(1);
    expect(auction.sent("placeFloorBid")[0]?.args).toMatchObject({
      lotId: vaseId,
      participantId: anyaId,
      amount: rub(130_000),
    });
    const after = last(calls);
    expect(plain(after)).toContain("Принято: Аня — 1 300 ₽.");
    expect(plain(after)).toContain("Цена: 1 300 ₽, следующая: 1 400 ₽.");
    expect(plain(after)).toContain("Лидер: Аня.");
    // Место Ани не изменилось: она лидер на том же месте.
    expect(labels(after)[0]?.map(spaced)).toEqual([
      "Аня — лидер",
      "Бэтмен — 1 400 ₽",
    ]);
  });

  it("does not bid from a confirmation after the price moved", async () => {
    const auction = running();
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));
    const yes = last(calls).reply_markup?.inline_keyboard[0]?.[0];
    botBid(auction, 130_000);

    await bot.handleUpdate(press(yes?.callback_data ?? ""));

    expect(auction.sent("placeFloorBid")).toEqual([]);
    expect(plain(last(calls))).toContain(
      "Цена изменилась — ставка не поставлена.",
    );
    expect(plain(last(calls))).toContain("Цена: 1 300 ₽, следующая: 1 400 ₽.");
  });

  it("does not bid from a confirmation after the lot changed", async () => {
    const auction = running();
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));
    const yes = last(calls).reply_markup?.inline_keyboard[0]?.[0];
    // Ваза продана, Кружка открыта с той же следующей ценой.
    auction.state.lots = [
      entry({
        ...live(vaseId, 5, 120_000),
        status: { kind: "sold", winnerId: leaderId, price: rub(120_000) },
      }),
      entry(live(mugId, 4, 120_000)),
    ];
    auction.state.lineup = { order: [vaseId, mugId], activeLotId: mugId };

    await bot.handleUpdate(press(yes?.callback_data ?? ""));

    expect(auction.sent("placeFloorBid")).toEqual([]);
    expect(plain(last(calls))).toContain(
      "Лот сменился — ставка не поставлена.",
    );
    expect(plain(last(calls))).toContain("Сейчас: Кружка.");
  });

  it("names the leader when the price was taken first", async () => {
    const auction = running();
    // Ставка из бота доходит до лота между сверкой и ставкой зала.
    const place = auction.port.placeFloorBid;
    auction.port.placeFloorBid = (person, bid, meta) => {
      botBid(auction, 130_000);
      return place(person, bid, meta);
    };
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));
    const yes = last(calls).reply_markup?.inline_keyboard[0]?.[0];

    await bot.handleUpdate(press(yes?.callback_data ?? ""));

    expect(auction.sent("placeFloorBid")).toHaveLength(1);
    expect(plain(last(calls))).toContain("1 300 ₽ уже взята — лидер Бэтмен.");
    expect(plain(last(calls))).toContain("Цена: 1 300 ₽, следующая: 1 400 ₽.");
    const lot = auction.state.lots.find((each) => each.lot.lotId === vaseId);
    expect(lot?.lot.status).toMatchObject({
      currentPrice: rub(130_000),
      leaderId,
    });
  });

  it("says the proxy answered the floor bid in the same command", async () => {
    const auction = running({ proxyAnswer: leaderId });
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));
    const yes = last(calls).reply_markup?.inline_keyboard[0]?.[0];

    await bot.handleUpdate(press(yes?.callback_data ?? ""));

    expect(plain(last(calls))).toContain(
      "Принято: Аня — 1 300 ₽, автоставка ответила 1 400 ₽.",
    );
    expect(plain(last(calls))).toContain("Лидер: Бэтмен.");
  });

  it("does not repeat a floor bid that got no answer", async () => {
    const auction = running({ floorTimeout: true });
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));
    const yes = last(calls).reply_markup?.inline_keyboard[0]?.[0];

    await bot.handleUpdate(press(yes?.callback_data ?? ""));

    expect(auction.sent("placeFloorBid")).toHaveLength(1);
    expect(plain(last(calls))).toContain(
      "Аукцион не ответил — ставка Аня — 1 300 ₽ могла пройти.",
    );
  });

  it("answers a press on the leader without Auction", async () => {
    const auction = running();
    const { bot, calls } = await open(auction);
    const before = auction.commands.length;

    await bot.handleUpdate(press(pick(last(calls), "Бэтмен — лидер")));

    expect(toasts(calls)).toContain("Этот человек уже лидер.");
    expect(auction.commands).toHaveLength(before);
  });

  it("shows no people while no lot is open", async () => {
    const auction = running();
    auction.state.lineup = { order: [vaseId, mugId] };
    const { calls } = await open(auction);
    expect(plain(last(calls))).toContain("Сейчас лот не открыт.");
    expect(labels(last(calls))).toEqual([["🔄 Обновить"], ["‹ Аукцион"]]);
  });

  it("tells an empty room from a failed read of the names", async () => {
    const empty = await open(running({ people: [] }));
    expect(plain(last(empty.calls))).toContain(
      "В этом аукционе ещё никто не выбрал имя.",
    );

    const failed = await open(running({ peopleFail: true }));
    expect(labels(last(failed.calls)).flat()).toContain("Повторить");
    expect(dataOf(last(failed.calls), "Повторить")).toBe(floorData);
  });

  it("finds another person by a part of the name", async () => {
    const auction = running();
    const { bot, calls } = await open(auction);
    await bot.handleUpdate(press(dataOf(last(calls), "Другой человек…")));
    expect(question(calls).payload.text).toContain("Кого ищем?");

    await bot.handleUpdate(answer(calls, { text: "во" }));

    const found = last(calls);
    expect(plain(found)).toContain("Нашлось по «во»: 1.");
    expect(labels(found).map((row) => row.map(spaced))).toEqual([
      ["Вова — 1 300 ₽"],
      ["‹ Ставки зала"],
    ]);

    await bot.handleUpdate(press(dataOf(last(calls), "‹ Ставки зала")));
    await bot.handleUpdate(press(dataOf(last(calls), "Другой человек…")));
    await bot.handleUpdate(answer(calls, { text: "зз" }));
    expect(plain(last(calls))).toContain("Никого не нашлось по «зз».");
  });

  it("pages a large room by sixteen people", async () => {
    const many = Array.from({ length: 18 }, (_, at) => ({
      participantId: `0198f2a4-7c1e-7d3a-9b21-4f8e12ab35${String(at).padStart(2, "0")}`,
      name: `Гость ${String(at + 1).padStart(2, "0")}`,
    }));
    const { calls } = await open(running({ people: many }));
    const screen = last(calls);
    expect(plain(screen)).toContain("Ставки зала · 1 из 2");
    expect(labels(screen)).toHaveLength(8 + 4);
  });

  it("keeps the floor bids from a person without the right to run auctions", async () => {
    const auction = running();
    const { bot, calls } = await open(auction, "member");
    expect(auction.commands).toEqual([]);
    expect(plain(last(calls))).not.toContain("Сейчас:");

    const forged = `v1:ac:by:${uuidToToken(vaseId)}:${uuidToToken(anyaId)}:${(130_000).toString(36)}`;
    await bot.handleUpdate(press(forged));
    expect(auction.sent("placeFloorBid")).toEqual([]);

    const rootCalls: RecordedCall[] = [];
    const member = harness("admin", auction, rootCalls, manageMeetupsOnly);
    await member.bot.init();
    await member.bot.handleUpdate(press(rootData));
    expect(labels(last(rootCalls)).flat()).not.toContain("🛠 Ставки зала");
  });

  describe("live", () => {
    const edits = (calls: readonly RecordedCall[]) =>
      calls.filter(
        (call) =>
          call.method === "editMessageText" &&
          (call.payload as { message_id?: number }).message_id === 9,
      );

    const setup = async () => {
      const watch = stream();
      const auction = running();
      const { bot, calls } = harness(
        "admin",
        auction,
        [],
        undefined,
        undefined,
        {
          live: {
            watches: watch.watches,
            limiter: immediate,
            names: { getDisplayNames: async () => ({}) },
          },
        },
      );
      await bot.init();
      await bot.handleUpdate(press(floorData));
      return { bot, calls, auction, watch };
    };

    it("shows the new price after a bid from the bot without a press", async () => {
      const { calls, auction, watch } = await setup();
      expect(watch.subscribers.size).toBe(1);
      const before = edits(calls).length;

      watch.emit(botBid(auction, 130_000));
      await flush();

      expect(edits(calls)).toHaveLength(before + 1);
      const edited = edits(calls).at(-1)?.payload as Sent;
      expect(plain(edited)).toContain("Цена: 1 300 ₽, следующая: 1 400 ₽.");
      expect(labels(edited)[0]?.map(spaced)).toEqual([
        "Аня — 1 400 ₽",
        "Бэтмен — лидер",
      ]);
    });

    it("marks the price stale while the stream reconnects", async () => {
      const { calls, watch } = await setup();
      const before = edits(calls).length;

      watch.interrupt();
      await flush();

      expect(edits(calls)).toHaveLength(before + 1);
      expect(plain(edits(calls).at(-1)?.payload as Sent)).toContain(
        "Связь с аукционом прервалась — цена могла устареть.",
      );
    });

    it("stops following the stream once another screen takes the message", async () => {
      const { bot, watch } = await setup();
      await bot.handleUpdate(press(consoleData));
      expect(watch.subscribers.size).toBe(1);
      await bot.handleUpdate(press(rootData));
      expect(watch.subscribers.size).toBe(0);
    });
  });

  // Находки ревью PER-565: исход ставки важнее свежего экрана, «Повторить»
  // не ставит ставку заново, отказ называет цену сам, автоставку отличает
  // версия из ответа, найденные не листаются в полный список.
  describe("outcomes under failures and races", () => {
    const confirmOf = async (auction: ReturnType<typeof running>) => {
      const opened = await open(auction);
      await opened.bot.handleUpdate(
        press(pick(last(opened.calls), "Аня — 1 300 ₽")),
      );
      const yes = last(opened.calls).reply_markup?.inline_keyboard[0]?.[0];
      return { ...opened, yes: yes?.callback_data ?? "" };
    };

    it("keeps an accepted bid on screen when the read after it fails", async () => {
      const auction = running();
      const { bot, calls, yes } = await confirmOf(auction);
      const read = auction.port.getAuctionConsole;
      auction.port.getAuctionConsole = (...args) =>
        auction.sent("placeFloorBid").length > 0
          ? Promise.resolve({ kind: "unavailable", cause: new Error("down") })
          : read(...args);

      await bot.handleUpdate(press(yes));

      expect(plain(last(calls))).toContain("Принято: Аня — 1 300 ₽.");
      expect(plain(last(calls))).toContain(
        "Связь с аукционом прервалась — цена могла устареть.",
      );
    });

    it("retries a failed confirmation through the confirmation, not the bid", async () => {
      const auction = running({ floorTimeout: true });
      const { bot, calls, yes } = await confirmOf(auction);
      auction.port.getAuctionConsole = () =>
        Promise.resolve({ kind: "unavailable", cause: new Error("down") });
      auction.port.floorLot = () =>
        Promise.resolve({ kind: "unavailable", cause: new Error("down") });

      await bot.handleUpdate(press(yes));

      // Сверка до команды не прочиталась: ставки нет, а «Повторить» ведёт к
      // подтверждению заново.
      expect(auction.sent("placeFloorBid")).toEqual([]);
      const retry = dataOf(last(calls), "Повторить");
      expect(retry.startsWith("v1:ac:bp:")).toBe(true);
    });

    it("shows the next price the refusal names while the read lags", async () => {
      const auction = running();
      const place = auction.port.placeFloorBid;
      auction.port.placeFloorBid = async (person, bid, meta) => {
        const answer = await place(person, bid, meta);
        return answer.kind === "accepted"
          ? { kind: "bid-not-at-next-price", expected: rub(140_000) }
          : answer;
      };
      const { bot, calls, yes } = await confirmOf(auction);
      // Чтение ещё не видит чужой ставки: лот прежний.
      auction.port.floorLot = async () => ({
        kind: "ok",
        lot: live(vaseId, 3, 120_000),
      });
      const read = auction.port.getAuctionConsole;
      auction.port.getAuctionConsole = async (...args) => {
        const result = await read(...args);
        return result.kind === "ok"
          ? {
              ...result,
              console: {
                ...result.console,
                lots: [
                  entry(live(vaseId, 3, 120_000)),
                  entry(live(mugId, 3, 50_000)),
                ],
              },
            }
          : result;
      };

      await bot.handleUpdate(press(yes));

      expect(plain(last(calls))).toContain("1 300 ₽ уже взята — лидер Бэтмен.");
      expect(plain(last(calls))).toContain("следующая: 1 400 ₽.");
    });

    it("lets Auction judge a price the lagging read shows lower", async () => {
      const auction = running();
      const { bot, calls } = await open(auction);
      // Кнопка уже на 1 300 ₽, чтение лота ещё на прежней цене ниже.
      auction.port.floorLot = async () => ({
        kind: "ok",
        lot: live(vaseId, 2, 110_000),
      });
      await bot.handleUpdate(press(pick(last(calls), "Аня — 1 300 ₽")));
      expect(plain(last(calls))).toContain("Ставка зала: Аня — 1 300 ₽?");
    });

    it("does not call a later bid from the bot an answer of the proxy", async () => {
      const auction = running();
      const place = auction.port.placeFloorBid;
      auction.port.placeFloorBid = async (person, bid, meta) => {
        const answer = await place(person, bid, meta);
        botBid(auction, 140_000);
        return answer;
      };
      const { bot, calls, yes } = await confirmOf(auction);

      await bot.handleUpdate(press(yes));

      expect(plain(last(calls))).toContain(
        "Принято: Аня — 1 300 ₽. Цену уже подняли: 1 400 ₽.",
      );
      expect(plain(last(calls))).not.toContain("автоставка");
    });

    it("shows the found people on one page without a pager to the full list", async () => {
      const many = Array.from({ length: 18 }, (_, at) => ({
        participantId: `0198f2a4-7c1e-7d3a-9b21-4f8e12ab35${String(at).padStart(2, "0")}`,
        name: `Гость ${String(at + 1).padStart(2, "0")}`,
      }));
      const auction = running({ people: many });
      const { bot, calls } = await open(auction);
      await bot.handleUpdate(press(dataOf(last(calls), "Другой человек…")));
      await bot.handleUpdate(answer(calls, { text: "гость" }));

      const found = last(calls);
      expect(plain(found)).toContain(
        "Нашлось по «гость»: 18. Показаны первые 16 — уточни имя.",
      );
      expect(labels(found).flat()).not.toContain("→");
      expect(labels(found)).toHaveLength(8 + 1);
    });

    it("reads a price beyond six base-36 digits from the button", () => {
      const minorUnits = 36 ** 6 + 5;
      const data = `v1:ac:bp:${uuidToToken(vaseId)}:${uuidToToken(anyaId)}:${minorUnits.toString(36)}`;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parseCallback(data)).toMatchObject({
        kind: "console-floor-pick",
        minorUnits,
      });
    });
  });
});

// Снятие участника с лота (PER-659, ADR-072): ряд «Снять участника» на
// «Ставках» лота, выбор человека, подтверждение с предпросмотром и снятие.
// Бот пересоздаётся между нажатиями: лот, человек и номер лота едут в кнопке.
describe("participant removal from the bids of a lot", () => {
  const jayId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
  const owlId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
  const participants = [
    { participantId: owlId, name: "@owl" },
    { participantId: jayId, name: "@jay" },
  ];
  const entry = (lot: LotView): ConsoleLot => ({
    lot,
    bidCount: 2,
    uniqueParticipantCount: 2,
    markedForFinal: false,
    overdue: false,
  });
  // Онлайн-торги: Ваза за 1 500 ₽, лидер — @jay, версия лота 3.
  const online = (status?: LotView["status"]) =>
    fakeAuction({
      status: "prebidding",
      week: { ...week, final: false },
      names: { [jayId]: "@jay", [owlId]: "@owl" },
      lots: [
        entry({
          ...trading(vaseId, "Ваза", 150_000),
          ...(status === undefined
            ? {
                status: {
                  kind: "trading" as const,
                  currentPrice: rub(150_000),
                  leaderId: jayId,
                  phase: "online" as const,
                },
              }
            : { status }),
        }),
      ],
      participants,
    });
  const bidsData = encodeAuctionCallback({
    kind: "history",
    lotId: vaseId,
    page: 0,
    historyPage: 0,
  });
  const removalData = `v1:ac:e:${uuidToToken(vaseId)}`;
  // Каждое нажатие — новым ботом над тем же Auction и той же историей чата.
  const pressFresh = async (
    auction: ReturnType<typeof online>,
    calls: RecordedCall[],
    data: string,
    holder: "admin" | "member" = "admin",
  ) => {
    const { bot } = harness(holder, auction, calls);
    await bot.init();
    await bot.handleUpdate(press(data));
    return last(calls);
  };

  it("offers the removal on the bids of a trading lot to the auction administrator only", async () => {
    const auction = online();
    const admin: RecordedCall[] = [];
    const shownToAdmin = await pressFresh(auction, admin, bidsData);
    expect(labels(shownToAdmin)).toEqual([["Снять участника"], ["‹ Лот"]]);
    expect(dataOf(shownToAdmin, "Снять участника")).toBe(removalData);

    const member: RecordedCall[] = [];
    const shownToMember = await pressFresh(auction, member, bidsData, "member");
    expect(labels(shownToMember)).toEqual([["‹ Лот"]]);
  });

  it("keeps the removal off the bids of a lot it cannot leave", async () => {
    const auction = online({ kind: "sold", winnerId: jayId, price: rub(1) });
    const calls: RecordedCall[] = [];
    const screen = await pressFresh(auction, calls, bidsData);
    expect(labels(screen).flat()).not.toContain("Снять участника");
  });

  it("removes a participant through the preview and shows the lot after it", async () => {
    const auction = online();
    const calls: RecordedCall[] = [];
    const people = await pressFresh(auction, calls, removalData);
    expect(plain(people)).toContain("Снять участника");
    expect(labels(people)).toEqual([["@owl", "@jay"], ["‹ Ставки"]]);

    const confirm = await pressFresh(auction, calls, dataOf(people, "@jay"));
    expect(plain(confirm)).toContain("Снять @jay с лота?");
    expect(plain(confirm)).toContain("Лидер: @owl.");
    expect(spaced(plain(confirm))).toContain("Цена: 1 400 ₽.");
    expect(auction.sent("removeParticipant")).toEqual([]);

    const outcome = await pressFresh(
      auction,
      calls,
      dataOf(confirm, "✔️ Да, снять"),
    );
    expect(plain(outcome)).toContain("Участник снят: @jay");
    expect(spaced(plain(outcome))).toContain("Лидер: @owl. Цена: 1 400 ₽.");
    expect(labels(outcome)).toEqual([["‹ Лот"]]);
    expect(auction.sent("removeParticipant")).toMatchObject([
      {
        args: {
          auctionId,
          lotId: vaseId,
          participantId: jayId,
          expectedVersion: 3,
        },
      },
    ]);
  });

  it("changes nothing when the administrator says no", async () => {
    const auction = online();
    const calls: RecordedCall[] = [];
    const confirm = await pressFresh(
      auction,
      calls,
      `v1:ac:ep:${uuidToToken(vaseId)}:${uuidToToken(jayId)}`,
    );
    const back = await pressFresh(auction, calls, dataOf(confirm, "✖️ Нет"));
    expect(labels(back)).toEqual([["@owl", "@jay"], ["‹ Ставки"]]);
    expect(auction.sent("removeParticipant")).toEqual([]);
    expect(auction.state.removed.size).toBe(0);
  });

  it("does not remove twice when the same yes is pressed again", async () => {
    const auction = online();
    const calls: RecordedCall[] = [];
    const confirm = await pressFresh(
      auction,
      calls,
      `v1:ac:ep:${uuidToToken(vaseId)}:${uuidToToken(jayId)}`,
    );
    const yes = dataOf(confirm, "✔️ Да, снять");
    await pressFresh(auction, calls, yes);
    const version = auction.state.lots[0]?.lot.version;
    const again = await pressFresh(auction, calls, yes);
    expect(plain(again)).toContain("Участник уже снят");
    expect(auction.state.lots[0]?.lot.version).toBe(version);
    expect(auction.sent("removeParticipant")).toHaveLength(2);
  });

  it("asks again with the new preview when the lot changed under the confirmation", async () => {
    const auction = online();
    const calls: RecordedCall[] = [];
    const confirm = await pressFresh(
      auction,
      calls,
      `v1:ac:ep:${uuidToToken(vaseId)}:${uuidToToken(jayId)}`,
    );
    // Ставка, пока подтверждение было открыто: цена и номер лота выросли.
    auction.state.lots = auction.state.lots.map((each) => ({
      ...each,
      lot: {
        ...each.lot,
        version: 4,
        status: {
          kind: "trading",
          currentPrice: rub(160_000),
          leaderId: jayId,
          phase: "online",
        },
      },
    }));
    const again = await pressFresh(
      auction,
      calls,
      dataOf(confirm, "✔️ Да, снять"),
    );
    expect(plain(again)).toContain(
      "Лот изменился, пока было открыто подтверждение. Проверь заново.",
    );
    expect(spaced(plain(again))).toContain("Цена: 1 500 ₽.");
    expect(dataOf(again, "✔️ Да, снять")).toBe(
      `v1:ac:ey:${uuidToToken(vaseId)}:${uuidToToken(jayId)}:4`,
    );
    expect(auction.state.removed.size).toBe(0);
  });

  it("names the phase when the lot is already in the live final", async () => {
    const auction = online({
      kind: "trading",
      currentPrice: rub(150_000),
      leaderId: jayId,
      phase: "live",
    });
    const calls: RecordedCall[] = [];
    const screen = await pressFresh(auction, calls, removalData);
    expect(plain(screen)).toContain("Снять нельзя");
    expect(plain(screen)).toContain("ошибку ставки там исправляет ведущий");
    expect(auction.sent("lotParticipants")).toEqual([]);
  });

  it("fits the yes of the removal into 64 bytes at the largest lot version", () => {
    expect(
      Buffer.byteLength(
        `v1:ac:ey:${uuidToToken(vaseId)}:${uuidToToken(jayId)}:${(36 ** 8 - 1).toString(36)}`,
      ),
    ).toBeLessThanOrEqual(64);
  });
});

// Счета проданных лотов (PER-321): ряд «Счета» пульта, сводка с итогом и
// просрочкой, счёт, подтверждение отметки и её исход. Право решает Auction;
// повтор отметки второго перехода не пишет.
describe("invoices of the auction console", () => {
  const jayId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401";
  const owlId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
  const sold = (lotId: string, title: string, price: number): ConsoleLot => ({
    lot: {
      ...trading(lotId, title, price),
      status: { kind: "sold", winnerId: jayId, price: rub(price) },
    },
    bidCount: 2,
    uniqueParticipantCount: 2,
    markedForFinal: false,
    overdue: false,
  });
  const bill = (
    invoiceId: string,
    lotId: string,
    winnerId: string,
    price: number,
    status: Invoice["status"],
    paymentDueAt: string,
  ): Invoice => ({
    invoiceId,
    auctionId,
    lotId,
    winnerId,
    amount: rub(price),
    paymentDueAt,
    fulfillment: "pickup",
    status,
  });
  // Аукцион закончен: Ваза ждёт оплаты, и срок прошёл; Кружка оплачена.
  const finished = (vaseStatus: Invoice["status"] = "awaiting-payment") =>
    fakeAuction({
      status: "finished",
      lots: [sold(vaseId, "Ваза", 150_000), sold(mugId, "Кружка", 50_000)],
      names: { [jayId]: "@jay", [owlId]: "@owl" },
      invoices: [
        bill(
          vaseInvoiceId,
          vaseId,
          jayId,
          150_000,
          vaseStatus,
          "2026-10-05T09:00:00Z",
        ),
        bill(
          mugInvoiceId,
          mugId,
          owlId,
          50_000,
          "paid",
          "2026-10-05T09:00:00Z",
        ),
      ],
    });
  const invoicesData = `v1:ac:iv:${auctionToken}`;
  const vaseInvoiceData = `v1:ac:ic:${auctionToken}:${uuidToToken(vaseInvoiceId)}`;
  const pressFresh = async (
    auction: ReturnType<typeof fakeAuction>,
    calls: RecordedCall[],
    data: string,
    holder: "admin" | "member" = "admin",
  ) => {
    const { bot } = harness(holder, auction, calls);
    await bot.init();
    await bot.handleUpdate(press(data));
    return last(calls);
  };

  it("offers the invoices on the console once the lots are sold", async () => {
    const calls: RecordedCall[] = [];
    const console = await pressFresh(finished(), calls, consoleData);
    expect(dataOf(console, "Счета")).toBe(invoicesData);

    const trading: RecordedCall[] = [];
    const before = await pressFresh(
      fakeAuction({ status: "prebidding", week: { ...week, final: false } }),
      trading,
      consoleData,
    );
    expect(labels(before).flat()).not.toContain("Счета");
  });

  it("sums what is collected and expected and puts the overdue invoice first", async () => {
    const calls: RecordedCall[] = [];
    const summary = plain(await pressFresh(finished(), calls, invoicesData));
    expect(summary).toContain("Собрано: 500 ₽.");
    expect(summary).toContain("Ожидается: 1 500 ₽.");
    expect(summary).toContain("Просрочено: 1 счёт.");
    expect(summary.indexOf("Ваза — @jay")).toBeLessThan(
      summary.indexOf("Кружка — @owl"),
    );
    expect(summary).toContain("Ваза — @jay, 1 500 ₽: просрочен");
    expect(summary).toContain(
      "Кружка — @owl, 500 ₽: оплачен, ждёт выдачи, самовывоз.",
    );
    expect(labels(last(calls))).toEqual([
      ["Ваза · @jay"],
      ["Кружка · @owl"],
      ["Текст оплаты"],
      ["‹ Пульт"],
    ]);
  });

  it("marks the payment through the confirmation and shows it in the summary", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    const invoice = await pressFresh(auction, calls, vaseInvoiceData);
    expect(plain(invoice)).toContain("Статус: просрочен");
    expect(labels(invoice)).toEqual([["Отметить оплату"], ["‹ Счета"]]);

    const confirm = await pressFresh(
      auction,
      calls,
      dataOf(invoice, "Отметить оплату"),
    );
    expect(plain(confirm)).toContain("Отметить оплату?");
    expect(auction.sent("markInvoice")).toEqual([]);

    const outcome = await pressFresh(
      auction,
      calls,
      dataOf(confirm, "✔️ Да, отметить"),
    );
    expect(plain(outcome)).toContain("Оплата отмечена");
    expect(labels(outcome)).toEqual([["‹ Счёт"]]);
    expect(auction.state.transitions).toEqual([
      { invoiceId: vaseInvoiceId, mark: "paid" },
    ]);

    const summary = plain(await pressFresh(auction, calls, invoicesData));
    expect(summary).toContain("Собрано: 2 000 ₽.");
    expect(summary).toContain("Ожидается: ничего.");
    expect(summary).not.toContain("Просрочено");
  });

  // Ключ отметки рождается на нажатие, поэтому второе «Да» тоже доходит до
  // Auction — и тот, как сервис, принимает его без второго перехода.
  it("records no second transition when the same yes is pressed twice", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    const yes = `v1:ac:iy:${auctionToken}:${uuidToToken(vaseInvoiceId)}:p`;
    await pressFresh(auction, calls, yes);
    const again = await pressFresh(auction, calls, yes);
    expect(plain(again)).toContain("Оплата уже отмечена");
    expect(auction.state.transitions).toEqual([
      { invoiceId: vaseInvoiceId, mark: "paid" },
    ]);
  });

  it("hands over a paid lot and offers nothing after it", async () => {
    const auction = finished("paid");
    const calls: RecordedCall[] = [];
    const invoice = await pressFresh(auction, calls, vaseInvoiceData);
    const confirm = await pressFresh(
      auction,
      calls,
      dataOf(invoice, "Отметить выдачу"),
    );
    await pressFresh(auction, calls, dataOf(confirm, "✔️ Да, отметить"));
    expect(auction.state.transitions).toEqual([
      { invoiceId: vaseInvoiceId, mark: "handed-over" },
    ]);
    const closed = await pressFresh(auction, calls, vaseInvoiceData);
    expect(plain(closed)).toContain("Статус: выдан.");
    expect(labels(closed)).toEqual([["‹ Счета"]]);
  });

  it("does not hand over an unpaid lot from a stale button", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    const outcome = await pressFresh(
      auction,
      calls,
      `v1:ac:ip:${auctionToken}:${uuidToToken(vaseInvoiceId)}:h`,
    );
    expect(plain(outcome)).toContain("Выдать пока нельзя");
    expect(auction.sent("markInvoice")).toEqual([]);
  });

  // Текст «Как оплатить и получить» (PER-322): задаётся вопросом на
  // «Счетах», ответ принимается и после рестарта, снимается кнопкой.
  it("asks the payment text, keeps the question over a restart and shows the text", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness("admin", auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(invoicesData));
    expect(plain(last(calls))).toContain(
      "Текста «Как оплатить и получить» ещё нет.",
    );
    expect(dataOf(last(calls), "Текст оплаты")).toBe(
      `v1:ac:it:${auctionToken}`,
    );
    expect(labels(last(calls)).flat()).not.toContain("Убрать текст оплаты");

    await next((history) => press(dataOf(last(history), "Текст оплаты")));
    const asked = question(calls).payload;
    expect(asked.reply_markup?.force_reply).toBe(true);
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:ai:${auctionToken}:42`);
    expect(asked.text).toContain("Как победителям оплатить лоты");

    // Пустой ответ бот отклоняет сам, без команды.
    await next((history) => answer(history, { text: "  \n " }));
    expect(last(calls).text).toBe(
      "<b>Пустой текст победителям ничего не скажет: напиши, как оплатить и получить лот</b>",
    );
    expect(labels(last(calls))).toEqual([["Ввести заново"], ["‹ Счета"]]);
    expect(auction.sent("setPaymentInstructions")).toEqual([]);

    await next((history) => press(dataOf(last(history), "Ввести заново")));
    await next((history) =>
      answer(history, {
        text: " Перевод на карту 2200 0000 0000 0000 до пятницы.\nЗабрать <в зале> после финала. ",
      }),
    );
    expect(auction.sent("setPaymentInstructions")).toEqual([
      {
        method: "setPaymentInstructions",
        args: {
          auctionId,
          opId: expect.any(String),
          text: "Перевод на карту 2200 0000 0000 0000 до пятницы.\nЗабрать <в зале> после финала.",
        },
      },
    ]);
    expect(last(calls).text).toBe(
      "<b>Текст оплаты сохранён</b>\n\nПобедители видят его в своих счетах.",
    );
    expect(labels(last(calls))).toEqual([["‹ Счета"]]);

    await next((history) => press(dataOf(last(history), "‹ Счета")));
    const summary = last(calls).text ?? "";
    expect(summary).toContain(
      "<b>Как оплатить и получить</b>\nПеревод на карту 2200 0000 0000 0000 до пятницы.\nЗабрать &lt;в зале&gt; после финала.",
    );
    expect(labels(last(calls))).toEqual([
      ["Ваза · @jay"],
      ["Кружка · @owl"],
      ["Текст оплаты"],
      ["Убрать текст оплаты"],
      ["‹ Пульт"],
    ]);
  });

  it("asks again a text longer than a thousand characters", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    await pressFresh(auction, calls, `v1:ac:it:${auctionToken}`);
    const { bot } = harness("admin", auction, calls);
    await bot.init();
    await bot.handleUpdate(answer(calls, { text: "я".repeat(1_001) }));
    expect(plain(last(calls))).toContain("Текст длиннее 1000 знаков");
    expect(auction.sent("setPaymentInstructions")).toEqual([]);
  });

  it("takes the payment text back without a confirmation", async () => {
    const auction = fakeAuction({
      status: "finished",
      paymentText: "Перевод на карту.",
    });
    const calls: RecordedCall[] = [];
    const summary = await pressFresh(auction, calls, invoicesData);
    expect(plain(summary)).toContain(
      "Как оплатить и получить\nПеревод на карту.",
    );
    const outcome = await pressFresh(
      auction,
      calls,
      dataOf(summary, "Убрать текст оплаты"),
    );
    expect(auction.sent("setPaymentInstructions")).toEqual([
      {
        method: "setPaymentInstructions",
        args: { auctionId, opId: expect.any(String) },
      },
    ]);
    expect(outcome.text).toBe(
      "<b>Текст оплаты убран</b>\n\nПобедители его больше не видят.",
    );
    const after = await pressFresh(auction, calls, invoicesData);
    expect(plain(after)).toContain("Текста «Как оплатить и получить» ещё нет.");
    expect(labels(after).flat()).not.toContain("Убрать текст оплаты");
  });

  it("ignores an answer to the payment question from someone else", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    await pressFresh(auction, calls, `v1:ac:it:${auctionToken}`);
    const before = calls.length;
    const { bot } = harness("admin", auction, calls);
    await bot.init();
    await bot.handleUpdate(answer(calls, { text: "Перевод на карту." }, 77));
    expect(shown(calls.slice(before))).toEqual([]);
    expect(auction.sent("setPaymentInstructions")).toEqual([]);
  });

  it("refuses a payment answer of someone without the right before Auction", async () => {
    const auction = finished();
    const calls: RecordedCall[] = [];
    await pressFresh(auction, calls, `v1:ac:it:${auctionToken}`);
    const { bot } = harness("member", auction, calls);
    await bot.init();
    await bot.handleUpdate(answer(calls, { text: "Перевод на карту." }));
    expect(last(calls).text).toContain("Это действие тебе недоступно.");
    expect(auction.sent("setPaymentInstructions")).toEqual([]);
  });

  it("shows the refusal of Auction to a non-administrator of the meetup", async () => {
    const auction = fakeAuction({
      status: "finished",
      paymentTextRefusal: { kind: "not-administrator" },
    });
    const calls: RecordedCall[] = [];
    await pressFresh(auction, calls, `v1:ac:it:${auctionToken}`);
    const { bot } = harness("admin", auction, calls);
    await bot.init();
    await bot.handleUpdate(answer(calls, { text: "Перевод на карту." }));
    expect(auction.sent("setPaymentInstructions")).toHaveLength(1);
    expect(last(calls).text).toContain("Это действие тебе недоступно.");
  });

  it("refuses the invoices that Auction does not grant", async () => {
    const auction = fakeAuction({ status: "finished", refuse: true });
    const calls: RecordedCall[] = [];
    const refused = await pressFresh(auction, calls, invoicesData);
    expect(refused.text).toContain("Это действие тебе недоступно.");
    expect(auction.sent("getAuctionConsole")).toEqual([]);
  });
});
