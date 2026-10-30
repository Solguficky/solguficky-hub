import { InlineKeyboard } from "grammy";
import {
  lotTermsIn,
  periodLimit,
  periodOpen,
  periodRef,
  periodStarted,
} from "../../application/happy-hours.js";
import { formatLocalMoment } from "../../application/meetup-form.js";
import type {
  AuctionWeek,
  HappyHourAmountError,
  HappyHourField,
  HappyHourLot,
  HappyHourLotTerms,
  HappyHourNote,
  HappyHourPeriod,
  LotAmount,
  PeriodAskError,
} from "../../application/types.js";
import {
  type CommunityDay,
  communityLocalTime,
  communityShownTime,
} from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consolePeriodAskData,
  consolePeriodData,
  consolePeriodRemoveConfirmData,
  consolePeriodRemoveData,
  consolePeriodsData,
  consoleWindowsData,
  lotHappyHourAskData,
  lotHappyHourClearData,
  lotHappyHourData,
  lotHappyHoursData,
} from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  readableMoment,
  removeLabel,
  screenText,
  submenuText,
  withNav,
} from "./kit.js";
import { toLot } from "./lot-form.js";
import type { ShownScreen } from "./show.js";

// «Счастливые часы» периодами (PER-787; ADR-047, дополнение 2026-10-27).
// Пульт: «Счастливые часы» → «Периоды» — список периодов со сроками, числом
// настроенных лотов и тем, начался ли период, «Создать период» и период с
// условиями лотов и удалением до начала. Карточка лота у держателя права
// вести аукцион: «🛠 Счастливые часы» → периоды с условиями этого лота →
// условия в периоде: стартовая и шаг ответом, снятие. С начала периода всё
// только для просмотра. Состояния нет: период кнопка называет номером и
// отпечатком, а экран читает пульт заново.

const untitled = "Лот без названия";
const lineTitleLimit = 60;

export const periodsTitle = "Периоды";
const lotHappyHoursTitle = "Счастливые часы";

type Moments = { timeZone: string; today: CommunityDay };

function moment(instant: string, view: Moments): string {
  return readableMoment(communityLocalTime(instant, view.timeZone), view.today);
}

function deadline(instant: string, view: Moments): string {
  return readableMoment(communityShownTime(instant, view.timeZone), view.today);
}

/** «с 28 октября, ср, 18:00 до 22:00»: день один раз, если он один. */
export function periodSpan(period: HappyHourPeriod, view: Moments): string {
  const from = communityLocalTime(period.from, view.timeZone);
  const until = communityShownTime(period.until, view.timeZone);
  const sameDay =
    from.year === until.year &&
    from.month === until.month &&
    from.day === until.day;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `с ${moment(period.from, view)} до ${
    sameDay
      ? `${pad(until.hours)}:${pad(until.minutes)}`
      : deadline(period.until, view)
  }`;
}

function stateOf(period: HappyHourPeriod, now: string): string {
  if (Date.parse(period.until) <= Date.parse(now)) return "прошёл";
  return periodStarted(period, now) ? "идёт" : "впереди";
}

/** Условия лота словами: «от 800 ₽, шаг 50 ₽». */
export function termsText(terms: HappyHourLotTerms): string {
  return [
    ...(terms.start === undefined ? [] : [`от ${money(terms.start)}`]),
    ...(terms.step === undefined ? [] : [`шаг ${money(terms.step)}`]),
  ].join(", ");
}

// Непрошедшие периоды с их номером в общем списке: кнопка называет его.
function openPeriods(
  periods: readonly HappyHourPeriod[],
  now: string,
): { period: HappyHourPeriod; index: number }[] {
  return periods
    .map((period, index) => ({ period, index }))
    .filter(({ period }) => periodOpen(period, now));
}

function toPeriods(auction: string): Parent {
  return { name: periodsTitle, data: consolePeriodsData(auction) };
}

/** «Периоды» — ряд экрана «Счастливые часы» в онлайн-торгах. */
export const periodsLabel = periodsTitle;

/**
 * Периоды: строками «1. с … до … · лотов: 3 · впереди», ряд «Период N» на
 * каждый, «Создать период», пока их меньше предела, и «‹ Счастливые часы».
 */
