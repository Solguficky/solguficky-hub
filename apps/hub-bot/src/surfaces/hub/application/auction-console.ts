import type {
  AuctionSummaryView,
  RaffleView,
} from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  AuctionFailure,
  ConsoleReadResult,
  LotClosure,
  LotStatisticsReadResult,
  ScheduleAuctionResult,
} from "../auction/port.js";
import { communityInstant } from "../community-time.js";
import { lotCurrency, parseRubles } from "./lot-form.js";
import type {
  AuctionConsoleRequest,
  AuctionConsoleView,
  AuctionWeek,
  CloseQuote,
  ConsoleAuctionStatus,
  ConsoleLot,
  ConsoleNote,
  ExecuteResult,
  FinalTrading,
  LineupPick,
  LotAmount,
  RaffleAskError,
  StepWindow,
  TradingHolder,
  WeekAskError,
  WindowAskError,
  WindowRef,
} from "./types.js";

// Пульт аукциона администратора (PER-320): сроки онлайн-недели и финал,
// открытие недели и отметка лотов для финала; в финале он же — пульт ведущего
// (PER-337). Своего состояния у пульта нет:
// каждый шаг читает пульт у Auction заново. Право здесь не решается — его
// проверяет Auction у Meetups на каждой команде и чтении, а край только не
// показывает вход тому, кто не администратор.

// Финал по умолчанию у первых сроков: формат сходки — онлайн-неделя и живой
// финал в зале. Переключатель на пульте снимает его следующей командой.
const defaultFinal = true;

export type WeekResult =
  | { kind: "ok"; opensAt: string; closesAt: string }
  | { kind: "rejected"; error: WeekAskError };

const momentPattern = String.raw`(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})`;
// Начало и конец через тире любого вида или через пробел: так их пишут с
// клавиатуры и так их показывает сам пульт в строке «Сейчас». Разделитель
// обязателен: слитые моменты — не сроки, а опечатка.
const weekPattern = new RegExp(
  `^${momentPattern}(?:\\s*[-‒–—]\\s*|\\s+)${momentPattern}$`,
);

/**
 * Сроки недели в виде `ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ` по времени
 * сообщества — формат ввода хаба (дизайн-код, «Формат»). Даты, которой нет в
 * календаре, и времени, которого нет в поясе, нет и в ответе: подменять их
 * соседними бот не вправе. Конец, который уже наступил по часам бота, — не
 * сроки: лоты получили бы прошедший дедлайн.
 */
export function parseWeek(
  raw: string,
  timeZone: string,
  now: Date,
): WeekResult {
  const match = weekPattern.exec(raw.trim());
  if (match === null) return { kind: "rejected", error: "week-format" };
  const numbers = match.slice(1).map(Number);
  const [opens, closes] = [numbers.slice(0, 5), numbers.slice(5, 10)].map(
    calendarMoment,
  );
  if (opens === undefined || closes === undefined) {
    return { kind: "rejected", error: "week-format" };
  }
  const opensAt = communityInstant(opens, timeZone);
  const closesAt = communityInstant(closes, timeZone);
  if (opensAt === undefined || closesAt === undefined) {
    return { kind: "rejected", error: "week-moment" };
  }
  if (Date.parse(closesAt) <= Date.parse(opensAt)) {
    return { kind: "rejected", error: "week-order" };
  }
  if (Date.parse(closesAt) <= now.getTime()) {
    return { kind: "rejected", error: "week-ended" };
  }
  return { kind: "ok", opensAt, closesAt };
}

// Дата и время из разобранных чисел `ДД ММ ГГГГ ЧЧ ММ`, если такие есть в
// календаре: 31.02 и 24:00 — не моменты.
function calendarMoment([
  day = 0,
  month = 0,
  year = 0,
  hours = 0,
  minutes = 0,
]: readonly number[]):
  | { year: number; month: number; day: number; hours: number; minutes: number }
  | undefined {
  if (hours > 23 || minutes > 59) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, month, day, hours, minutes };
}

export type RaffleResult =
  | { kind: "ok"; raffleClosesAt: string }
  | { kind: "rejected"; error: RaffleAskError };

const rafflePattern = new RegExp(`^${momentPattern}$`);

/**
 * Момент закрытия регистрации в розыгрыше (PER-593) в виде `ДД.ММ.ГГГГ ЧЧ:ММ`
 * по времени сообщества. Он лежит строго внутри недели (ADR-066, п. 5): бот
 * проверяет это по прочитанным срокам до команды, а Auction — ещё раз.
 * Наступивший момент — не момент: регистрация закрылась бы, не открывшись.
 */
export function parseRaffle(
  raw: string,
  week: { opensAt: string; closesAt: string },
  timeZone: string,
  now: Date,
): RaffleResult {
  const match = rafflePattern.exec(raw.trim());
  if (match === null) return { kind: "rejected", error: "raffle-format" };
  const local = calendarMoment(match.slice(1).map(Number));
  if (local === undefined) return { kind: "rejected", error: "raffle-format" };
  const raffleClosesAt = communityInstant(local, timeZone);
  if (raffleClosesAt === undefined) {
    return { kind: "rejected", error: "raffle-moment" };
  }
  const at = Date.parse(raffleClosesAt);
  if (at <= Date.parse(week.opensAt)) {
    return { kind: "rejected", error: "raffle-not-after-opens" };
  }
  if (at >= Date.parse(week.closesAt)) {
    return { kind: "rejected", error: "raffle-not-before-closes" };
  }
  if (at <= now.getTime()) return { kind: "rejected", error: "raffle-ended" };
  return { kind: "ok", raffleClosesAt };
}

export type WindowResult =
  | { kind: "ok"; from: string; until: string; step: LotAmount }
  | { kind: "rejected"; error: WindowAskError };

const windowErrorOf: Record<WeekAskError, WindowAskError> = {
  "week-format": "window-format",
  "week-moment": "window-moment",
  "week-order": "window-order",
  "week-ended": "window-ended",
  // Разбор сроков эти отказы не даёт: их называет Auction.
  "week-cuts-window": "window-outside-week",
  "week-cuts-raffle": "window-outside-week",
};

/**
 * Окно «Счастливых часов» (PER-504) одним ответом: сроки в виде сроков недели
 * и шаг в окне целыми рублями через запятую — `ДД.ММ.ГГГГ ЧЧ:ММ —
 * ДД.ММ.ГГГГ ЧЧ:ММ, 50`. Сроки разбирает то же правило, что сроки недели;
 * лежит ли окно внутри недели, решает Auction.
 */
export function parseWindow(
  raw: string,
  timeZone: string,
  now: Date,
): WindowResult {
  const comma = raw.lastIndexOf(",");
  if (comma === -1) return { kind: "rejected", error: "window-format" };
  const interval = parseWeek(raw.slice(0, comma), timeZone, now);
  if (interval.kind === "rejected") {
    return { kind: "rejected", error: windowErrorOf[interval.error] };
  }
  const step = parseRubles(raw.slice(comma + 1));
  if (step.kind === "rejected") return { kind: "rejected", error: step.reason };
  return {
    kind: "ok",
    from: interval.opensAt,
    until: interval.closesAt,
    step: { minorUnits: step.rubles * 100, currency: lotCurrency },
  };
}

