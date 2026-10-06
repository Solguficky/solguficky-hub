import type {
  AuctionConsoles,
  AuctionFailure,
  ConsoleReadResult,
} from "../auction/port.js";
import { communityInstant } from "../community-time.js";
import { rpcMeta } from "../rpc-metadata.js";
import type {
  AuctionConsoleRequest,
  AuctionConsoleView,
  ConsoleNote,
  ExecuteResult,
  WeekAskError,
} from "./types.js";

// Пульт аукциона администратора (PER-320): сроки онлайн-недели и финал,
// открытие недели и отметка лотов для финала. Своего состояния у пульта нет:
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
  const moments = [numbers.slice(0, 5), numbers.slice(5, 10)].map(
    ([day = 0, month = 0, year = 0, hours = 0, minutes = 0]) => {
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
    },
  );
  const [opens, closes] = moments;
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

// Сроки и финал меняются, пока онлайн-неделя не открыта.
function editable(console: AuctionConsoleView): boolean {
  return console.status === "draft" || console.status === "scheduled";
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

  async function read(request: AuctionConsoleRequest): Promise<Read> {
    const found: ConsoleReadResult = await consoles.getAuctionConsole(
      request.identity,
      request.auctionId,
      rpcMeta(request),
    );
    switch (found.kind) {
      case "ok":
        return { kind: "ok", console: found.console };
      case "not-administrator":
      case "meetup-not-found":
        return { kind: "refused", result: notAdministrator };
      case "auction-not-found":
        return { kind: "refused", result: auctionNotFound };
      default:
        return { kind: "refused", result: failed(found) };
    }
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
    const scheduled = await consoles.scheduleAuction(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        opensAt: week.opensAt,
        closesAt: week.closesAt,
        final,
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
            week: { opensAt: week.opensAt, closesAt: week.closesAt, final },
          },
          note: "week-saved",
        };
      case "closes-not-after-opens":
        return { ...asked, error: "week-order" };
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
      },
      rpcMeta(request),
    );
    switch (scheduled.kind) {
      case "ok":
        return toggled({ ...console, week: { ...week, final: request.final } });
      case "already-started":
        return after(request, "week-frozen");
      case "closes-not-after-opens":
        // Сроки прочитаны у самого Auction, и он их уже принимал.
        return failed({
          kind: "invalid",
          cause: new Error("stored auction week refused as invalid"),
        });
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
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      case "auction-not-found":
        return auctionNotFound;
      default:
        return failed(started);
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
    const current = await read(request);
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
    return {
      kind: "auction-week-confirm",
      console,
      opId: request.opId,
      opening,
      idle,
    };
  }

  return async function auctionConsole(
    request: AuctionConsoleRequest,
  ): Promise<ExecuteResult> {
    switch (request.intent) {
      case "view-auction-console":
        return after(request, undefined);
      case "ask-auction-week":
        return askWeek(request);
      case "prepare-auction-week-start":
        return prepareStart(request);
      case "schedule-auction-week":
        return scheduleWeek(request);
      case "set-auction-final":
        return setFinal(request);
      case "start-auction-week":
        return startWeek(request);
      case "mark-auction-finalist":
        return markFinalist(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
