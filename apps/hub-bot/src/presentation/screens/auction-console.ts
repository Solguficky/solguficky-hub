import type { LotStatusView } from "@solguficky/auction-bot-ui";
import { InlineKeyboard } from "grammy";
import { formatLocalMoment } from "../../application/meetup-form.js";
import type {
  AuctionConsoleView,
  AuctionWeek,
  ConsoleLot,
  ConsoleNote,
  WeekAskError,
} from "../../application/types.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleConfirmData,
  consoleFinalData,
  consoleMarkData,
  consoleOpenData,
  consoleViewData,
  consoleWeekData,
} from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  pagedTitle,
  paginate,
  readableMoment,
  screenText,
  toggleLabel,
  withNav,
  withPager,
} from "./kit.js";
import { toLots } from "./lot-form.js";
import type { ShownScreen } from "./show.js";

// Пульт аукциона администратора в боте хаба (PER-320). Экран хаба, а не тело
// пакета, как форма лота: у бота аукциона пульта нет. Пульт показывает, где
// аукцион, сроки недели и финал, лоты с ценой и числом ставок, отметку «в
// финал» и отдельной строкой лоты, которые торгуются дольше дедлайна.
// Состояния у пульта нет: всё, что нужно следующему шагу, едет в кнопке.

const untitled = "Лот без названия";
const titleLimit = 120;

export type ConsoleScreenView = {
  console: AuctionConsoleView;
  note?: ConsoleNote;
  page: number;
  timeZone: string;
  today: CommunityDay;
};

export const consoleNoteText: Record<ConsoleNote, string> = {
  "week-saved": "Сроки недели сохранены.",
  "week-opened": "Онлайн-неделя открыта: лоты принимают ставки.",
  "week-already-open": "Неделя уже открыта.",
  "week-not-scheduled":
    "Сначала задай сроки недели: без них неделю не открыть.",
  "week-frozen": "Онлайн-неделя уже открыта: сроки и финал больше не меняются.",
  "week-needed": "Сначала задай сроки недели.",
  marked: "Лот отмечен для финала.",
  unmarked: "Отметка финала снята.",
  "already-marked": "Лот уже отмечен для финала.",
  "not-marked": "Отметки финала у лота уже нет.",
  "deadline-passed": "Дедлайн лота прошёл: отметку финала уже не изменить.",
  "not-in-prebidding":
    "Онлайн-торги не идут: отмечать лоты для финала можно только во время недели.",
  "lot-not-open": "Торги по лоту не идут: отметить его для финала нельзя.",
  "not-in-online-phase": "Лот уже в живом финале.",
  "lot-not-in-auction": "Лота нет в этом аукционе.",
  "selection-not-applicable": "У недели нет финала: отбирать лоты некуда.",
  "week-ended": "Конец недели уже прошёл: задай новые сроки.",
  "no-lots-to-open": "Нет лотов с ценой и шагом: открывать нечего.",
};

/** Всплывающий текст принятого переключателя финала (кадр P-08). */
export function finalToast(final: boolean): string {
  return final ? "Включено: финал." : "Выключено: финал.";
}

function moment(instant: string, view: ConsoleScreenView): string {
  return readableMoment(communityLocalTime(instant, view.timeZone), view.today);
}

function finalLine(week: AuctionWeek): string {
  return week.final ? "Финал: есть." : "Финал: нет.";
}

function weekLine(week: AuctionWeek, view: ConsoleScreenView): string {
  if (week.opensAt === undefined || week.closesAt === undefined) {
    return "Сроки недели заданы не полностью.";
  }
  return `Онлайн-неделя: с ${moment(week.opensAt, view)} до ${moment(week.closesAt, view)}.`;
}