/**
 * Отпечаток окна для кнопки пульта: пять знаков base36 от сроков и шага
 * (FNV-1a). Номер окна в кнопке сдвигается, когда другое окно удалили, и
 * отпечаток отличает прежнее окно от того, что встало на его место.
 */
export function windowPrint(window: StepWindow): string {
  return print(
    `${window.from}|${window.until}|${window.step.minorUnits}|${window.step.currency}`,
  );
}

// Пять знаков base36 от строки (FNV-1a): отпечаток для кнопки пульта.
function print(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 36 ** 5).toString(36).padStart(5, "0");
}

// Сколько окон держит пульт: ряд на окно, «Добавить окно» и выход
// укладываются в двенадцать рядов экрана, а строки окон — в одно сообщение.
export const windowLimit = 8;

// Статусы, в которых пульт показывает строку розыгрыша после закрытия
// регистрации (PER-618): онлайн-торги, их закрытие, перерыв и итоги.
const rafflePhases: ReadonlySet<ConsoleAuctionStatus> = new Set([
  "prebidding",
  "settling",
  "break",
  "finished",
]);
/**
 * Сколько лотов держит состав финала в кнопке (PER-619): номер лота — знак
 * base36, и выбор порядка с отпечатком и страницей укладывается в 64 байта
 * при двадцати четырёх лотах. Финал на сходке — семь-восемь лотов.
 */
export const lineupLimit = 24;

/**
 * Удержанные для финала лоты по возрастанию идентификатора — порядок их
 * заведения, UUIDv7. В перерыве отметка «в финал» и есть удержание: торгов
 * нет, а проданный в перерыве лот отметку теряет.
 */
export function heldLots(console: AuctionConsoleView): ConsoleLot[] {
  return console.lots
    .filter((each) => each.markedForFinal)
    .sort((a, b) => a.lot.lotId.localeCompare(b.lot.lotId));
}

/** Отпечаток набора удержанных лотов: номера в кнопке указывают в него. */
export function lineupPrint(held: readonly ConsoleLot[]): string {
  return print(held.map((each) => each.lot.lotId).join("|"));
}

/** Номера кнопки годятся для этого набора: каждый в нём и не повторяется. */
function validOrder(order: readonly number[], size: number): boolean {
  return (
    new Set(order).size === order.length &&
    order.every((at) => Number.isInteger(at) && at >= 0 && at < size)
  );
}

/**
 * Порядок дозаполнен, когда выбрать осталось не больше одного лота:
 * последний встаёт в конец сам.
 */
function completed(
  order: readonly number[],
  size: number,
): number[] | undefined {
  if (order.length < size - 1) return undefined;
  const rest = [...Array(size).keys()].filter((at) => !order.includes(at));
  return [...order, ...rest];
}

// Сколько последних ставок текущего лота видит ведущий.
const recentBidLimit = 5;

/** Лот, который ведущий торгует сейчас, если он есть в реестре. */
export function activeLot(console: AuctionConsoleView): ConsoleLot | undefined {
  const active = console.lineup?.activeLotId;
  return active === undefined
    ? undefined
    : console.lots.find((each) => each.lot.lotId === active);
}

/**
 * Активный лот финала торгуется, даже если чтение ещё держит его удержанным:
 * статус аукциона Auction читает у самого аукциона, а лоты — из отстающей read
 * model. Без этого только что открытый лот показал бы «Открыть следующий лот».
 */
function liveActive(console: AuctionConsoleView): AuctionConsoleView {
  const active = console.lineup?.activeLotId;
  if (active === undefined) return console;
  return {
    ...console,
    lots: console.lots.map((each) => {
      const status = each.lot.status;
      if (each.lot.lotId !== active || status.kind !== "held") return each;
      return {
        ...each,
        lot: {
          ...each.lot,
          status: {
            kind: "trading",
            currentPrice: status.currentPrice,
            ...(status.leaderId === undefined
              ? {}
              : { leaderId: status.leaderId }),
            phase: "live",
          },
        },
      };
    }),
  };
}

/** Названное подтверждением совпадает с лотом сейчас. */
function quoted(
  quote: CloseQuote,
  status: { currentPrice: LotAmount; leaderId?: string },
): boolean {
  return status.leaderId === undefined
    ? quote.kind === "no-sale"
    : quote.kind === "sale" &&
        quote.minorUnits === status.currentPrice.minorUnits;
}

// Итог аукциона, когда закрыт последний лот состава (PER-639): позиция —
// последняя в замороженном составе, а состав после заморозки не меняется.
// Продажи считаются по пульту, прочитанному до команды, и само закрытие
// добавляется к ним: в прочитанном пульте лот ещё торгуется.
function lastOfLineup(
  console: AuctionConsoleView,
  position: number,
  entry: ConsoleLot,
  closed: LotClosure,
): { soldLots: number; total: LotAmount } | undefined {
  const order = console.lineup?.order ?? [];
  if (order.length === 0 || position !== order.length - 1) return undefined;
  const prices = console.lots.flatMap((each) =>
    each.lot.lotId !== entry.lot.lotId && each.lot.status.kind === "sold"
      ? [each.lot.status.price]
      : [],
  );
  if (closed.kind === "sold") prices.push(closed.price);
  const currency = prices[0]?.currency ?? lotCurrency;
  return {
    soldLots: prices.length,
    total: {
      minorUnits: prices.reduce((sum, price) => sum + price.minorUnits, 0),
      currency,
    },
  };
}

function titled(entry: ConsoleLot): { title?: string } {
  const title = entry.lot.card?.title;
  return title === undefined ? {} : { title };
}

/** Конец недели наступил по часам бота: открывать такую неделю нельзя. */
function weekEnded(console: AuctionConsoleView, now: Date): boolean {
  const closesAt = console.week?.closesAt;
  return closesAt !== undefined && Date.parse(closesAt) <= now.getTime();
}

function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

const notAdministrator: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "not-administrator",
};
const auctionNotFound: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "auction-not-found",
};

// Лоты добавляются, пока онлайн-неделя не открыта; после старта Auction
// отвечает `lots_frozen`. По тому же правилу лента показывает «Добавить лот».
export function acceptsLots(status: ConsoleAuctionStatus): boolean {
  return status === "draft" || status === "scheduled";
}

// Сроки, финал и окна меняются, пока онлайн-неделя не открыта.
function editable(console: AuctionConsoleView): boolean {
  return acceptsLots(console.status);
}

/** Окно по кнопке: номер и отпечаток совпали с прочитанной конфигурацией. */
function windowAt(
  console: AuctionConsoleView,
  ref: WindowRef,
): StepWindow | undefined {
  const window = console.week?.windows[ref.index];
  return window !== undefined && windowPrint(window) === ref.print
    ? window
    : undefined;
}

// Конфигурацию Auction уже принимал: отказ в ней теперь — дефект соседа.
function storedRefused(scheduled: ScheduleAuctionResult): ExecuteResult {
  return failed({
    kind: "invalid",
    cause: new Error(`stored auction configuration refused: ${scheduled.kind}`),
  });
}