export function happyHourPeriodsScreen(
  view: {
    auctionId: string;
    periods: readonly HappyHourPeriod[];
    now: string;
  } & Moments,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const keyboard = new InlineKeyboard();
  const open = openPeriods(view.periods, view.now);
  for (const { period, index } of open.slice(0, periodLimit)) {
    nextRow(keyboard).text(
      `Период ${index + 1}`,
      consolePeriodData(auction, periodRef(period, index)),
    );
  }
  if (open.length < periodLimit) {
    nextRow(keyboard).text("Создать период", consolePeriodAskData(auction));
  }
  return {
    id: "happy-hour-periods",
    text: screenText(
      periodsTitle,
      escapeHtml(
        "В период у выбранных лотов свои условия: стартовая цена ниже обычной, пока у лота нет ставок, и шаг меньше обычного. Условия лота задаются с его карточки — «🛠 Счастливые часы». С начала периода его не изменить.",
      ),
      view.periods.length === 0
        ? "Периодов пока нет."
        : view.periods
            .map((period, index) =>
              escapeHtml(
                `${index + 1}. ${periodSpan(period, view)} · лотов: ${period.lotTerms.length} · ${stateOf(period, view.now)}`,
              ),
            )
            .join("\n"),
    ),
    keyboard: withNav(keyboard, {
      name: "Счастливые часы",
      data: consoleWindowsData(auction),
    }),
    format: "HTML",
  };
}

/**
 * Период: сроки, начался ли он, и условия каждого лота строкой. Удалить
 * можно только до начала.
 */
export function happyHourPeriodScreen(
  view: {
    auctionId: string;
    index: number;
    period: HappyHourPeriod;
    titles: Readonly<Record<string, string>>;
    now: string;
  } & Moments,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const { period } = view;
  const keyboard = new InlineKeyboard();
  const started = periodStarted(period, view.now);
  if (!started) {
    nextRow(keyboard).text(
      removeLabel("Удалить период"),
      consolePeriodRemoveData(auction, periodRef(period, view.index)),
    );
  }
  return {
    id: "happy-hour-period",
    text: screenText(
      `Период ${view.index + 1}`,
      escapeHtml(
        `${periodSpan(period, view)} · ${stateOf(period, view.now)}.${started ? " Период начался — условия не меняются." : ""}`,
      ),
      period.lotTerms.length === 0
        ? escapeHtml(
            "Лотов с условиями нет. Задай их с карточки лота — «🛠 Счастливые часы».",
          )
        : period.lotTerms
            .map((terms) =>
              escapeHtml(
                `• ${truncate(view.titles[terms.lotId] ?? untitled, lineTitleLimit)} — ${termsText(terms)}`,
              ),
            )
            .join("\n"),
    ),
    keyboard: withNav(keyboard, toPeriods(auction)),
    format: "HTML",
  };
}

/** Подтверждение удаления: условия лотов в периоде снимутся вместе с ним. */
export function happyHourPeriodRemoveScreen(
  view: { auctionId: string; index: number; period: HappyHourPeriod } & Moments,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const ref = periodRef(view.period, view.index);
  return {
    id: "happy-hour-period-remove-confirm",
    text: screenText(
      `Удалить период ${view.index + 1}?`,
      escapeHtml(
        `${periodSpan(view.period, view)}. Условия лотов в нём (${view.period.lotTerms.length}) снимутся вместе с ним.`,
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, удалить",
      yesData: consolePeriodRemoveConfirmData(auction, ref),
      noData: consolePeriodData(auction, ref),
      irreversible: true,
    }),
    format: "HTML",
  };
}

function weekSpan(timeZone: string, week?: AuctionWeek): string | undefined {
  const local = (instant: string) =>
    formatLocalMoment(communityLocalTime(instant, timeZone));
  return week?.opensAt === undefined || week.closesAt === undefined
    ? undefined
    : `${local(week.opensAt)} — ${local(week.closesAt)}`;
}

export const periodPrompt =
  "Период по времени сообщества: начало и конец через тире. Период — внутри недели и ещё не начался.\nНапример: 28.10.2026 18:00 — 28.10.2026 22:00";

/** Вопрос о сроках нового периода называет сроки недели. */
export function periodQuestionText(
  timeZone: string,
  week?: AuctionWeek,
): string {
  const span = weekSpan(timeZone, week);
  return [
    ...(span === undefined ? [] : [`Неделя: ${span}`]),
    periodPrompt,
  ].join("\n");
}

