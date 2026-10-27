import type { LotView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  AuctionFailure,
  LotAdministration,
} from "../auction/port.js";
import { parseWeek } from "./auction-console.js";
import { fingerprint } from "./fingerprint.js";
import type {
  AuctionConsoleSnapshot,
  ExecuteResult,
  HappyHourAmountError,
  HappyHourField,
  HappyHourLot,
  HappyHourLotTerms,
  HappyHourPeriod,
  HappyHoursRequest,
  LotAmount,
  PeriodAskError,
  WindowRef,
} from "./types.js";

// «Счастливые часы» периодами (PER-787; контракт — PER-785 и PER-786,
// ADR-047, дополнение 2026-10-27). Держатель права вести аукцион создаёт
// период сроками в онлайн-торгах и удаляет его до начала, а условия лота —
// стартовую цену, шаг или оба — задаёт с карточки лота под каждый период; с
// начала периода всё только для просмотра. Своего состояния нет: каждый экран
// читает пульт заново, период кнопка называет номером и отпечатком, а каждая
// команда условий читает прежние условия и шлёт их целиком. Право решает
// Auction у Meetups; пускает сюда край — держателя права вести аукцион.

// Непрошедших периодов не больше десяти: ряд на период, «Создать период» и
// возврат укладываются в двенадцать рядов (дизайн-код, «Пульт аукциона»).
// Прошедший период рядом не стоит: изменить его нельзя, и место он не
// занимает.
export const periodLimit = 10;

/** Период ещё не кончился: у него есть ряд на экране. */
export function periodOpen(period: HappyHourPeriod, now: string): boolean {
  return Date.parse(period.until) > Date.parse(now);
}

function openCount(periods: readonly HappyHourPeriod[], now: string): number {
  return periods.filter((period) => periodOpen(period, now)).length;
}

// Сумма ответа — целые рубли, как шаг окна: копеек у торгов нет.
const amountPattern = /^\d{1,7}$/;
const amountLimit = 9_999_999;
// «Как обычно» — снять параметр: прочерк или слова.
const usualAnswers: ReadonlySet<string> = new Set(["-", "—", "как обычно"]);

/** Отпечаток периода для кнопки: номер сдвигается, когда период удалили. */
export function periodPrint(period: HappyHourPeriod): string {
  return fingerprint(period.periodId);
}

export function periodRef(period: HappyHourPeriod, index: number): WindowRef {
  return { index, print: periodPrint(period) };
}

/** Период начался: с начала он заморожен (ADR-047, дополнение 2026-10-27). */
export function periodStarted(period: HappyHourPeriod, now: string): boolean {
  return Date.parse(period.from) <= Date.parse(now);
}

export type AmountParse =
  | { kind: "ok"; amount?: LotAmount }
  | { kind: "rejected"; error: HappyHourAmountError };

/**
 * Ответ о стартовой или шаге: целые рубли или «-» — как обычно. Валюта —
 * валюта лота.
 */
export function parseHappyHourAmount(
  raw: string,
  currency: string,
): AmountParse {
  const value = raw.trim().toLowerCase();
  if (usualAnswers.has(value)) return { kind: "ok" };
  const digits = value.replace(/\s/g, "");
  if (!amountPattern.test(digits)) {
    return { kind: "rejected", error: "amount-format" };
  }
  const rubles = Number(digits);
  if (rubles < 1 || rubles > amountLimit) {
    return { kind: "rejected", error: "amount-range" };
  }
  return { kind: "ok", amount: { minorUnits: rubles * 100, currency } };
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
const meetupCancelled: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "meetup-cancelled",
};

// Отказы, общие у чтения и четырёх команд.
function commonRefusal(
  answer:
    | { kind: "not-administrator" }
    | { kind: "meetup-not-found" }
    | { kind: "meetup-cancelled" }
    | { kind: "auction-not-found" }
    | AuctionFailure,
): ExecuteResult {
  switch (answer.kind) {
    case "not-administrator":
    case "meetup-not-found":
      return notAdministrator;
    case "meetup-cancelled":
      return meetupCancelled;
    case "auction-not-found":
      return auctionNotFound;
    default:
      return failed(answer);
  }
}