export function createAuctionConsole(
  consoles: AuctionConsoles,
  timeZone: string,
  // Часы бота: по ним решается, прошёл ли конец недели. Тест их подменяет.
  now: () => Date = () => new Date(),
) {
  type Read =
    | { kind: "ok"; console: AuctionConsoleView }
    | { kind: "refused"; result: ExecuteResult };

  function readFailure(
    result: Exclude<
      ConsoleReadResult | LotStatisticsReadResult,
      { kind: "ok" }
    >,
  ): ExecuteResult {
    switch (result.kind) {
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(result);
    }
  }

  async function read(request: AuctionConsoleRequest): Promise<Read> {
    const [found, statistics] = await Promise.all([
      consoles.getAuctionConsole(
        request.identity,
        request.auctionId,
        rpcMeta(request),
      ),
      consoles.getAuctionLotStatistics(
        request.identity,
        request.auctionId,
        rpcMeta(request),
      ),
    ]);
    if (found.kind !== "ok") {
      return { kind: "refused", result: readFailure(found) };
    }
    if (statistics.kind !== "ok") {
      return { kind: "refused", result: readFailure(statistics) };
    }

    const byLot = new Map<string, (typeof statistics.lots)[number]>();
    for (const each of statistics.lots) {
      if (byLot.has(each.lotId)) {
        return {
          kind: "refused",
          result: failed({
            kind: "invalid",
            cause: new Error("duplicate lot in auction statistics"),
          }),
        };
      }
      byLot.set(each.lotId, each);
    }
    if (byLot.size !== found.console.lots.length) {
      return {
        kind: "refused",
        result: failed({
          kind: "invalid",
          cause: new Error("auction console and statistics lot sets differ"),
        }),
      };
    }

    const lots = [];
    for (const each of found.console.lots) {
      const statistic = byLot.get(each.lot.lotId);
      if (statistic === undefined) {
        return {
          kind: "refused",
          result: failed({
            kind: "invalid",
            cause: new Error("lot missing from auction statistics"),
          }),
        };
      }
      lots.push({
        ...each,
        bidCount: statistic.bidCount,
        uniqueParticipantCount: statistic.uniqueParticipantCount,
        ...(statistic.priceGrowth === undefined
          ? {}
          : { priceGrowth: statistic.priceGrowth }),
      });
    }
    const console = liveActive({ ...found.console, lots });
    const [trading, raffle] = await Promise.all([
      tradingOf(request, console),
      raffleOf(request, console),
    ]);
    return {
      kind: "ok",
      console: {
        ...console,
        ...(trading === undefined ? {} : { trading }),
        ...(raffle === undefined ? {} : { raffle }),
      },
    };
  }

  // Торги активного лота финала: последние ставки и имя лидера.
  async function tradingOf(
    request: AuctionConsoleRequest,
    console: AuctionConsoleView,
  ): Promise<FinalTrading | undefined> {
    const active = activeLot(console);
    if (active === undefined) return undefined;
    const leaderId =
      active.lot.status.kind === "trading"
        ? active.lot.status.leaderId
        : undefined;
    const bids = await consoles.recentBids(
      request.identity,
      {
        auctionId: request.auctionId,
        lotId: active.lot.lotId,
        limit: recentBidLimit,
        extraIds: leaderId === undefined ? [] : [leaderId],
      },
      rpcMeta(request),
    );
    // Ставки — подсказка ведущему, а не условие команды: без них пульт
    // показывает цену и лидера без имени, и «Продать» остаётся доступным.
    if (bids.kind !== "ok") return undefined;
    const leaderName =
      leaderId === undefined ? undefined : bids.names[leaderId];
    return {
      lotId: active.lot.lotId,
      bids: bids.bids.map((bid) => {
        const name = bids.names[bid.participantId];
        return name === undefined
          ? { amount: bid.amount }
          : { amount: bid.amount, name };
      }),
      ...(leaderName === undefined ? {} : { leaderName }),
    };
  }

  // Розыгрыш для строки пульта (PER-618): читается, только когда момент
  // закрытия регистрации у открытой недели прошёл, — до него строка называет
  // момент, и вызов не нужен. Пульт ведущего строки розыгрыша не несёт и
  // не читает его на каждом «Обновить». Отказ чтения пульт не роняет: строка
  // остаётся прежней.
  async function raffleOf(
    request: AuctionConsoleRequest,
    console: AuctionConsoleView,
  ): Promise<RaffleView | undefined> {
    const closesAt = console.week?.raffleClosesAt;
    if (
      closesAt === undefined ||
      !rafflePhases.has(console.status) ||
      Date.parse(closesAt) > now().getTime()
    ) {
      return undefined;
    }
    const raffle = await consoles.consoleRaffle(
      request.identity,
      request.auctionId,
      rpcMeta(request),
    );
    return raffle.kind === "ok" ? raffle.raffle : undefined;
  }

  // Аукцион, который держит слот торгов (PER-603): от открытия онлайн-торгов
  // до конца. Запланированный слот не держит, а свой аукцион — не другой.
  function holding(auctionId: string) {
    return (auction: AuctionSummaryView): boolean =>
      auction.auctionId !== auctionId &&
      auction.stage !== "draft" &&
      auction.stage !== "scheduled" &&
      auction.stage !== "finished";
  }

  function holderOf(auction: AuctionSummaryView): TradingHolder {
    return {
      auctionId: auction.auctionId,
      ...(auction.opensAt === undefined ? {} : { opensAt: auction.opensAt }),
      ...(auction.closesAt === undefined ? {} : { closesAt: auction.closesAt }),
    };
  }

  // Аукцион, названный отказом `AnotherAuctionActive`: его сроки — из чтения
  // активных аукционов, а отказ чтения оставляет один идентификатор.
  async function namedHolder(
    request: AuctionConsoleRequest,
    auctionId: string,
  ): Promise<TradingHolder> {
    const active = await consoles.activeAuctions(
      request.identity,
      rpcMeta(request),
    );
    const found =
      active.kind === "ok"
        ? active.auctions.find((each) => each.auctionId === auctionId)
        : undefined;
    return found === undefined ? { auctionId } : holderOf(found);
  }

  // Пульт после команды: чтение Auction с исходом первой строкой. Статус и
  // сроки Auction читает у самого аукциона, а лоты — из read model, и они
  // отстают от команды. Поэтому принятая команда накладывается на прочитанное,
  // как форма лота собирает экран из ответа команды.
  async function after(
    request: AuctionConsoleRequest,
    note: ConsoleNote | undefined,
    accepted: (console: AuctionConsoleView) => AuctionConsoleView = (each) =>
      each,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    return {
      kind: "auction-console",
      console: accepted(current.console),
      ...(note === undefined ? {} : { note }),
    };
  }

  async function scheduleWeek(
    request: Extract<
      AuctionConsoleRequest,
      { intent: "schedule-auction-week" }
    >,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (!editable(console)) {
      return { kind: "auction-console", console, note: "week-frozen" };
    }
    const asked = {
      kind: "auction-week-ask" as const,
      auctionId: request.auctionId,
      ...(console.week === undefined ? {} : { week: console.week }),
    };
    const week = parseWeek(request.value, timeZone, now());
    if (week.kind === "rejected") return { ...asked, error: week.error };
    const final = console.week?.final ?? defaultFinal;
    // Окна и момент розыгрыша едут с новыми сроками: без них Auction стёр бы
    // их молча.
    const windows = console.week?.windows ?? [];
    const raffleClosesAt = console.week?.raffleClosesAt;
    const scheduled = await consoles.scheduleAuction(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        opensAt: week.opensAt,
        closesAt: week.closesAt,
        final,
        windows,
        raffleClosesAt,
      },
      rpcMeta(request),
    );
    switch (scheduled.kind) {
      case "ok":
        return {
          kind: "auction-console",
          console: {
            ...console,
            status: "scheduled",
            week: {
              opensAt: week.opensAt,
              closesAt: week.closesAt,
              final,
              windows,
              ...(raffleClosesAt === undefined ? {} : { raffleClosesAt }),
            },
          },
          note: "week-saved",
        };
      case "closes-not-after-opens":
        return { ...asked, error: "week-order" };
      // Окно, которое не помещается в новые сроки, бот не выбрасывает сам:
      // человек решает, сдвинуть сроки или удалить окно.
      case "window-outside-week":
        return {
          ...asked,
          error: "week-cuts-window",
          window: scheduled.window + 1,
        };
      // Момент розыгрыша новые сроки тоже не выбрасывают молча: его сдвигает
      // или убирает человек кнопкой «Розыгрыш».
      case "raffle-not-after-opens":
      case "raffle-not-before-closes":
        return { ...asked, error: "week-cuts-raffle" };
      case "windows-overlap":
      case "window-step-invalid":
      case "window-lots-empty":
        return storedRefused(scheduled);
      case "already-started":
        return after(request, "week-frozen");
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(scheduled);
    }
  }

  // Финал меняется той же командой, что сроки: Auction заменяет конфигурацию
  // целиком, и сроки берутся из прочитанной. Кнопка несёт целевое состояние:
  // финал уже такой — команды нет, а ответ тот же.
  async function setFinal(
    request: Extract<AuctionConsoleRequest, { intent: "set-auction-final" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (!editable(console)) {
      return { kind: "auction-console", console, note: "week-frozen" };
    }
    const week = console.week;
    if (week?.opensAt === undefined || week.closesAt === undefined) {
      return { kind: "auction-console", console, note: "week-needed" };
    }
    const toggled = (each: AuctionConsoleView): ExecuteResult => ({
      kind: "auction-console",
      console: each,
      toggled: true,
    });
    if (week.final === request.final) return toggled(console);
    const scheduled = await consoles.scheduleAuction(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        opensAt: week.opensAt,
        closesAt: week.closesAt,
        final: request.final,
        windows: week.windows,
        raffleClosesAt: week.raffleClosesAt,
      },
      rpcMeta(request),
    );
    switch (scheduled.kind) {
      case "ok":
        return toggled({ ...console, week: { ...week, final: request.final } });
      case "already-started":
        return after(request, "week-frozen");
      // Сроки, окна и момент розыгрыша прочитаны у самого Auction, и он их
      // уже принимал.
      case "closes-not-after-opens":
      case "window-outside-week":
      case "windows-overlap":
      case "window-step-invalid":
      case "window-lots-empty":
      case "raffle-not-after-opens":
      case "raffle-not-before-closes":
        return storedRefused(scheduled);
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(scheduled);
    }
  }

  // Открытие недели. Ключ команды рождён в кнопке подтверждения: повторное
  // нажатие той же кнопки Auction принимает как повтор. Новый ключ на
  // открытом аукционе — «не запланирован», и пульт называет это словами
  // состояния: неделя уже открыта либо сроков ещё нет.
  async function startWeek(
    request: Extract<AuctionConsoleRequest, { intent: "start-auction-week" }>,
  ): Promise<ExecuteResult> {
    const started = await consoles.startPrebidding(
      request.identity,
      { auctionId: request.auctionId, opId: request.opId },
      rpcMeta(request),
    );
    switch (started.kind) {
      case "ok":
        return after(request, "week-opened", (console) =>
          editable(console) ? { ...console, status: "prebidding" } : console,
        );
      case "not-scheduled": {
        const current = await read(request);
        if (current.kind === "refused") return current.result;
        return {
          kind: "auction-console",
          console: current.console,
          note:
            current.console.status === "draft"
              ? "week-not-scheduled"
              : "week-already-open",
        };
      }
      // Торги идут у другого аукциона сообщества: исход называет его
      // (PER-618). Кадр с переходом к нему — PER-606.
      case "another-auction-active": {
        const [current, holder] = await Promise.all([
          read(request),
          namedHolder(request, started.auctionId),
        ]);
        if (current.kind === "refused") return current.result;
        return {
          kind: "auction-console",
          console: current.console,
          note: "another-auction-active",
          holder,
        };
      }
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(started);
    }
  }

  // «Удалить аукцион»: подтверждение — только пока неделя не открыта, ставок
  // ещё не было. Ключ удаления рождён краем и уедет в «Да».
  async function prepareDiscard(
    request: Extract<
      AuctionConsoleRequest,
      { intent: "prepare-auction-discard" }
    >,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (!editable(console)) {
      return { kind: "auction-console", console, note: "discard-too-late" };
    }
    return {
      kind: "auction-discard-confirm",
      auctionId: request.auctionId,
      opId: request.opId,
      lots: console.lots.length,
    };
  }

  // Удаление. Повтор той же кнопки Auction принимает как повтор; аукцион,
  // который уже удалили другим нажатием, Auction не находит.
  async function discard(
    request: Extract<AuctionConsoleRequest, { intent: "discard-auction" }>,
  ): Promise<ExecuteResult> {
    const discarded = await consoles.discardAuction(
      request.identity,
      { auctionId: request.auctionId, opId: request.opId },
      rpcMeta(request),
    );
    switch (discarded.kind) {
      case "ok":
        return { kind: "auction-discarded", auctionId: request.auctionId };
      case "already-started":
        return after(request, "discard-too-late");
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(discarded);
    }
  }

  async function markFinalist(
    request: Extract<
      AuctionConsoleRequest,
      { intent: "mark-auction-finalist" }
    >,
  ): Promise<ExecuteResult> {
    const mark = {
      auctionId: request.auctionId,
      lotId: request.lotId,
      opId: request.opId,
    };
    const marked = request.selected
      ? await consoles.selectForFinal(request.identity, mark, rpcMeta(request))
      : await consoles.deselectForFinal(
          request.identity,
          mark,
          rpcMeta(request),
        );
    switch (marked.kind) {
      case "ok":
        return after(
          request,
          request.selected ? "marked" : "unmarked",
          (console) => ({
            ...console,
            lots: console.lots.map((each) =>
              each.lot.lotId === request.lotId
                ? { ...each, markedForFinal: request.selected }
                : each,
            ),
          }),
        );
      case "refused":
        return after(request, marked.reason);
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(marked);
    }
  }

  // «Сроки недели»: вопрос называет текущие сроки, поэтому пульт читается до
  // него. Сроки открытой недели не меняются — вместо вопроса пульт с причиной.
  async function askWeek(
    request: Extract<AuctionConsoleRequest, { intent: "ask-auction-week" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (!editable(console)) {
      return { kind: "auction-console", console, note: "week-frozen" };
    }
    return {
      kind: "auction-week-ask",
      auctionId: request.auctionId,
      ...(console.week === undefined ? {} : { week: console.week }),
    };
  }

  // «Открыть онлайн-неделю»: подтверждение — только у запланированного
  // аукциона, чей конец недели не прошёл и у которого есть что открыть. В
  // остальных случаях пульт называет причину словами состояния. Ключ
  // открытия рождён краем и уедет в «Да».
  async function prepareStart(
    request: Extract<
      AuctionConsoleRequest,
      { intent: "prepare-auction-week-start" }
    >,
  ): Promise<ExecuteResult> {
    // Идущие торги другого аукциона пульт называет до подтверждения
    // (PER-618): «Да» на них Auction всё равно отказал бы. Чтение идёт
    // параллельно пульту, а его отказ подтверждения не прячет — страховкой
    // остаётся отказ команды.
    const [current, active] = await Promise.all([
      read(request),
      consoles.activeAuctions(request.identity, rpcMeta(request)),
    ]);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    const noted = (note: ConsoleNote): ExecuteResult => ({
      kind: "auction-console",
      console,
      note,
    });
    if (console.status === "draft") return noted("week-not-scheduled");
    if (console.status !== "scheduled") return noted("week-already-open");
    if (weekEnded(console, now())) return noted("week-ended");
    // Откроются лоты с условиями торгов; лоты без цены и шага останутся без
    // торгов: Auction открывает только запланированные.
    const opening = console.lots.filter(
      (each) => each.lot.status.kind === "scheduled",
    ).length;
    const idle = console.lots.filter(
      (each) => each.lot.status.kind === "draft",
    ).length;
    if (opening === 0) return noted("no-lots-to-open");
    const holder =
      active.kind === "ok"
        ? active.auctions.find(holding(request.auctionId))
        : undefined;
    if (holder !== undefined) {
      return {
        kind: "auction-console",
        console,
        note: "another-auction-active",
        holder: holderOf(holder),
      };
    }
    return {
      kind: "auction-week-confirm",
      console,
      opId: request.opId,
      opening,
      idle,
    };
  }

  // Финал ведущего (PER-337). Лот финала называет номер в замороженном
  // составе; номер вне состава — кнопка от другого аукциона или подделка.
  type Positioned =
    | { kind: "ok"; console: AuctionConsoleView; entry: ConsoleLot }
    | { kind: "refused"; result: ExecuteResult };

  async function positioned(
    request: AuctionConsoleRequest & { position: number },
  ): Promise<Positioned> {
    const current = await read(request);
    if (current.kind === "refused") return current;
    const { console } = current;
    const lotId = console.lineup?.order[request.position];
    const entry = console.lots.find((each) => each.lot.lotId === lotId);
    if (entry !== undefined) return { kind: "ok", console, entry };
    // Закрытие последнего лота завершает аукцион, а `Finished` состава не
    // несёт: повтор «Да» после потерянного ответа узнаёт итог по пульту.
    return {
      kind: "refused",
      result: {
        kind: "auction-console",
        console,
        note:
          console.status === "finished"
            ? "final-finished"
            : "lot-not-in-auction",
      },
    };
  }

  // Начать финал. Повтор — тот же ответ: финал уже идёт, и пульт его
  // показывает; новый ключ на идущем финале Auction называет «состав не
  // заморожен», и пульт отличает это по статусу.
  async function startFinal(
    request: Extract<AuctionConsoleRequest, { intent: "start-auction-final" }>,
  ): Promise<ExecuteResult> {
    const started = await consoles.startFinal(
      request.identity,
      { auctionId: request.auctionId, opId: request.opId },
      rpcMeta(request),
    );
    switch (started.kind) {
      case "ok":
        return after(request, "final-started", (console) =>
          console.status === "lineup-frozen"
            ? { ...console, status: "final" }
            : console,
        );
      case "lineup-not-frozen": {
        const current = await read(request);
        if (current.kind === "refused") return current.result;
        return {
          kind: "auction-console",
          console: current.console,
          note:
            current.console.status === "final" ||
            current.console.status === "finished"
              ? "final-started"
              : "lineup-not-frozen",
        };
      }
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(started);
    }
  }

  // Состав финала объявляют только в перерыве. Объявленный — этой кнопкой
  // или раньше — пульт называет словами состояния, и повтор «Да» второго
  // объявления не просит.
  function breakNote(console: AuctionConsoleView): ConsoleNote | undefined {
    switch (console.status) {
      case "break":
        return undefined;
      case "lineup-frozen":
      case "final":
        return "lineup-frozen";
      case "finished":
        return "final-finished";
      default:
        return "not-in-break";
    }
  }

  type Held =
    | { kind: "ok"; console: AuctionConsoleView; held: ConsoleLot[] }
    | { kind: "refused"; result: ExecuteResult };

  async function readHeld(request: AuctionConsoleRequest): Promise<Held> {
    const current = await read(request);
    if (current.kind === "refused") return current;
    const { console } = current;
    const held = heldLots(console);
    const note =
      breakNote(console) ??
      (held.length === 0
        ? "lineup-empty"
        : held.length > lineupLimit
          ? "lineup-too-long"
          : undefined);
    return note === undefined
      ? { kind: "ok", console, held }
      : { kind: "refused", result: { kind: "auction-console", console, note } };
  }

  // Выбор порядка начат заново: набор удержанных изменился после экрана.
  function reordered(
    console: AuctionConsoleView,
    held: ConsoleLot[],
  ): ExecuteResult {
    return {
      kind: "lineup-order",
      console,
      held,
      pick: { print: lineupPrint(held), order: [] },
      page: 0,
      changed: true,
    };
  }

  // Порядок финала выбирает администратор по одному лоту (решение владельца
  // 14 октября 2026 года). Выбрано всё, кроме последнего, — подтверждение.
  async function orderLineup(
    request: Extract<AuctionConsoleRequest, { intent: "order-final-lineup" }>,
  ): Promise<ExecuteResult> {
    const found = await readHeld(request);
    if (found.kind === "refused") return found.result;
    const { console, held } = found;
    const current = lineupPrint(held);
    const pick = request.pick ?? { print: current, order: [] };
    if (pick.print !== current || !validOrder(pick.order, held.length)) {
      return reordered(console, held);
    }
    const order = completed(pick.order, held.length);
    return order === undefined
      ? { kind: "lineup-order", console, held, pick, page: request.page }
      : {
          kind: "lineup-confirm",
          console,
          held,
          pick: { print: current, order },
        };
  }

  // Объявить состав. Ключ рождён на нажатие: повтор после принятого
  // объявления застаёт аукцион вне перерыва и к Auction не идёт.
  async function freezeLineup(
    request: Extract<AuctionConsoleRequest, { intent: "freeze-final-lineup" }>,
  ): Promise<ExecuteResult> {
    const found = await readHeld(request);
    if (found.kind === "refused") return found.result;
    const { console, held } = found;
    const { pick } = request;
    if (
      pick.print !== lineupPrint(held) ||
      pick.order.length !== held.length ||
      !validOrder(pick.order, held.length)
    ) {
      return reordered(console, held);
    }
    const lotIds = pick.order.flatMap((at) => {
      const entry = held[at];
      return entry === undefined ? [] : [entry.lot.lotId];
    });
    const frozen = await consoles.freezeFinalLineup(
      request.identity,
      { auctionId: request.auctionId, opId: request.opId, lotIds },
      rpcMeta(request),
    );
    switch (frozen.kind) {
      case "ok":
        return after(request, "lineup-frozen");
      case "not-in-break": {
        const current = await read(request);
        if (current.kind === "refused") return current.result;
        return {
          kind: "auction-console",
          console: current.console,
          note: breakNote(current.console) ?? "not-in-break",
        };
      }
      case "lineup-empty":
        return after(request, "lineup-empty");
      // Набор удержанных изменился между чтением и командой либо чтение
      // лотов отстаёт от аукциона. Набор удержанных пульт читает только из
      // read model, поэтому выбор начинается заново над перечитанным: пока
      // проекция не догнала, Auction ответит тем же отказом.
      case "lineup-mismatch": {
        const again = await readHeld(request);
        return again.kind === "refused"
          ? again.result
          : reordered(again.console, again.held);
      }
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(frozen);
    }
  }

  // Открыть следующий лот состава. Пока лот торгуется, следующего Auction не
  // открывает: пульт называет это строкой, а не открывает второй.
  async function startNextLot(
    request: Extract<AuctionConsoleRequest, { intent: "start-final-lot" }>,
  ): Promise<ExecuteResult> {
    const started = await consoles.startNextLot(
      request.identity,
      { auctionId: request.auctionId, opId: request.opId },
      rpcMeta(request),
    );
    switch (started.kind) {
      case "ok":
        return after(request, undefined, (console) =>
          console.lineup === undefined
            ? console
            : liveActive({
                ...console,
                lineup: { ...console.lineup, activeLotId: started.lotId },
              }),
        );
      case "not-in-final":
        return after(request, "not-in-final");
      case "another-lot-active":
        return after(request, "another-lot-active");
      case "lineup-exhausted":
        return after(request, "lineup-exhausted");
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(started);
    }
  }

  // «Поднять цену»: вопрос называет лот и его следующую цену.
  async function askPrice(
    request: Extract<AuctionConsoleRequest, { intent: "ask-final-price" }>,
  ): Promise<ExecuteResult> {
    const found = await positioned(request);
    if (found.kind === "refused") return found.result;
    const { entry } = found;
    if (entry.lot.status.kind !== "trading") {
      return {
        kind: "auction-console",
        console: found.console,
        note: "final-lot-closed",
      };
    }
    return {
      kind: "final-ask",
      auctionId: request.auctionId,
      position: request.position,
      ...titled(entry),
      ...(entry.lot.nextPrice === undefined
        ? {}
        : { nextPrice: entry.lot.nextPrice }),
    };
  }

  // Новая следующая цена лота. Цену ниже текущей решает Auction и отвечает
  // порогом, который вопрос называет заново; бот её не предугадывает.
  async function advanceAsk(
    request: Extract<AuctionConsoleRequest, { intent: "advance-final-ask" }>,
  ): Promise<ExecuteResult> {
    const found = await positioned(request);
    if (found.kind === "refused") return found.result;
    const { console, entry } = found;
    const status = entry.lot.status;
    if (status.kind !== "trading") {
      return { kind: "auction-console", console, note: "final-lot-closed" };
    }
    const asked = {
      kind: "final-ask" as const,
      auctionId: request.auctionId,
      position: request.position,
      ...titled(entry),
      ...(entry.lot.nextPrice === undefined
        ? {}
        : { nextPrice: entry.lot.nextPrice }),
    };
    const amount = parseRubles(request.value);
    if (amount.kind === "rejected") return { ...asked, error: amount.reason };
    const newAsk = {
      minorUnits: amount.rubles * 100,
      currency: status.currentPrice.currency,
    };
    const advanced = await consoles.advanceAsk(
      request.identity,
      {
        auctionId: request.auctionId,
        lotId: entry.lot.lotId,
        opId: request.opId,
        newAsk,
      },
      rpcMeta(request),
    );
    switch (advanced.kind) {
      // Ответ ask пуст, а чтение отстаёт: пульт показывает объявленную цену
      // следующей. Прокси, которому она по карману, берёт её той же
      // транзакцией (RFC-011, О-6.B) — новую цену и лидера покажет
      // «Обновить», когда чтение догонит.
      case "ok":
        return after(request, undefined, (each) => ({
          ...each,
          lots: each.lots.map((lot) =>
            lot.lot.lotId === entry.lot.lotId
              ? { ...lot, lot: { ...lot.lot, nextPrice: newAsk } }
              : lot,
          ),
        }));
      case "ask-below-current-price":
        return {
          ...asked,
          error: "ask-below-current-price",
          mustExceed: advanced.mustExceed,
        };
      case "lot-not-open":
        return after(request, "final-lot-closed");
      case "lot-not-in-auction":
        return after(request, "lot-not-in-auction");
      case "currency-mismatch":
        // Валюта взята у самого лота: расхождение — дефект соседа.
        return failed({
          kind: "invalid",
          cause: new Error("ask in the currency of the lot refused"),
        });
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(advanced);
    }
  }

  // «Продать»: подтверждение называет лот, цену и лидера, а без ставок —
  // закрытие без продажи. Ключ закрытия рождён краем и уедет в «Да».
  async function prepareClose(
    request: Extract<AuctionConsoleRequest, { intent: "prepare-final-close" }>,
  ): Promise<ExecuteResult> {
    const found = await positioned(request);
    if (found.kind === "refused") return found.result;
    const { console, entry } = found;
    const status = entry.lot.status;
    if (status.kind !== "trading") {
      return { kind: "auction-console", console, note: "final-lot-closed" };
    }
    const leaderName =
      console.trading?.lotId === entry.lot.lotId
        ? console.trading.leaderName
        : undefined;
    return {
      kind: "final-close-confirm",
      auctionId: request.auctionId,
      position: request.position,
      opId: request.opId,
      ...titled(entry),
      ...(status.leaderId === undefined ? {} : { price: status.currentPrice }),
      ...(leaderName === undefined ? {} : { leaderName }),
    };
  }

  // Исход закрытия — свой экран (решение владельца 11 октября 2026 года):
  // продажа необратима и подтверждается явно. Имя покупателя спрашивается
  // отдельно: повтор той же кнопки приходит, когда лот уже не активен и
  // торгов пульт не держит. Без имени исход остаётся исходом: продажа
  // состоялась, и сбой чтения имён её не отменяет.
  async function closure(
    request: Extract<AuctionConsoleRequest, { intent: "close-final-lot" }>,
    found: { console: AuctionConsoleView; entry: ConsoleLot },
    closed: LotClosure,
  ): Promise<ExecuteResult> {
    const { console, entry } = found;
    const last = lastOfLineup(console, request.position, entry, closed);
    const outcome = {
      kind: "final-lot-closed" as const,
      auctionId: request.auctionId,
      ...titled(entry),
      ...(last === undefined ? {} : { last }),
    };
    if (closed.kind === "unsold") {
      return { ...outcome, closure: { kind: "unsold" } };
    }
    const names = await consoles.displayNames(
      request.identity,
      { auctionId: request.auctionId, participantIds: [closed.winnerId] },
      rpcMeta(request),
    );
    const buyerName =
      names.kind === "ok" ? names.names[closed.winnerId] : undefined;
    return {
      ...outcome,
      closure: {
        kind: "sold",
        price: closed.price,
        ...(buyerName === undefined ? {} : { buyerName }),
      },
    };
  }

  // Закрытие лота. Повтор той же кнопки Auction отвечает исходным закрытием,
  // поэтому второе нажатие второй продажи не создаёт; лот, закрытый другим
  // ключом, — «уже закрыт».
  async function closeLot(
    request: Extract<AuctionConsoleRequest, { intent: "close-final-lot" }>,
  ): Promise<ExecuteResult> {
    const found = await positioned(request);
    if (found.kind === "refused") return found.result;
    const lotId = found.entry.lot.lotId;
    // `CloseLot` ожидаемой цены не несёт: продаёт лидеру по цене на момент
    // решения. Ставка зала после подтверждения сменила бы покупателя или цену
    // молча, поэтому бот сверяет названное со свежим чтением и при
    // расхождении подтверждает заново. Окно между чтением и командой
    // остаётся: закрыть его может только поле контракта.
    const status = found.entry.lot.status;
    if (status.kind === "trading" && !quoted(request.quote, status)) {
      const fresh = await prepareClose({
        ...request,
        intent: "prepare-final-close",
        opId: request.freshOpId,
      });
      return fresh.kind === "final-close-confirm"
        ? { ...fresh, changed: true }
        : fresh;
    }
    const closed = await consoles.closeLot(
      request.identity,
      { auctionId: request.auctionId, lotId, opId: request.opId },
      rpcMeta(request),
    );
    switch (closed.kind) {
      case "ok":
        return closure(request, found, closed.closure);
      case "lot-not-open":
        return after(request, "final-lot-closed");
      case "deadline-not-reached":
        return after(request, "deadline-not-reached");
      case "lot-not-in-auction":
        return after(request, "lot-not-in-auction");
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(closed);
    }
  }

  // «Счастливые часы» (PER-504). Окна живут только в конфигурации Auction:
  // каждая команда читает её заново, меняет окна и отдаёт целиком той же
  // `ScheduleAuction`, что сроки и финал. Двое администраторов, нажавших
  // одновременно, — последний выигрывает, как у переключателя финала:
  // закрыть это может только версия в контракте.
  type ScheduledWeek = AuctionWeek & { opensAt: string; closesAt: string };
  type Editable =
    | { kind: "ok"; console: AuctionConsoleView; week: ScheduledWeek }
    | { kind: "refused"; result: ExecuteResult };

  async function editableWeek(
    request: AuctionConsoleRequest,
  ): Promise<Editable> {
    const current = await read(request);
    if (current.kind === "refused") return current;
    const { console } = current;
    if (!editable(console)) {
      return {
        kind: "refused",
        result: { kind: "auction-console", console, note: "week-frozen" },
      };
    }
    const week = console.week;
    if (week?.opensAt === undefined || week.closesAt === undefined) {
      return {
        kind: "refused",
        result: { kind: "auction-console", console, note: "week-needed" },
      };
    }
    return {
      kind: "ok",
      console,
      week: { ...week, opensAt: week.opensAt, closesAt: week.closesAt },
    };
  }

  function withWindows(
    console: AuctionConsoleView,
    week: AuctionWeek,
    windows: readonly StepWindow[],
  ): AuctionConsoleView {
    return { ...console, week: { ...week, windows } };
  }

  function scheduleWindows(
    request: AuctionConsoleRequest & { opId: string },
    week: ScheduledWeek,
    windows: readonly StepWindow[],
  ): Promise<ScheduleAuctionResult> {
    return consoles.scheduleAuction(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        opensAt: week.opensAt,
        closesAt: week.closesAt,
        final: week.final,
        windows,
        raffleClosesAt: week.raffleClosesAt,
      },
      rpcMeta(request),
    );
  }

  // Исходы, общие у всех команд над окнами и моментом розыгрыша: отказы
  // конфигурации каждая команда разбирает сама до этой функции.
  function windowsRefused(
    request: AuctionConsoleRequest,
    scheduled: ScheduleAuctionResult,
  ): Promise<ExecuteResult> | ExecuteResult {
    switch (scheduled.kind) {
      case "already-started":
        return after(request, "week-frozen");
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      case "ok":
      case "closes-not-after-opens":
      case "window-outside-week":
      case "windows-overlap":
      case "window-step-invalid":
      case "window-lots-empty":
      case "raffle-not-after-opens":
      case "raffle-not-before-closes":
        return storedRefused(scheduled);
      default:
        return failed(scheduled);
    }
  }

  // Розыгрыш (PER-593). Момент закрытия регистрации живёт в той же
  // конфигурации, что сроки и окна: команда читает её заново и отдаёт целиком.
  // Вопрос называет сроки недели и текущий момент, поэтому пульт читается до
  // него; без сроков вопроса нет — момент лежит внутри недели.
  async function askRaffle(
    request: Extract<AuctionConsoleRequest, { intent: "ask-auction-raffle" }>,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    return {
      kind: "auction-raffle-ask",
      auctionId: request.auctionId,
      week: found.week,
    };
  }

  function scheduleRaffle(
    request: AuctionConsoleRequest & { opId: string },
    week: ScheduledWeek,
    raffleClosesAt: string | undefined,
  ): Promise<ScheduleAuctionResult> {
    return consoles.scheduleAuction(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        opensAt: week.opensAt,
        closesAt: week.closesAt,
        final: week.final,
        windows: week.windows,
        raffleClosesAt,
      },
      rpcMeta(request),
    );
  }

  // Исход команды над моментом розыгрыша: пульт с заметкой и неделей, на
  // которую наложена принятая команда, — чтение отстаёт от команд.
  function raffleScheduled(
    console: AuctionConsoleView,
    week: ScheduledWeek,
    raffleClosesAt: string | undefined,
  ): ExecuteResult {
    const { raffleClosesAt: _previous, ...rest } = week;
    return {
      kind: "auction-console",
      console: {
        ...console,
        week: raffleClosesAt === undefined ? rest : { ...rest, raffleClosesAt },
      },
      note: raffleClosesAt === undefined ? "raffle-removed" : "raffle-saved",
    };
  }

  async function setRaffle(
    request: Extract<AuctionConsoleRequest, { intent: "set-auction-raffle" }>,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    const { console, week } = found;
    const asked = {
      kind: "auction-raffle-ask" as const,
      auctionId: request.auctionId,
      week,
    };
    const parsed = parseRaffle(request.value, week, timeZone, now());
    if (parsed.kind === "rejected") return { ...asked, error: parsed.error };
    const scheduled = await scheduleRaffle(
      request,
      week,
      parsed.raffleClosesAt,
    );
    switch (scheduled.kind) {
      case "ok":
        return raffleScheduled(console, week, parsed.raffleClosesAt);
      // Сроки бот проверил по прочитанным, но их мог сдвинуть второй
      // администратор: отказ Auction — тот же ответ, что проверка бота.
      case "raffle-not-after-opens":
      case "raffle-not-before-closes":
        return { ...asked, error: scheduled.kind };
      default:
        return windowsRefused(request, scheduled);
    }
  }

  // «Убрать розыгрыш»: неделя без момента проходит без розыгрыша. Момента уже
  // нет — команды нет, а ответ тот же: кнопка могла устареть.
  async function removeRaffle(
    request: Extract<
      AuctionConsoleRequest,
      { intent: "remove-auction-raffle" }
    >,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    const { console, week } = found;
    if (week.raffleClosesAt === undefined) {
      return raffleScheduled(console, week, undefined);
    }
    const scheduled = await scheduleRaffle(request, week, undefined);
    return scheduled.kind === "ok"
      ? raffleScheduled(console, week, undefined)
      : windowsRefused(request, scheduled);
  }

  // «Добавить окно»: вопрос называет сроки недели, поэтому пульт читается до
  // него. Окну нужны лоты: без реестра вопрос не задаётся.
  async function askWindow(
    request: Extract<AuctionConsoleRequest, { intent: "ask-step-window" }>,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    if (found.console.lots.length === 0) {
      return {
        kind: "step-windows",
        console: found.console,
        note: { kind: "no-lots" },
      };
    }
    if (found.week.windows.length >= windowLimit) {
      return {
        kind: "step-windows",
        console: found.console,
        note: { kind: "limit" },
      };
    }
    return {
      kind: "step-window-ask",
      auctionId: request.auctionId,
      week: found.week,
    };
  }

  // Новое окно рождается со всеми лотами реестра (решение владельца
  // 11 октября 2026 года): «все» — это выбор всех, а лишние организатор
  // снимает на экране окна. Пустого окна Auction не принимает.
  async function addWindow(
    request: Extract<AuctionConsoleRequest, { intent: "add-step-window" }>,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    const { console, week } = found;
    const asked = {
      kind: "step-window-ask" as const,
      auctionId: request.auctionId,
      week,
    };
    const parsed = parseWindow(request.value, timeZone, now());
    if (parsed.kind === "rejected") return { ...asked, error: parsed.error };
    if (console.lots.length === 0) {
      return { kind: "step-windows", console, note: { kind: "no-lots" } };
    }
    if (week.windows.length >= windowLimit) {
      return { kind: "step-windows", console, note: { kind: "limit" } };
    }
    const index = week.windows.length;
    const windows = [
      ...week.windows,
      {
        from: parsed.from,
        until: parsed.until,
        step: parsed.step,
        lotIds: console.lots.map((each) => each.lot.lotId),
      },
    ];
    const scheduled = await scheduleWindows(request, week, windows);
    switch (scheduled.kind) {
      case "ok":
        return {
          kind: "step-windows",
          console: withWindows(console, week, windows),
          note: { kind: "saved", window: index + 1 },
        };
      case "window-outside-week":
        return scheduled.window === index
          ? { ...asked, error: "window-outside-week" }
          : storedRefused(scheduled);
      case "window-step-invalid":
        return scheduled.window === index
          ? { ...asked, error: "window-step" }
          : storedRefused(scheduled);
      case "windows-overlap":
        // Новое окно последнее в списке: с ним пересеклось первое из пары.
        return scheduled.second === index
          ? { ...asked, error: "window-overlap", window: scheduled.first + 1 }
          : storedRefused(scheduled);
      default:
        return windowsRefused(request, scheduled);
    }
  }

  async function viewWindow(
    request: Extract<AuctionConsoleRequest, { intent: "view-step-window" }>,
  ): Promise<ExecuteResult> {
    const current = await read(request);
    if (current.kind === "refused") return current.result;
    const { console } = current;
    if (windowAt(console, request.window) === undefined) {
      return { kind: "step-windows", console, note: { kind: "changed" } };
    }
    return {
      kind: "step-window",
      console,
      index: request.window.index,
      at: { page: request.page },
    };
  }

  // Лот в окне и вне его. Кнопка несёт целевое состояние: лот уже такой —
  // команды нет, а ответ тот же.
  async function setWindowLot(
    request: Extract<AuctionConsoleRequest, { intent: "set-step-window-lot" }>,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    const { console, week } = found;
    const { index } = request.window;
    const window = windowAt(console, request.window);
    if (window === undefined) {
      return { kind: "step-windows", console, note: { kind: "changed" } };
    }
    if (!console.lots.some((each) => each.lot.lotId === request.lotId)) {
      return { kind: "auction-console", console, note: "lot-not-in-auction" };
    }
    const shown = (each: AuctionConsoleView): ExecuteResult => ({
      kind: "step-window",
      console: each,
      index,
      at: { lotId: request.lotId },
      toggled: { selected: request.selected },
    });
    if (window.lotIds.includes(request.lotId) === request.selected) {
      return shown(console);
    }
    const lotIds = request.selected
      ? [...window.lotIds, request.lotId]
      : window.lotIds.filter((lotId) => lotId !== request.lotId);
    if (lotIds.length === 0) {
      return {
        kind: "step-windows",
        console,
        note: { kind: "last-lot", window: index + 1 },
      };
    }
    const windows = week.windows.map((each, at) =>
      at === index ? { ...each, lotIds } : each,
    );
    const scheduled = await scheduleWindows(request, week, windows);
    switch (scheduled.kind) {
      case "ok":
        return shown(withWindows(console, week, windows));
      case "windows-overlap": {
        // Лот добавлен в окно, которое пересекается с другим окном этого
        // лота: человек выбирает, в каком из двух лоту быть.
        const other =
          scheduled.first === index ? scheduled.second : scheduled.first;
        return {
          kind: "step-windows",
          console,
          note: { kind: "overlap", window: index + 1, other: other + 1 },
        };
      }
      default:
        return windowsRefused(request, scheduled);
    }
  }

  // Удаление окна — без подтверждения: окно задаётся заново одним ответом.
  async function removeWindow(
    request: Extract<AuctionConsoleRequest, { intent: "remove-step-window" }>,
  ): Promise<ExecuteResult> {
    const found = await editableWeek(request);
    if (found.kind === "refused") return found.result;
    const { console, week } = found;
    const { index } = request.window;
    if (windowAt(console, request.window) === undefined) {
      return { kind: "step-windows", console, note: { kind: "changed" } };
    }
    const windows = week.windows.filter((_, at) => at !== index);
    const scheduled = await scheduleWindows(request, week, windows);
    return scheduled.kind === "ok"
      ? {
          kind: "step-windows",
          console: withWindows(console, week, windows),
          note: { kind: "removed", window: index + 1 },
        }
      : windowsRefused(request, scheduled);
  }

  return async function auctionConsole(
    request: AuctionConsoleRequest,
  ): Promise<ExecuteResult> {
    switch (request.intent) {
      case "order-final-lineup":
        return orderLineup(request);
      case "freeze-final-lineup":
        return freezeLineup(request);
      case "start-auction-final":
        return startFinal(request);
      case "start-final-lot":
        return startNextLot(request);
      case "ask-final-price":
        return askPrice(request);
      case "advance-final-ask":
        return advanceAsk(request);
      case "prepare-final-close":
        return prepareClose(request);
      case "close-final-lot":
        return closeLot(request);
      case "view-auction-console":
        return after(request, undefined);
      case "ask-auction-week":
        return askWeek(request);
      case "prepare-auction-week-start":
        return prepareStart(request);
      case "schedule-auction-week":
        return scheduleWeek(request);
      case "ask-auction-raffle":
        return askRaffle(request);
      case "set-auction-raffle":
        return setRaffle(request);
      case "remove-auction-raffle":
        return removeRaffle(request);
      case "set-auction-final":
        return setFinal(request);
      case "start-auction-week":
        return startWeek(request);
      case "mark-auction-finalist":
        return markFinalist(request);
      case "prepare-auction-discard":
        return prepareDiscard(request);
      case "discard-auction":
        return discard(request);
      case "view-step-windows": {
        const current = await read(request);
        return current.kind === "refused"
          ? current.result
          : { kind: "step-windows", console: current.console };
      }
      case "view-step-window":
        return viewWindow(request);
      case "ask-step-window":
        return askWindow(request);
      case "add-step-window":
        return addWindow(request);
      case "set-step-window-lot":
        return setWindowLot(request);
      case "remove-step-window":
        return removeWindow(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