/** Причина отказа ответу о сроках периода: заголовок экрана исхода. */
export function periodAskErrorText(
  error: PeriodAskError,
  context: { timeZone: string; week?: AuctionWeek | undefined },
): string {
  switch (error) {
    case "period-format":
      return "Не получилось разобрать период. Нужны начало и конец: ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ.";
    case "period-moment":
      return "Такого момента нет в календаре. Проверь дату и время.";
    case "period-order":
      return "Конец периода должен быть позже начала.";
    case "period-in-past":
      return "Начало периода уже прошло. Период задаётся до своего начала.";
    case "period-outside-week": {
      const span = weekSpan(context.timeZone, context.week);
      return span === undefined
        ? "Период должен лежать внутри онлайн-недели."
        : `Период должен лежать внутри онлайн-недели: ${span}.`;
    }
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

function noteText(note: HappyHourNote, view: Moments): string {
  switch (note.kind) {
    case "created":
      return `Период создан: ${periodSpan({ periodId: "", from: note.from, until: note.until, lotTerms: [] }, view)}. Условия лотов задай с карточки лота — «🛠 Счастливые часы».`;
    case "removed":
      return `Период ${note.period} удалён. Условия лотов в нём сняты.`;
    case "saved":
      return `Условия сохранены: ${termsText(note.terms)}. Они действуют с начала периода ${note.period}.`;
    case "cleared":
      return `Условия сняты. В периоде ${note.period} лот торгуется как обычно.`;
    case "changed":
      return "Периоды изменились, пока был открыт экран. Проверь заново.";
    case "limit":
      return `Впереди уже ${periodLimit} периодов. Удали лишний, чтобы создать новый.`;
    case "started":
      return `Период ${note.period} уже начался. С начала период не меняется.`;
    case "closed":
      return "Периоды задаются только во время онлайн-торгов.";
    case "lot-not-open":
      return "Лот сейчас не торгуется онлайн. Условия задаются лоту в онлайн-торгах.";
    case "overlap":
      return `Период пересекается с другим окном этого лота: ${periodSpan({ periodId: "", from: note.from, until: note.until, lotTerms: [] }, view)}. Сними лот с того окна или выбери другой период.`;
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

/** Исход команды над периодами — свой экран с возвратом к «Периодам». */
export function happyHourOutcomeScreen(
  view: { auctionId: string; note: HappyHourNote } & Moments,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(noteText(view.note, view)),
    keyboard: withNav(
      new InlineKeyboard(),
      toPeriods(uuidToToken(view.auctionId)),
    ),
    format: "HTML",
  };
}

function lotTitle(lot: HappyHourLot): string {
  return truncate(lot.title ?? untitled, lineTitleLimit);
}

function toLotHappyHours(lot: HappyHourLot): Parent {
  return {
    name: lotHappyHoursTitle,
    data: lotHappyHoursData(uuidToToken(lot.lotId)),
  };
}

/** Обычные условия лота строкой: «Обычно: старт 1 600 ₽, шаг 100 ₽». */
function regularLine(lot: HappyHourLot): string | undefined {
  const parts = [
    ...(lot.regularStart === undefined
      ? []
      : [`старт ${money(lot.regularStart)}`]),
    ...(lot.regularStep === undefined ? [] : [`шаг ${money(lot.regularStep)}`]),
  ];
  return parts.length === 0 ? undefined : `Обычно: ${parts.join(", ")}.`;
}

/**
 * Периоды лота: строкой на период — сроки и условия лота или «как обычно», —
 * ряд «Период N» на каждый и возврат к карточке.
 */
export function lotHappyHoursScreen(
  view: {
    lot: HappyHourLot;
    periods: readonly HappyHourPeriod[];
    now: string;
  } & Moments,
): ShownScreen {
  const { lot } = view;
  const token = uuidToToken(lot.lotId);
  const keyboard = new InlineKeyboard();
  for (const { period, index } of openPeriods(view.periods, view.now).slice(
    0,
    periodLimit,
  )) {
    nextRow(keyboard).text(
      `Период ${index + 1}`,
      lotHappyHourData(token, periodRef(period, index)),
    );
  }
  const regular = regularLine(lot);
  return {
    id: "lot-happy-hours",
    text: submenuText(
      lotHappyHoursTitle,
      lotTitle(lot),
      regular === undefined ? undefined : escapeHtml(regular),
      view.periods.length === 0
        ? escapeHtml(
            "Периодов пока нет. Создай их в пульте: «Счастливые часы» → «Периоды».",
          )
        : view.periods
            .map((period, index) => {
              const terms = lotTermsIn(period, lot.lotId);
              return escapeHtml(
                `${index + 1}. ${periodSpan(period, view)} — ${terms === undefined ? "как обычно" : termsText(terms)} · ${stateOf(period, view.now)}`,
              );
            })
            .join("\n"),
    ),
    keyboard: withNav(keyboard, toLot(lot.lotId)),
    format: "HTML",
  };
}

function valueLine(
  label: string,
  value: LotAmount | undefined,
  regular: LotAmount | undefined,
): string {
  const usual = regular === undefined ? "" : ` (обычно ${money(regular)})`;
  return value === undefined
    ? `${label}: как обычно${usual}`
    : `${label}: ${money(value)}${usual}`;
}

/**
 * Условия лота в периоде: стартовая и шаг с обычными рядом. У лота со
 * ставками стартовая уже не действует — экран так и говорит. До начала —
 * «Стартовая цена» и «Шаг» вопросом и «🗑 Убрать условия», если они есть.
 */
export function lotHappyHourScreen(
  view: {
    lot: HappyHourLot;
    index: number;
    period: HappyHourPeriod;
    now: string;
  } & Moments,
): ShownScreen {
  const { lot, period } = view;
  const token = uuidToToken(lot.lotId);
  const ref = periodRef(period, view.index);
  const terms = lotTermsIn(period, lot.lotId);
  const started = periodStarted(period, view.now);
  const keyboard = new InlineKeyboard();
  if (!started) {
    nextRow(keyboard).text(
      "Стартовая цена",
      lotHappyHourAskData(token, ref, "start"),
    );
    nextRow(keyboard).text("Шаг", lotHappyHourAskData(token, ref, "step"));
    if (terms !== undefined) {
      nextRow(keyboard).text(
        removeLabel("Убрать условия"),
        lotHappyHourClearData(token, ref),
      );
    }
  }
  return {
    id: "lot-happy-hour",
    text: submenuText(
      `Период ${view.index + 1}`,
      lotTitle(lot),
      escapeHtml(
        `${periodSpan(period, view)} · ${stateOf(period, view.now)}.${started ? " Период начался — условия не меняются." : ""}`,
      ),
      [
        escapeHtml(valueLine("Стартовая", terms?.start, lot.regularStart)),
        ...(terms?.start !== undefined && lot.hasBids
          ? [
              escapeHtml(
                "Стартовая не действует: у лота уже есть ставки, и цену ведёт шаг.",
              ),
            ]
          : []),
        escapeHtml(valueLine("Шаг", terms?.step, lot.regularStep)),
      ].join("\n"),
    ),
    keyboard: withNav(keyboard, toLotHappyHours(lot)),
    format: "HTML",
  };
}

const fieldNames: Readonly<Record<HappyHourField, string>> = {
  start: "Стартовая цена",
  step: "Шаг",
};

/**
 * Вопрос о стартовой или шаге: что спрошено, в каком периоде, обычное
 * значение и вид ответа.
 */
export function lotHappyHourQuestionText(
  view: {
    lot: HappyHourLot;
    index: number;
    period: HappyHourPeriod;
    field: HappyHourField;
  } & Moments,
): string {
  const regular =
    view.field === "start" ? view.lot.regularStart : view.lot.regularStep;
  const current = lotTermsIn(view.period, view.lot.lotId)?.[view.field];
  return [
    `${fieldNames[view.field]} лота «${lotTitle(view.lot)}» в периоде ${view.index + 1} (${periodSpan(view.period, view)}).`,
    ...(regular === undefined ? [] : [`Обычно: ${money(regular)}.`]),
    ...(current === undefined ? [] : [`Сейчас в периоде: ${money(current)}.`]),
    view.field === "start"
      ? "Ответь суммой в целых рублях — ниже обычной стартовой. Она действует, пока у лота нет ставок. «-» — как обычно."
      : "Ответь шагом в целых рублях — меньше обычного. «-» — как обычно.",
  ].join("\n");
}

/** Причина отказа ответу о сумме: заголовок экрана исхода. */
export function happyHourAmountErrorText(
  error: HappyHourAmountError,
  regular: LotAmount | undefined,
): string {
  switch (error) {
    case "amount-format":
      return "Нужна сумма в целых рублях: только цифры, без копеек. «-» — как обычно.";
    case "amount-range":
      return "Сумма — от 1 до 9 999 999 рублей.";
    case "start-not-lower":
      return regular === undefined
        ? "Стартовая в периоде должна быть ниже обычной."
        : `Стартовая в периоде должна быть ниже обычной — ${money(regular)}.`;
    case "step-not-lower":
      return regular === undefined
        ? "Шаг в периоде должен быть меньше обычного."
        : `Шаг в периоде должен быть меньше обычного — ${money(regular)}.`;
    case "amount-invalid":
      return "Сумма не принята: она должна быть больше нуля и в валюте лота.";
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

/**
 * Исход команды над условиями лота — свой экран с возвратом в период лота
 * или, если периода больше нет, к периодам лота.
 */
export function lotHappyHourOutcomeScreen(
  view: {
    lot: HappyHourLot;
    back?: { index: number; period: HappyHourPeriod };
    note: HappyHourNote;
  } & Moments,
): ShownScreen {
  const { lot, back } = view;
  const parent: Parent =
    back === undefined
      ? toLotHappyHours(lot)
      : {
          name: buttonText(`Период ${back.index + 1}`),
          data: lotHappyHourData(
            uuidToToken(lot.lotId),
            periodRef(back.period, back.index),
          ),
        };
  return {
    id: "outcome",
    text: outcomeText(noteText(view.note, view), lotTitle(lot)),
    keyboard: withNav(new InlineKeyboard(), parent),
    format: "HTML",
  };
}

/** «🛠 Счастливые часы» карточки лота. */
export function lotHappyHoursEntry(lotId: string): Parent {
  return {
    name: lotHappyHoursTitle,
    data: lotHappyHoursData(uuidToToken(lotId)),
  };
}