// Лот на экранах периодов: обычная стартовая — текущая цена лота без ставок,
// обычный шаг — шаг при текущей цене, а до торгов — шаг одной политики.
export function happyHourLotOf(lot: LotView): HappyHourLot {
  const { status } = lot;
  const regularStep = lot.baseStep ?? lot.fixedStep;
  const hasBids =
    (status.kind === "trading" || status.kind === "held") &&
    status.leaderId !== undefined;
  return {
    lotId: lot.lotId,
    auctionId: lot.auctionId,
    ...(lot.card === undefined ? {} : { title: lot.card.title }),
    ...(status.kind === "trading" && status.leaderId === undefined
      ? { regularStart: status.currentPrice }
      : {}),
    ...(regularStep === undefined ? {} : { regularStep }),
    hasBids,
  };
}

/** Условия лота в периоде; нет — лот в периоде торгуется как обычно. */
export function lotTermsIn(
  period: HappyHourPeriod,
  lotId: string,
): HappyHourLotTerms | undefined {
  return period.lotTerms.find((terms) => terms.lotId === lotId);
}

export function createHappyHours(
  consoles: Pick<
    AuctionConsoles,
    | "getAuctionConsole"
    | "createHappyHourPeriod"
    | "deleteHappyHourPeriod"
    | "setHappyHourLotTerms"
    | "clearHappyHourLotTerms"
  >,
  lots: Pick<LotAdministration, "getLot">,
  timeZone: string,
  // Часы бота: по ним решается, начался ли период. Тест их подменяет.
  now: () => Date = () => new Date(),
) {
  type Read =
    | { kind: "ok"; console: AuctionConsoleSnapshot }
    | { kind: "refused"; result: ExecuteResult };

  async function read(
    request: HappyHoursRequest,
    auctionId: string,
  ): Promise<Read> {
    const found = await consoles.getAuctionConsole(
      request.identity,
      auctionId,
      rpcMeta(request),
    );
    return found.kind === "ok"
      ? { kind: "ok", console: found.console }
      : { kind: "refused", result: commonRefusal(found) };
  }

  // Период по кнопке: номер и отпечаток. Период удалили или сдвинули — кнопка
  // устарела, и экран говорит об этом, а не правит чужой период.
  function periodAt(
    console: AuctionConsoleSnapshot,
    ref: WindowRef,
  ): HappyHourPeriod | undefined {
    const period = console.happyHourPeriods[ref.index];
    return period !== undefined && periodPrint(period) === ref.print
      ? period
      : undefined;
  }

  type LotRead =
    | { kind: "ok"; lot: HappyHourLot; console: AuctionConsoleSnapshot }
    | { kind: "refused"; result: ExecuteResult };

  // Лот читается сам — по нему пульт узнаёт аукцион, — а затем пульт: периоды
  // и условия в нём.
  async function readLot(
    request: Extract<HappyHoursRequest, { lotId: string }>,
  ): Promise<LotRead> {
    const found = await lots.getLot(
      request.identity,
      request.lotId,
      rpcMeta(request),
    );
    if (found.kind === "not-found") {
      return {
        kind: "refused",
        result: {
          kind: "lot-refused",
          reason: "lot-not-found",
          lotId: request.lotId,
        },
      };
    }
    if (found.kind !== "ok") {
      return { kind: "refused", result: failed(found) };
    }
    const console = await read(request, found.lot.auctionId);
    if (console.kind === "refused") return console;
    return {
      kind: "ok",
      lot: happyHourLotOf(found.lot),
      console: console.console,
    };
  }

  function periodsOf(console: AuctionConsoleSnapshot): ExecuteResult {
    return {
      kind: "happy-hour-periods",
      auctionId: console.auctionId,
      periods: console.happyHourPeriods,
      lots: console.lots.length,
      now: now().toISOString(),
    };
  }

  function outcome(
    auctionId: string,
    note: Extract<ExecuteResult, { kind: "happy-hour-outcome" }>["note"],
  ): ExecuteResult {
    return { kind: "happy-hour-outcome", auctionId, note };
  }

  async function createPeriod(
    request: Extract<HappyHoursRequest, { intent: "create-happy-hour-period" }>,
  ): Promise<ExecuteResult> {
    const found = await read(request, request.auctionId);
    if (found.kind === "refused") return found.result;
    const week = found.console.week;
    const asked = (error: PeriodAskError): ExecuteResult => ({
      kind: "happy-hour-period-ask",
      auctionId: request.auctionId,
      ...(week === undefined ? {} : { week }),
      error,
    });
    if (found.console.status !== "prebidding") {
      return outcome(request.auctionId, { kind: "closed" });
    }
    if (
      openCount(found.console.happyHourPeriods, now().toISOString()) >=
      periodLimit
    ) {
      return outcome(request.auctionId, { kind: "limit" });
    }
    // Сроки периода — в формате сроков недели: начало и конец через тире.
    const parsed = parseWeek(request.value, timeZone, now());
    if (parsed.kind === "rejected") {
      switch (parsed.error) {
        case "week-format":
          return asked("period-format");
        case "week-moment":
          return asked("period-moment");
        case "week-order":
          return asked("period-order");
        case "week-ended":
          return asked("period-in-past");
        default:
          return asked("period-format");
      }
    }
    const answer = await consoles.createHappyHourPeriod(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        from: parsed.opensAt,
        until: parsed.closesAt,
      },
      rpcMeta(request),
    );
    switch (answer.kind) {
      case "ok":
        return outcome(request.auctionId, {
          kind: "created",
          from: answer.period.from,
          until: answer.period.until,
        });
      case "period-in-past":
        return asked("period-in-past");
      case "period-empty":
        return asked("period-order");
      case "period-outside-phase":
        return asked("period-outside-week");
      case "not-in-prebidding":
        return outcome(request.auctionId, { kind: "closed" });
      default:
        return commonRefusal(answer);
    }
  }

  async function deletePeriod(
    request: Extract<HappyHoursRequest, { intent: "delete-happy-hour-period" }>,
  ): Promise<ExecuteResult> {
    const found = await read(request, request.auctionId);
    if (found.kind === "refused") return found.result;
    const period = periodAt(found.console, request.period);
    if (period === undefined) {
      return outcome(request.auctionId, { kind: "changed" });
    }
    const number = request.period.index + 1;
    const answer = await consoles.deleteHappyHourPeriod(
      request.identity,
      {
        auctionId: request.auctionId,
        opId: request.opId,
        periodId: period.periodId,
      },
      rpcMeta(request),
    );
    switch (answer.kind) {
      case "ok":
        return outcome(request.auctionId, { kind: "removed", period: number });
      // Повтор после принятого удаления застаёт период удалённым.
      case "period-not-found":
        return outcome(request.auctionId, { kind: "removed", period: number });
      case "period-started":
        return outcome(request.auctionId, { kind: "started", period: number });
      case "not-in-prebidding":
        return outcome(request.auctionId, { kind: "closed" });
      default:
        return commonRefusal(answer);
    }
  }

  async function setTerms(
    request: Extract<HappyHoursRequest, { intent: "set-lot-happy-hour" }>,
  ): Promise<ExecuteResult> {
    const found = await readLot(request);
    if (found.kind === "refused") return found.result;
    const { lot, console } = found;
    const period = periodAt(console, request.period);
    if (period === undefined) {
      return { kind: "lot-happy-hour-outcome", lot, note: { kind: "changed" } };
    }
    const back = { index: request.period.index, period };
    const number = request.period.index + 1;
    if (periodStarted(period, now().toISOString())) {
      return {
        kind: "lot-happy-hour-outcome",
        lot,
        back,
        note: { kind: "started", period: number },
      };
    }
    // Отказ о сумме спрашивает то поле, о котором он: команда везёт и
    // прежнее значение другого поля, и отказ может быть о нём.
    const asked = (
      error: HappyHourAmountError,
      regular?: LotAmount,
      field: HappyHourField = request.field,
    ): ExecuteResult => ({
      kind: "lot-happy-hour-ask",
      lot,
      index: request.period.index,
      period,
      field,
      error,
      ...(regular === undefined ? {} : { regular }),
    });
    const currency =
      lot.regularStart?.currency ?? lot.regularStep?.currency ?? "RUB";
    const parsed = parseHappyHourAmount(request.value, currency);
    if (parsed.kind === "rejected") return asked(parsed.error);
    const before = lotTermsIn(period, lot.lotId);
    const field = request.field;
    const merged = {
      ...(field === "step"
        ? parsed.amount === undefined
          ? {}
          : { step: parsed.amount }
        : before?.step === undefined
          ? {}
          : { step: before.step }),
      ...(field === "start"
        ? parsed.amount === undefined
          ? {}
          : { start: parsed.amount }
        : before?.start === undefined
          ? {}
          : { start: before.start }),
    };
    // Ниже обычного — правило Auction; край проверяет то, что знает сам, чтобы
    // ответ сразу спросил заново.
    const regular = field === "step" ? lot.regularStep : lot.regularStart;
    if (
      parsed.amount !== undefined &&
      regular !== undefined &&
      parsed.amount.minorUnits >= regular.minorUnits
    ) {
      return asked(field === "step" ? "step-not-lower" : "start-not-lower");
    }
    const target = {
      auctionId: lot.auctionId,
      periodId: period.periodId,
      lotId: lot.lotId,
      opId: request.opId,
    };
    // Оба параметра «как обычно» — условий у лота в периоде нет.
    if (merged.step === undefined && merged.start === undefined) {
      return clearTerms(request, lot, back, target);
    }
    const answer = await consoles.setHappyHourLotTerms(
      request.identity,
      { ...target, ...merged },
      rpcMeta(request),
    );
    switch (answer.kind) {
      case "ok":
        return {
          kind: "lot-happy-hour-outcome",
          lot,
          back,
          note: { kind: "saved", period: number, terms: answer.terms },
        };
      case "step-not-lower":
        return asked("step-not-lower", answer.regularStep, "step");
      case "start-not-lower":
        return asked("start-not-lower", answer.regularStart, "start");
      case "amount-invalid":
      case "terms-empty":
        return asked("amount-invalid");
      default:
        return termsRefused(answer, lot, back);
    }
  }

  function termsRefused(
    answer:
      | { kind: "period-not-found" }
      | { kind: "period-started" }
      | { kind: "lot-not-in-auction" }
      | { kind: "lot-not-open" }
      | { kind: "not-in-prebidding" }
      | { kind: "windows-overlap"; from: string; until: string }
      | { kind: "not-administrator" }
      | { kind: "meetup-not-found" }
      | { kind: "meetup-cancelled" }
      | { kind: "auction-not-found" }
      | AuctionFailure,
    lot: HappyHourLot,
    back: { index: number; period: HappyHourPeriod },
  ): ExecuteResult {
    const refused = (
      note: Extract<ExecuteResult, { kind: "lot-happy-hour-outcome" }>["note"],
      withBack = true,
    ): ExecuteResult => ({
      kind: "lot-happy-hour-outcome",
      lot,
      ...(withBack ? { back } : {}),
      note,
    });
    switch (answer.kind) {
      case "period-not-found":
        return refused({ kind: "changed" }, false);
      case "period-started":
        return refused({ kind: "started", period: back.index + 1 });
      case "lot-not-in-auction":
      case "lot-not-open":
        return refused({ kind: "lot-not-open" });
      case "not-in-prebidding":
        return refused({ kind: "closed" });
      case "windows-overlap":
        return refused({
          kind: "overlap",
          from: answer.from,
          until: answer.until,
        });
      default:
        return commonRefusal(answer);
    }
  }

  async function clearTerms(
    request: HappyHoursRequest,
    lot: HappyHourLot,
    back: { index: number; period: HappyHourPeriod },
    target: {
      auctionId: string;
      periodId: string;
      lotId: string;
      opId: string;
    },
  ): Promise<ExecuteResult> {
    const answer = await consoles.clearHappyHourLotTerms(
      request.identity,
      target,
      rpcMeta(request),
    );
    return answer.kind === "ok"
      ? {
          kind: "lot-happy-hour-outcome",
          lot,
          back,
          note: { kind: "cleared", period: back.index + 1 },
        }
      : termsRefused(answer, lot, back);
  }

  return async (request: HappyHoursRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-happy-hour-periods": {
        const found = await read(request, request.auctionId);
        return found.kind === "refused"
          ? found.result
          : periodsOf(found.console);
      }
      case "ask-happy-hour-period": {
        const found = await read(request, request.auctionId);
        if (found.kind === "refused") return found.result;
        if (found.console.status !== "prebidding") {
          return outcome(request.auctionId, { kind: "closed" });
        }
        if (
          openCount(found.console.happyHourPeriods, now().toISOString()) >=
          periodLimit
        ) {
          return outcome(request.auctionId, { kind: "limit" });
        }
        const week = found.console.week;
        return {
          kind: "happy-hour-period-ask",
          auctionId: request.auctionId,
          ...(week === undefined ? {} : { week }),
        };
      }
      case "create-happy-hour-period":
        return createPeriod(request);
      case "view-happy-hour-period":
      case "prepare-happy-hour-period-delete": {
        const found = await read(request, request.auctionId);
        if (found.kind === "refused") return found.result;
        const period = periodAt(found.console, request.period);
        if (period === undefined) {
          return outcome(request.auctionId, { kind: "changed" });
        }
        if (request.intent === "prepare-happy-hour-period-delete") {
          return periodStarted(period, now().toISOString())
            ? outcome(request.auctionId, {
                kind: "started",
                period: request.period.index + 1,
              })
            : {
                kind: "happy-hour-period-remove-confirm",
                auctionId: request.auctionId,
                index: request.period.index,
                period,
              };
        }
        const titles: Record<string, string> = {};
        for (const each of found.console.lots) {
          if (each.lot.card !== undefined) {
            titles[each.lot.lotId] = each.lot.card.title;
          }
        }
        return {
          kind: "happy-hour-period",
          auctionId: request.auctionId,
          index: request.period.index,
          period,
          titles,
          now: now().toISOString(),
        };
      }
      case "delete-happy-hour-period":
        return deletePeriod(request);
      case "view-lot-happy-hours": {
        const found = await readLot(request);
        if (found.kind === "refused") return found.result;
        return {
          kind: "lot-happy-hours",
          lot: found.lot,
          periods: found.console.happyHourPeriods,
          now: now().toISOString(),
        };
      }
      case "view-lot-happy-hour":
      case "ask-lot-happy-hour": {
        const found = await readLot(request);
        if (found.kind === "refused") return found.result;
        const { lot } = found;
        const period = periodAt(found.console, request.period);
        if (period === undefined) {
          return {
            kind: "lot-happy-hour-outcome",
            lot,
            note: { kind: "changed" },
          };
        }
        if (request.intent === "view-lot-happy-hour") {
          return {
            kind: "lot-happy-hour",
            lot,
            index: request.period.index,
            period,
            now: now().toISOString(),
          };
        }
        if (periodStarted(period, now().toISOString())) {
          return {
            kind: "lot-happy-hour-outcome",
            lot,
            back: { index: request.period.index, period },
            note: { kind: "started", period: request.period.index + 1 },
          };
        }
        return {
          kind: "lot-happy-hour-ask",
          lot,
          index: request.period.index,
          period,
          field: request.field,
        };
      }
      case "set-lot-happy-hour":
        return setTerms(request);
      case "clear-lot-happy-hour": {
        const found = await readLot(request);
        if (found.kind === "refused") return found.result;
        const { lot } = found;
        const period = periodAt(found.console, request.period);
        if (period === undefined) {
          return {
            kind: "lot-happy-hour-outcome",
            lot,
            note: { kind: "changed" },
          };
        }
        const back = { index: request.period.index, period };
        if (periodStarted(period, now().toISOString())) {
          return {
            kind: "lot-happy-hour-outcome",
            lot,
            back,
            note: { kind: "started", period: request.period.index + 1 },
          };
        }
        return clearTerms(request, lot, back, {
          auctionId: lot.auctionId,
          periodId: period.periodId,
          lotId: lot.lotId,
          opId: request.opId,
        });
      }
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