function statusLines(view: ConsoleScreenView): string[] {
  const { status, week } = view.console;
  switch (status) {
    case "draft":
      return ["Сроки недели не заданы."];
    case "scheduled":
      return week === undefined
        ? ["Сроки недели не заданы."]
        : [weekLine(week, view), finalLine(week)];
    case "prebidding":
      return [
        week?.closesAt === undefined
          ? "Идут онлайн-торги."
          : `Идут онлайн-торги до ${moment(week.closesAt, view)}.`,
        ...(week === undefined ? [] : [finalLine(week)]),
      ];
    case "settling":
      return ["Общий дедлайн прошёл: аукцион ждёт закрытия лотов."];
    case "break":
      return ["Онлайн-торги закончились: перерыв перед финалом."];
    case "lineup-frozen":
      return ["Состав финала объявлен."];
    case "final":
      return ["Идёт финал."];
    case "finished":
      return ["Аукцион завершён."];
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function priceLabel(status: LotStatusView): string {
  switch (status.kind) {
    case "trading":
    case "held":
      return money(status.currentPrice);
    case "scheduled":
      return `старт ${money(status.startingPrice)}`;
    case "sold":
      return `продан за ${money(status.price)}`;
    case "unsold":
      return "не продан";
    case "withdrawn":
      return "снят";
    case "draft":
      return "без цены";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** «нет ставок», «1 ставка», «3 ставки», «12 ставок». */
export function bidsLabel(count: number): string {
  return count === 0
    ? "нет ставок"
    : counted(count, ["ставка", "ставки", "ставок"]);
}

/** «1 лот», «3 лота», «12 лотов». */
function lotsLabel(count: number): string {
  return counted(count, ["лот", "лота", "лотов"]);
}

function counted(
  count: number,
  [one, few, many]: readonly [string, string, string],
): string {
  const tens = count % 100;
  const ones = count % 10;
  const word =
    tens >= 11 && tens <= 14
      ? many
      : ones === 1
        ? one
        : ones >= 2 && ones <= 4
          ? few
          : many;
  return `${count} ${word}`;
}

function titleOf(entry: ConsoleLot): string {
  return truncate(entry.lot.card?.title ?? untitled, titleLimit);
}

function lotLine(entry: ConsoleLot): string {
  return [
    `• ${titleOf(entry)} — ${priceLabel(entry.lot.status)}`,
    bidsLabel(entry.bidCount),
    ...(entry.markedForFinal ? ["в финал"] : []),
  ].join(" · ");
}

// Отметку финала можно ставить, пока лот торгуется онлайн; остальное
// решает Auction и отвечает отказом, который пульт покажет строкой.
function markable(entry: ConsoleLot): boolean {
  return (
    entry.lot.status.kind === "trading" && entry.lot.status.phase === "online"
  );
}

export function consoleScreen(view: ConsoleScreenView): ShownScreen {
  const { console } = view;
  const auction = uuidToToken(console.auctionId);
  // Реестр Auction отдаёт без порядка; пульт держит порядок заведения —
  // идентификатор лота UUIDv7.
  const lots = [...console.lots].sort((a, b) =>
    a.lot.lotId.localeCompare(b.lot.lotId),
  );
  const page = paginate(lots, view.page);
  const keyboard = new InlineKeyboard();
  const editable = console.status === "draft" || console.status === "scheduled";
  if (editable) {
    keyboard.text("Сроки недели", consoleWeekData(auction));
  }
  const week = console.week;
  if (
    console.status === "scheduled" &&
    week?.opensAt !== undefined &&
    week.closesAt !== undefined
  ) {
    nextRow(keyboard).text(
      toggleLabel("Финал", week.final),
      consoleFinalData(auction, !week.final),
    );
    nextRow(keyboard).text("Открыть онлайн-неделю", consoleOpenData(auction));
  }
  if (console.status === "prebidding") {
    // Без финала отбирать некуда: «В финал» не ставится, а снять прежнюю
    // отметку можно и после того, как финал выключили.
    const final = week?.final !== false;
    for (const entry of page.items.filter(markable)) {
      const selected = !entry.markedForFinal;
      if (selected && !final) continue;
      nextRow(keyboard).text(
        buttonText(
          `${selected ? "В финал" : "Снять из финала"} · ${titleOf(entry)}`,
        ),
        consoleMarkData({
          auction,
          lot: uuidToToken(entry.lot.lotId),
          selected,
          page: page.page,
        }),
      );
    }
  }
  withPager(keyboard, page, (target) => consoleViewData(auction, target));
  const overdue = lots.filter((entry) => entry.overdue);
  return {
    id: "auction-console",
    text: screenText(
      pagedTitle("Пульт", page),
      view.note === undefined
        ? undefined
        : escapeHtml(consoleNoteText[view.note]),
      statusLines(view).map(escapeHtml).join("\n"),
      lots.length === 0
        ? "Лотов пока нет."
        : page.items.map((entry) => escapeHtml(lotLine(entry))).join("\n"),
      overdue.length === 0
        ? undefined
        : escapeHtml(
            `Просрочены, не закрыты: ${overdue.map(titleOf).join(", ")}.`,
          ),
    ),
    keyboard: withNav(keyboard, toLots(console.auctionId)),
    format: "HTML",
  };
}

/**
 * Подтверждение открытия онлайн-недели. Ключ команды рождён здесь и едет в
 * «Да»: повторное нажатие той же кнопки Auction примет как повтор, и второй
 * раз неделя не откроется.
 */
export function weekConfirmScreen(confirm: {
  console: AuctionConsoleView;
  opId: string;
  opening: number;
  idle: number;
  timeZone: string;
  today: CommunityDay;
}): ShownScreen {
  const auction = uuidToToken(confirm.console.auctionId);
  const closesAt = confirm.console.week?.closesAt;
  const view = { ...confirm, page: 0 };
  return {
    id: "week-confirm",
    text: screenText(
      "Онлайн-неделя",
      escapeHtml(
        closesAt === undefined
          ? `К ставкам сразу откроются: ${lotsLabel(confirm.opening)}.`
          : `К ставкам сразу откроются: ${lotsLabel(confirm.opening)}. Торги закроются ${moment(closesAt, view)}.`,
      ),
      confirm.idle === 0
        ? undefined
        : escapeHtml(
            `Без цены и шага останутся без торгов: ${lotsLabel(confirm.idle)}.`,
          ),
      escapeHtml(
        "Отменить открытие нельзя: сроки, финал и состав лотов после него не меняются.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, открыть неделю",
      yesData: consoleConfirmData(auction, uuidToToken(confirm.opId)),
      noData: consoleViewData(auction),
    }),
    format: "HTML",
  };
}

const weekAskErrorText: Record<WeekAskError, string> = {
  "week-format":
    "Не получилось разобрать сроки. Нужны начало и конец: ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ.",
  "week-moment":
    "Такого времени нет по времени сообщества: в этот час переводили часы.",
  "week-order": "Конец недели должен быть позже начала.",
  "week-ended": "Конец недели уже прошёл.",
};

export const weekPrompt =
  "Сроки онлайн-недели по времени сообщества: начало и конец через тире. Конец — общий дедлайн лотов, например 00:00 дня финала.\nНапример: 20.10.2026 18:00 — 27.10.2026 00:00";

/**
 * Вопрос о сроках недели (дизайн-код, «Вопросы»): причина отказа первой
 * строкой, затем текущие сроки в том же виде, в каком их вводят, и образец.
 */
export function weekQuestionText(
  timeZone: string,
  week?: AuctionWeek,
  error?: WeekAskError,
): string {
  const local = (instant: string) =>
    formatLocalMoment(communityLocalTime(instant, timeZone));
  return [
    ...(error === undefined ? [] : [weekAskErrorText[error]]),
    ...(week?.opensAt === undefined || week.closesAt === undefined
      ? []
      : [`Сейчас: ${local(week.opensAt)} — ${local(week.closesAt)}`]),
    weekPrompt,
  ].join("\n");
}

/** Текст кадра отказа пульту; отказ по праву несёт общий текст хаба. */
export const consoleMissingText = "Аукцион не найден. Открой сходку заново.";
