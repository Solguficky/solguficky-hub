import { InlineKeyboard } from "grammy";
import type { LotStatusView } from "../../../../auction-ui/index.js";
import { refreshLabel } from "../../../../core/pictograms.js";
import {
  acceptsLots,
  activeLot,
  heldLots,
  launchableLots,
  rafflePrizeLimit,
  sortedLots,
  windowLimit,
  windowPrint,
} from "../../application/auction-console.js";
import { maxLotRubles } from "../../application/lot-form.js";
import { formatLocalMoment } from "../../application/meetup-form.js";
import type {
  AuctionConsoleView,
  AuctionWeek,
  ConsoleLot,
  ConsoleNote,
  ConsoleSort,
  ConsoleSortMetric,
  FinalAskError,
  FinalTimeAskError,
  LaunchDraft,
  LineupPick,
  LotAmount,
  RaffleAskError,
  RafflePrizeAskError,
  StepWindow,
  TradingHolder,
  WeekAskError,
  WindowAskError,
  WindowNote,
  WindowRef,
} from "../../application/types.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleAskData,
  consoleCancelConfirmData,
  consoleCancelData,
  consoleCloseConfirmData,
  consoleCloseData,
  consoleConfirmData,
  consoleDaySummaryData,
  consoleDiscardConfirmData,
  consoleDiscardData,
  consoleFinalData,
  consoleFinalTimeData,
  consoleFinalTimeRemoveData,
  consoleLineupConfirmData,
  consoleLineupData,
  consoleLineupPickData,
  consoleMarkData,
  consoleNextLotData,
  consoleOpenData,
  consoleRaffleData,
  consoleRafflePrizeData,
  consoleRafflePrizeRemoveData,
  consoleRaffleRemoveData,
  consoleStartFinalData,
  consoleViewData,
  consoleVisibilityData,
  consoleWeekData,
  consoleWindowAskData,
  consoleWindowData,
  consoleWindowLaunchData,
  consoleWindowLaunchGoData,
  consoleWindowLaunchLotData,
  consoleWindowLaunchPageData,
  consoleWindowLotData,
  consoleWindowRemoveData,
  consoleWindowsData,
  defaultConsoleSort,
} from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import { auctionCancelConsequence } from "./auction-stage.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  pagedTitle,
  pageSize,
  paginate,
  plural,
  readableMoment,
  removeLabel,
  screenText,
  toAuctionRoot,
  toggleLabel,
  withAccount,
  withNav,
  withPager,
} from "./kit.js";
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
  // Лот, о котором заметка отметки финала.
  noteLot?: string;
  // Аукцион, у которого идут торги: его называет `another-auction-active`.
  holder?: TradingHolder;
  page: number;
  sort: ConsoleSort;
  timeZone: string;
  today: CommunityDay;
  // Поток аукциона оборвался, пока пульт живой (PER-566): цена на экране
  // могла устареть, и экран говорит об этом, пока поток не вернётся.
  stale?: boolean;
};

export const staleConsoleText =
  "Связь с аукционом прервалась — цена могла устареть. Нажми «Обновить».";

// Живая правка пульта ведущего (PER-566): по потоку аукциона правится только
// пульт финала. Исход команды — свой экран, и правка по потоку затёрла бы его.
export function liveConsole(view: ConsoleScreenView): boolean {
  return view.note === undefined && inFinal(view.console);
}

export const consoleNoteText: Record<ConsoleNote, string> = {
  "week-saved": "Сроки недели сохранены.",
  "week-opened": "Онлайн-неделя открыта. Ставки принимаются с этой минуты.",
  "week-already-open": "Неделя уже открыта.",
  "another-auction-active":
    "Торги уже идут у другого аукциона. Открыть неделю можно, когда они закончатся.",
  "week-not-scheduled":
    "Сначала задай сроки недели. Без них неделю не открыть.",
  "week-frozen":
    "Онлайн-неделя уже открыта. Сроки, финал, счастливые часы и розыгрыш больше не меняются.",
  "week-needed": "Сначала задай сроки недели.",
  "raffle-saved": "Момент розыгрыша сохранён.",
  "raffle-removed": "Розыгрыш убран. Неделя пройдёт без него.",
  "prize-saved": "Приз розыгрыша сохранён.",
  "prize-removed": "Приз розыгрыша убран. Победитель получит весть без приза.",
  "prize-without-raffle":
    "Приз задаётся у розыгрыша: сначала нажми «Розыгрыш» и назови момент.",
  marked: "Лот отмечен для финала.",
  unmarked: "Отметка финала снята.",
  "already-marked": "Лот уже отмечен для финала.",
  "not-marked": "Отметки финала у лота уже нет.",
  "deadline-passed": "Дедлайн лота прошёл. Отметку финала уже не изменить.",
  "not-in-prebidding":
    "Онлайн-торги не идут. Отмечать лоты для финала можно только во время недели.",
  "lot-not-open": "Торги по лоту не идут. Отметить его для финала нельзя.",
  "not-in-online-phase": "Лот уже в живом финале.",
  "lot-not-in-auction": "Лота нет в этом аукционе.",
  "selection-not-applicable": "У недели нет финала. Отбирать лоты некуда.",
  "week-ended": "Конец недели уже прошёл. Задай новые сроки.",
  "no-lots-to-open": "Нет лотов с ценой и шагом. Открывать нечего.",
  "discard-too-late": "Онлайн-неделя уже открыта. Удалить аукцион нельзя.",
  "cancel-too-early":
    "Онлайн-неделя ещё не открыта. Отменять нечего: аукцион можно удалить.",
  "cancel-too-late": "Аукцион уже закончился. Отменять нечего.",
  "already-cancelled": "Аукцион уже отменён.",
  "auction-cancelled":
    "Аукцион отменён. Проданные лоты остались проданными, остальные сняты с торгов.",
  "meetup-hidden":
    "Сходка скрыта. Онлайн-неделя откроется, когда сходку снова опубликуют.",
  published: "Аукцион опубликован. Участники видят его и лоты.",
  unpublished: "Аукцион снят с публикации. Участники его не видят.",
  "visibility-too-late":
    "Онлайн-неделя уже открыта. Аукцион виден участникам, снять его нельзя.",
  // Ориентировочное время финала (PER-663): выставлено, снято или уже поздно.
  "final-time-saved": "Время финала сохранено.",
  "final-time-removed": "Время финала убрано. Анонса больше нет.",
  "final-already-started":
    "Финал уже начался. Время финала больше не меняется.",
  "auction-already-finished": "Аукцион уже завершён. Время финала не меняется.",
  "auction-already-cancelled": "Аукцион отменён. Время финала не меняется.",
  "final-started": "Финал начат. Открой первый лот.",
  "lineup-not-frozen": "Состав финала ещё не объявлен. Начать финал нельзя.",
  "not-in-final": "Финал не идёт. Открывать лоты нельзя.",
  "another-lot-active":
    "Лот ещё торгуется. Закрой его, прежде чем открыть следующий.",
  "lineup-exhausted": "Все лоты финала проведены.",
  "final-lot-closed": "Торги по лоту уже закрыты.",
  "deadline-not-reached":
    "Лот торгуется онлайн до своего дедлайна. Закрыть его раньше нельзя.",
  "final-finished": "Финал завершён. Все лоты закрыты, итоги — в пульте.",
  "lineup-frozen": "Состав финала объявлен. Начать финал — в пульте.",
  "lineup-empty": "В финал не отмечено ни одного лота. Объявлять нечего.",
  "lineup-too-long":
    "В финал отмечено больше 24 лотов. Столько бот не объявит.",
  "not-in-break": "Объявить состав можно только в перерыве перед финалом.",
};

// Исход, который повторяет сохранённое или называет аукцион с торгами
// (PER-618), — одной строкой заголовка: даты и название сходки несут точки и
// двоеточия, и делить их на заголовок и пояснение нельзя.
function noteText(view: ConsoleScreenView, note: ConsoleNote): string {
  const week = view.console.week;
  switch (note) {
    case "week-saved":
      return week?.opensAt === undefined || week.closesAt === undefined
        ? outcomeText(consoleNoteText[note])
        : screenText(
            `Сроки недели сохранены: с ${moment(week.opensAt, view)} до ${moment(week.closesAt, view)}`,
          );
    case "raffle-saved":
      return week?.raffleClosesAt === undefined
        ? outcomeText(consoleNoteText[note])
        : screenText(
            `Регистрация в розыгрыше закроется ${moment(week.raffleClosesAt, view)}`,
          );
    // Приз называет себя сам (PER-649): строка «Приз: …» идёт и в сводке.
    case "prize-saved":
      return week?.rafflePrize === undefined
        ? outcomeText(consoleNoteText[note])
        : screenText(`Приз розыгрыша сохранён: ${week.rafflePrize}`);
    // Время финала (PER-663) называется тем же, чем строкой пульта: момент
    // анонса, а не обещание, что финал начнётся ровно тогда.
    case "final-time-saved":
      return view.console.finalAt === undefined
        ? outcomeText(consoleNoteText[note])
        : screenText(
            `Время финала сохранено: ${moment(view.console.finalAt, view)}`,
          );
    case "another-auction-active":
      return view.holder === undefined
        ? outcomeText(consoleNoteText[note])
        : screenText(tradingElsewhere(view.holder, view));
    // Исход отметки называет лот предметом (прогон 14.10, №76).
    case "marked":
    case "unmarked":
    case "already-marked":
    case "not-marked": {
      const entry = view.console.lots.find(
        (each) => each.lot.lotId === view.noteLot,
      );
      return outcomeText(
        consoleNoteText[note],
        entry === undefined ? undefined : titleOf(entry),
      );
    }
    default:
      return outcomeText(consoleNoteText[note]);
  }
}

/**
 * Торги идут у другого аукциона (PER-603): исход называет его сходкой, если
 * бот её знает, иначе — сроками его онлайн-недели (PER-618).
 */
export function tradingElsewhere(
  holder: TradingHolder,
  view: { timeZone: string; today: CommunityDay },
): string {
  const where =
    holder.meetupTitle !== undefined
      ? `у сходки «${holder.meetupTitle.replace(/\s+/g, " ").trim()}»`
      : holder.opensAt !== undefined && holder.closesAt !== undefined
        ? `у аукциона с онлайн-неделей с ${localMoment(holder.opensAt, view)} до ${localMoment(holder.closesAt, view)}`
        : "у другого аукциона";
  return `Торги уже идут ${where}: открыть неделю можно, когда они закончатся`;
}

function localMoment(
  instant: string,
  view: { timeZone: string; today: CommunityDay },
): string {
  return readableMoment(communityLocalTime(instant, view.timeZone), view.today);
}

// Подпись финала: «Финал» в одно слово не говорил, что это живой финал на
// сходке после онлайн-недели (прогон 12.10, №46).
const finalLabel = "Финал в зале";

/** Всплывающий текст принятого переключателя финала (кадр P-08). */
export function finalToast(final: boolean): string {
  return final ? "Включено: финал в зале." : "Выключено: финал в зале.";
}

function moment(instant: string, view: ConsoleScreenView): string {
  return readableMoment(communityLocalTime(instant, view.timeZone), view.today);
}

function finalLine(week: AuctionWeek): string {
  return week.final ? "Финал: есть." : "Финал: нет.";
}

// Окна видны в снимке пульта строкой (PER-504); сами окна — на своём экране.
// Окна видны в снимке пульта строкой (PER-504); запущенные по ходу торгов
// (PER-615) считаются с объявленными — пульт показывает их рядом.
function windowsLines(console: AuctionConsoleView): string[] {
  const count =
    (console.week?.windows.length ?? 0) + console.launchedWindows.length;
  return count === 0 ? [] : [`Счастливые часы: ${windowsLabel(count)}.`];
}

// Розыгрыш (PER-593) виден строкой всегда: без момента у участников нет
// кнопки «Розыгрыш», и администратор видит почему. После закрытия регистрации
// строка идёт по статусу из `GetRaffle` (PER-618): жеребьёвка и её итог.
function raffleLine(week: AuctionWeek, view: ConsoleScreenView): string {
  if (week.raffleClosesAt === undefined) return "Розыгрыш: нет.";
  const raffle = view.console.raffle;
  if (raffle === undefined) {
    return `Розыгрыш: регистрация до ${moment(week.raffleClosesAt, view)}.`;
  }
  switch (raffle.status) {
    case "open":
      return `Розыгрыш: регистрация до ${moment(week.raffleClosesAt, view)}.`;
    case "closing":
    case "awaiting-beacon":
      return "Розыгрыш: регистрация закрыта, жеребьёвка идёт.";
    case "drawn": {
      const tickets = `билетов: ${raffle.tickets.length}`;
      const number = raffle.reveal?.winningTicket;
      if (number === undefined) {
        return `Розыгрыш: жеребьёвка прошла, ${tickets}.`;
      }
      const name = raffle.tickets.find(
        (ticket) => ticket.number === number,
      )?.displayName;
      return `Розыгрыш: выиграл билет №${number}${
        name === undefined ? "" : ` — ${name}`
      }, ${tickets}.`;
    }
    case "no-tickets":
      return "Розыгрыш: не состоялся, никто не зарегистрировался.";
    case "not-held":
      return "Розыгрыш: не проводился, неделя открылась после закрытия регистрации.";
    default: {
      const _exhaustive: never = raffle.status;
      return _exhaustive;
    }
  }
}

// Приз розыгрыша (PER-649) — строкой под розыгрышем: его видят участники на
// экране розыгрыша, а победитель — в вести. Без приза строки нет.
function rafflePrizeLines(week: AuctionWeek): string[] {
  return week.rafflePrize === undefined ? [] : [`Приз: ${week.rafflePrize}`];
}

// Розыгрыш после онлайн-торгов: итог виден, пока пульт открыт (PER-618).
function raffleLines(view: ConsoleScreenView): string[] {
  const week = view.console.week;
  return week?.raffleClosesAt === undefined
    ? []
    : [raffleLine(week, view), ...rafflePrizeLines(week)];
}

function weekLine(week: AuctionWeek, view: ConsoleScreenView): string {
  if (week.opensAt === undefined || week.closesAt === undefined) {
    return "Сроки недели заданы не полностью.";
  }
  return `Онлайн-неделя: с ${moment(week.opensAt, view)} до ${moment(week.closesAt, view)}.`;
}

// Видимость до торгов (PER-673): пульт называет её и у видимого аукциона,
// как карточка сходки у управляющего, — после открытия недели аукцион виден
// всегда, и строки нет.
function visibilityLine(console: AuctionConsoleView): string {
  return console.hidden
    ? "Скрыт от участников: они его не видят, пока не опубликуешь."
    : "Виден участникам.";
}

// Ориентировочное время финала (PER-663): анонс трансляции, а не условие
// торгов. Пульт называет его, пока финал впереди, — иначе анонс уже не
// меняется, и называть его незачем.
function finalTimeLines(
  console: AuctionConsoleView,
  view: ConsoleScreenView,
): string[] {
  if (console.status === "cancelled") return [];
  if (console.finalAt !== undefined) {
    return [`Время финала: ${moment(console.finalAt, view)}.`];
  }
  if (console.week?.final !== true) return [];
  return ["Время финала: не выставлено."];
}

// Время финала меняется, пока финал впереди. Кнопка «Время финала» стоит
// только у аукциона с финалом: анонсировать нечего. А снятие — пока анонс на
// месте: выключенный финал оставляет время у аукциона, и убрать его больше
// нечем (PER-663).
function finalTimeAhead(console: AuctionConsoleView): boolean {
  return (
    console.status !== "lineup-frozen" &&
    console.status !== "final" &&
    console.status !== "finished" &&
    console.status !== "cancelled"
  );
}

function finalTimeEditable(console: AuctionConsoleView): boolean {
  return console.week?.final === true && finalTimeAhead(console);
}

function finalTimeRemovable(console: AuctionConsoleView): boolean {
  return console.finalAt !== undefined && finalTimeAhead(console);
}

function statusLines(view: ConsoleScreenView): string[] {
  const { status, week } = view.console;
  switch (status) {
    case "draft":
      return [
        visibilityLine(view.console),
        "Сроки недели не заданы.",
        ...finalTimeLines(view.console, view),
      ];
    case "scheduled":
      return week === undefined
        ? [
            visibilityLine(view.console),
            "Сроки недели не заданы.",
            ...finalTimeLines(view.console, view),
          ]
        : [
            visibilityLine(view.console),
            weekLine(week, view),
            finalLine(week),
            ...finalTimeLines(view.console, view),
            ...windowsLines(view.console),
            raffleLine(week, view),
            ...rafflePrizeLines(week),
          ];
    case "prebidding":
      return [
        week?.closesAt === undefined
          ? "Идут онлайн-торги."
          : `Идут онлайн-торги до ${moment(week.closesAt, view)}.`,
        ...(week === undefined
          ? []
          : [
              finalLine(week),
              ...finalTimeLines(view.console, view),
              ...windowsLines(view.console),
              raffleLine(week, view),
              ...rafflePrizeLines(week),
            ]),
      ];
    case "settling":
      return [
        "Общий дедлайн прошёл: аукцион ждёт закрытия лотов.",
        ...finalTimeLines(view.console, view),
        ...raffleLines(view),
      ];
    case "break":
      return [
        "Онлайн-торги закончились: перерыв перед финалом.",
        ...finalTimeLines(view.console, view),
        ...raffleLines(view),
      ];
    case "lineup-frozen":
      return ["Состав финала объявлен.", ...finalTimeLines(view.console, view)];
    case "final":
      return ["Идёт финал.", ...finalTimeLines(view.console, view)];
    case "finished":
      return [
        "Аукцион завершён.",
        ...finalTimeLines(view.console, view),
        ...raffleLines(view),
      ];
    case "cancelled":
      return ["Аукцион отменён: проданные лоты остались проданными."];
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Финал ведущего (PER-337): у замороженного состава и в финале пульт
// показывает состав в порядке выхода, а не реестр, и торги текущего лота.
function inFinal(console: AuctionConsoleView): boolean {
  return console.status === "lineup-frozen" || console.status === "final";
}

// Финал идёт, а ведущий ещё не открыл ни одного лота: активного нет, и ни
// один лот состава не торговался в финале. Лот, выбывший до своей очереди,
// открытием не считается.
function noLotOpened(console: AuctionConsoleView): boolean {
  const lineup = console.lineup;
  if (console.status !== "final" || lineup === undefined) return false;
  if (lineup.activeLotId !== undefined) return false;
  return lineup.order.every((lotId) => {
    const kind = console.lots.find((each) => each.lot.lotId === lotId)?.lot
      .status.kind;
    return kind !== "trading" && kind !== "sold" && kind !== "unsold";
  });
}

function lineupLines(console: AuctionConsoleView): string[] {
  const active = console.lineup?.activeLotId;
  return (console.lineup?.order ?? []).map((lotId, index) => {
    const entry = console.lots.find((each) => each.lot.lotId === lotId);
    const title = entry === undefined ? untitled : titleOf(entry);
    const price =
      entry === undefined ? "" : ` — ${priceLabel(entry.lot.status)}`;
    const now = lotId === active ? " · торгуется" : "";
    return `${index + 1}. ${title}${price}${now}`;
  });
}

function tradingLines(console: AuctionConsoleView): string[] {
  const entry = activeLot(console);
  if (entry === undefined) {
    return console.status === "final" ? ["Сейчас лот не открыт."] : [];
  }
  const status = entry.lot.status;
  if (status.kind !== "trading") return [`Сейчас: ${titleOf(entry)}.`];
  const trading =
    console.trading?.lotId === entry.lot.lotId ? console.trading : undefined;
  return [
    `Сейчас: ${titleOf(entry)}.`,
    entry.lot.nextPrice === undefined
      ? `Цена: ${money(status.currentPrice)}.`
      : `Цена: ${money(status.currentPrice)}, следующая: ${money(entry.lot.nextPrice)}.`,
    status.leaderId === undefined
      ? "Ставок нет."
      : `Лидер: ${trading?.leaderName ?? "имя не получено"}.`,
    ...(trading === undefined || trading.bids.length === 0
      ? []
      : [
          "Последние ставки:",
          ...trading.bids.map(
            (bid) =>
              `${money(bid.amount)}${bid.name === undefined ? "" : ` — ${bid.name}`}`,
          ),
        ]),
  ];
}

function finalScreen(view: ConsoleScreenView): ShownScreen {
  const { console } = view;
  const auction = uuidToToken(console.auctionId);
  const keyboard = new InlineKeyboard();
  const order = console.lineup?.order ?? [];
  const entry = activeLot(console);
  const position = entry === undefined ? -1 : order.indexOf(entry.lot.lotId);
  if (console.status === "lineup-frozen") {
    keyboard.text("Начать финал", consoleStartFinalData(auction));
  } else if (
    entry !== undefined &&
    position >= 0 &&
    entry.lot.status.kind === "trading"
  ) {
    keyboard
      .text("Поднять цену", consoleAskData(auction, position))
      .row()
      .text(
        entry.lot.status.leaderId === undefined
          ? "Закрыть без продажи"
          : "Продать",
        consoleCloseData(auction, position),
      );
  } else {
    keyboard.text("Открыть следующий лот", consoleNextLotData(auction));
  }
  // Финал — тоже торги: отмена доступна и ведущему (ADR-047, дополнение
  // 2026-10-12), отдельным рядом над «Обновить» — рядов у финала мало.
  withCancel(nextRow(keyboard), console);
  nextRow(keyboard).text(refreshLabel, consoleViewData(auction));
  const trading = tradingLines(console);
  return {
    id: "auction-console",
    text: screenText(
      "Пульт",
      view.stale === true ? escapeHtml(staleConsoleText) : undefined,
      statusLines(view).map(escapeHtml).join("\n"),
      lineupLines(console).map(escapeHtml).join("\n"),
      trading.length === 0 ? undefined : trading.map(escapeHtml).join("\n"),
    ),
    keyboard: withNav(keyboard, toAuctionRoot(console.auctionId)),
    format: "HTML",
  };
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

// Перерыв (PER-619): сколько лотов удержано для финала. Сами лоты видны в
// реестре пометкой «в финал», порядок выбирается на своём экране.
function heldLine(console: AuctionConsoleView): string | undefined {
  if (console.status !== "break") return undefined;
  const held = heldLots(console).length;
  return held === 0
    ? consoleNoteText["lineup-empty"]
    : `В финал отмечены: ${lotsLabel(held)}.`;
}

/** «1 лот», «3 лота», «12 лотов». */
function lotsLabel(count: number): string {
  return counted(count, ["лот", "лота", "лотов"]);
}

/** «1 окно», «3 окна», «5 окон». */
function windowsLabel(count: number): string {
  return counted(count, ["окно", "окна", "окон"]);
}

export function counted(
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
    ...(entry.leaderName === undefined ? [] : [`лидер ${entry.leaderName}`]),
    bidsLabel(entry.bidCount),
    `${entry.uniqueParticipantCount} уч.`,
    ...(entry.priceGrowth === undefined
      ? []
      : [`рост ${money(entry.priceGrowth)}`]),
    ...(entry.markedForFinal ? ["в финал"] : []),
  ].join(" · ");
}

function compareLots(
  left: ConsoleLot,
  right: ConsoleLot,
  sort: ConsoleSort,
): number {
  if (sort.metric === "growth") {
    // Неизвестный рост всегда последний: отсутствие исходной цены нельзя
    // считать нулевым ростом или менять его место направлением сортировки.
    if (left.priceGrowth === undefined) {
      return right.priceGrowth === undefined
        ? left.lot.lotId.localeCompare(right.lot.lotId)
        : 1;
    }
    if (right.priceGrowth === undefined) return -1;
  }
  const leftValue = metricValue(left, sort.metric);
  const rightValue = metricValue(right, sort.metric);
  const order =
    leftValue === undefined || rightValue === undefined
      ? 0
      : leftValue < rightValue
        ? -1
        : leftValue > rightValue
          ? 1
          : 0;
  return (
    (sort.direction === "descending" ? -order : order) ||
    left.lot.lotId.localeCompare(right.lot.lotId)
  );
}

function metricValue(
  lot: ConsoleLot,
  metric: ConsoleSortMetric,
): number | undefined {
  switch (metric) {
    case "bids":
      return lot.bidCount;
    case "participants":
      return lot.uniqueParticipantCount;
    case "growth":
      return lot.priceGrowth?.minorUnits;
    default: {
      const _exhaustive: never = metric;
      return _exhaustive;
    }
  }
}

function sortLine(sort: ConsoleSort): string {
  const metric =
    sort.metric === "bids"
      ? "ставкам"
      : sort.metric === "participants"
        ? "участникам"
        : "росту цены";
  return `Сортировка: по ${metric} ${sort.direction === "descending" ? "↓" : "↑"}.`;
}

function nextSort(
  current: ConsoleSort,
  metric: ConsoleSortMetric,
): ConsoleSort {
  return current.metric === metric
    ? {
        metric,
        direction:
          current.direction === "descending" ? "ascending" : "descending",
      }
    : { metric, direction: "descending" };
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
  // Исход команды — свой экран (PER-472): пульт открывает «‹ Пульт».
  if (view.note !== undefined) {
    const keyboard = new InlineKeyboard();
    // Начатый финал ведёт сразу к первому лоту (PER-639): тот же вход, что
    // «Открыть следующий лот» пульта, без лишнего тапа через пульт. Повтор
    // «Начать финал» посреди финала отвечает тем же исходом — там первый лот
    // уже открывали, и кнопки нет.
    if (view.note === "final-started" && noLotOpened(console)) {
      keyboard.text("Открыть первый лот", consoleNextLotData(auction));
    }
    // Слот торгов занят (PER-606): исход ведёт и к идущему аукциону — в его
    // корень, а не в пульт: пульт чужого аукциона спросит своё право.
    if (view.note === "another-auction-active" && view.holder !== undefined) {
      keyboard.text(
        "Идущий аукцион",
        toAuctionRoot(view.holder.auctionId).data,
      );
    }
    return {
      id: "outcome",
      text: noteText(view, view.note),
      keyboard: withNav(keyboard, {
        name: "Пульт",
        data: consoleViewData(auction, view.page, view.sort),
      }),
      format: "HTML",
    };
  }
  if (inFinal(console)) return finalScreen(view);
  // Реестр Auction отдаёт без порядка; пульт держит порядок заведения —
  // идентификатор лота UUIDv7.
  const lots = [...console.lots].sort((a, b) => compareLots(a, b, view.sort));
  const page = paginate(lots, view.page);
  const keyboard = new InlineKeyboard();
  keyboard
    .text(
      "Ставки",
      consoleViewData(auction, page.page, nextSort(view.sort, "bids")),
    )
    .text(
      "Люди",
      consoleViewData(auction, page.page, nextSort(view.sort, "participants")),
    )
    .text(
      "Рост",
      consoleViewData(auction, page.page, nextSort(view.sort, "growth")),
    )
    .row();
  const editable = console.status === "draft" || console.status === "scheduled";
  if (editable) {
    // Видимость до торгов (PER-673) — парой со сроками и с целевым
    // состоянием: свой ряд вывел бы запланированный аукцион с розыгрышем,
    // призом и листанием за двенадцать рядов.
    keyboard
      .text("Сроки недели", consoleWeekData(auction))
      .text(
        console.hidden ? "Опубликовать" : "Снять с публикации",
        consoleVisibilityData(auction, console.hidden),
      );
  }
  const week = console.week;
  const scheduled =
    console.status === "scheduled" &&
    week?.opensAt !== undefined &&
    week.closesAt !== undefined;
  // Ориентировочное время финала (PER-663): рядом с настройкой недели, а в
  // онлайн-торгах и перерыве, где переключателя финала нет, — сразу после
  // строк настройки. Снятие стоит в том же ряду: два «🗑» в один ряд не
  // встают, а пульт упирается в потолок рядов.
  const finalTimeSet = finalTimeEditable(console);
  if (finalTimeSet || finalTimeRemovable(console)) {
    nextRow(keyboard);
    if (finalTimeSet) {
      keyboard.text("Время финала", consoleFinalTimeData(auction));
    }
    if (finalTimeRemovable(console)) {
      keyboard.text(
        removeLabel("Убрать время финала"),
        consoleFinalTimeRemoveData(auction),
      );
    }
  }
  const windowsShown = scheduled || console.status === "prebidding";
  // «Сводка дня» (PER-492) идёт рядом со «Счастливыми часами», где этот ряд
  // есть: в онлайн-торгах с окнами и восемью лотами отдельный ряд вывел бы
  // пульт за двенадцать. Без окон — сразу под сортировкой.
  if (!windowsShown) {
    nextRow(keyboard).text("Сводка дня", consoleDaySummaryData(auction));
    withCancel(keyboard, console);
  }
  if (scheduled) {
    nextRow(keyboard).text(
      toggleLabel(finalLabel, week.final),
      consoleFinalData(auction, !week.final),
    );
    nextRow(keyboard)
      .text("Счастливые часы", consoleWindowsData(auction))
      .text("Сводка дня", consoleDaySummaryData(auction));
    nextRow(keyboard).text("Розыгрыш", consoleRaffleData(auction));
    if (week.raffleClosesAt !== undefined) {
      // Приз живёт у розыгрыша (PER-649): без момента кнопки нет — Auction
      // приз без розыгрыша не принимает.
      nextRow(keyboard).text(
        week.rafflePrize === undefined ? "Приз" : "Изменить приз",
        consoleRafflePrizeData(auction),
      );
      nextRow(keyboard).text(
        removeLabel("Убрать розыгрыш"),
        consoleRaffleRemoveData(auction),
      );
      if (week.rafflePrize !== undefined) {
        nextRow(keyboard).text(
          removeLabel("Убрать приз"),
          consoleRafflePrizeRemoveData(auction),
        );
      }
    }
    nextRow(keyboard).text("Открыть онлайн-неделю", consoleOpenData(auction));
  } else if (console.status === "prebidding") {
    // После открытия окна только видны: править их уже нельзя. Ряд есть и
    // без окон: в нём запускается окно по ходу торгов (PER-615).
    nextRow(keyboard)
      .text("Счастливые часы", consoleWindowsData(auction))
      .text("Сводка дня", consoleDaySummaryData(auction));
    withCancel(keyboard, console);
  }
  if (editable) {
    nextRow(keyboard).text(
      removeLabel("Удалить аукцион"),
      consoleDiscardData(auction),
    );
  }
  if (console.status === "break" && heldLots(console).length > 0) {
    nextRow(keyboard).text(
      "Объявить состав финала",
      consoleLineupData(auction),
    );
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
          sort: view.sort,
        }),
      );
    }
  }
  withPager(keyboard, page, (target) =>
    consoleViewData(auction, target, view.sort),
  );
  const overdue = lots.filter((entry) => entry.overdue);
  return {
    id: "auction-console",
    text: screenText(
      pagedTitle("Пульт", page),
      [...statusLines(view), heldLine(console)]
        .filter((line) => line !== undefined)
        .map(escapeHtml)
        .join("\n"),
      escapeHtml(sortLine(view.sort)),
      lots.length === 0
        ? "Лотов пока нет."
        : page.items.map((entry) => escapeHtml(lotLine(entry))).join("\n"),
      overdue.length === 0
        ? undefined
        : escapeHtml(
            `Просрочены, не закрыты: ${overdue.map(titleOf).join(", ")}.`,
          ),
    ),
    keyboard: withNav(keyboard, toAuctionRoot(console.auctionId)),
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
  // Начало недели ещё впереди (№58).
  early?: true;
}): ShownScreen {
  const auction = uuidToToken(confirm.console.auctionId);
  const opensAt = confirm.console.week?.opensAt;
  const closesAt = confirm.console.week?.closesAt;
  const view = { ...confirm, page: 0, sort: defaultConsoleSort };
  // Auction открывает лоты сразу, сроки начала не ждут (прогон 14.10, №58):
  // неделя с будущим началом принимает ставки с подтверждения.
  return {
    id: "week-confirm",
    text: screenText(
      "Онлайн-неделя",
      escapeHtml(
        [
          `К ставкам сразу откроются: ${lotsLabel(confirm.opening)}.`,
          ...(confirm.early === true && opensAt !== undefined
            ? [
                `Ставки начнут приниматься с подтверждения, не дожидаясь начала недели ${moment(opensAt, view)}.`,
              ]
            : []),
          ...(closesAt === undefined
            ? []
            : [`Торги закроются ${moment(closesAt, view)}.`]),
        ].join(" "),
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
      irreversible: true,
    }),
    format: "HTML",
  };
}

function lineupEntryLines(
  held: readonly ConsoleLot[],
  order: readonly number[],
): string[] {
  return order.flatMap((at, index) => {
    const entry = held[at];
    return entry === undefined
      ? []
      : [`${index + 1}. ${titleOf(entry)} — ${priceLabel(entry.lot.status)}`];
  });
}

/**
 * Выбор порядка состава финала (PER-619): уже выбранные лоты по порядку и
 * кнопка на каждый невыбранный. Последний лот встаёт в конец сам, «Остальные
 * — как в списке» дозаполняет порядок порядком заведения. Всё выбранное едет
 * в кнопке: состояния у пульта нет.
 */
export function lineupOrderScreen(order: {
  console: AuctionConsoleView;
  held: readonly ConsoleLot[];
  pick: LineupPick;
  page: number;
  changed?: true | undefined;
}): ShownScreen {
  const auction = uuidToToken(order.console.auctionId);
  const { held, pick } = order;
  const rest = [...held.keys()].filter((at) => !pick.order.includes(at));
  const page = paginate(rest, order.page);
  const keyboard = new InlineKeyboard();
  const pickNext = (next: readonly number[]) =>
    consoleLineupPickData(auction, {
      print: pick.print,
      order: [...pick.order, ...next],
    });
  // Сначала действия, затем лоты и листание (дизайн-код, «Клавиатура»).
  keyboard.text(
    pick.order.length === 0 ? "Все — как в списке" : "Остальные — как в списке",
    pickNext(rest),
  );
  if (pick.order.length > 0) {
    nextRow(keyboard).text("Заново", consoleLineupData(auction));
  }
  for (const at of page.items) {
    const entry = held[at];
    if (entry === undefined) continue;
    // Цена рядом с названием различает лоты с одинаковым названием.
    nextRow(keyboard).text(
      buttonText(`${titleOf(entry)} — ${priceLabel(entry.lot.status)}`),
      pickNext([at]),
    );
  }
  withPager(keyboard, page, (target) =>
    consoleLineupPickData(auction, pick, target),
  );
  const chosen = lineupEntryLines(held, pick.order);
  return {
    id: "lineup-order",
    text: screenText(
      pagedTitle("Порядок финала", page),
      order.changed === true
        ? escapeHtml(
            "Отметки финала изменились, пока выбирался порядок. Выбери заново.",
          )
        : undefined,
      chosen.length === 0
        ? undefined
        : ["Уже по порядку:", ...chosen].map(escapeHtml).join("\n"),
      escapeHtml(
        pick.order.length === 0
          ? "Кто выходит первым?"
          : "Кто выходит следующим?",
      ),
    ),
    keyboard: withNav(keyboard, {
      name: "Пульт",
      data: consoleViewData(auction),
    }),
    format: "HTML",
  };
}

/**
 * Подтверждение состава финала (PER-619): лоты в порядке выхода. Порядок и
 * отпечаток набора едут в «Да», а ключ объявления рождается на нажатие:
 * повтор после принятого объявления пульт узнаёт по статусу аукциона.
 */
export function lineupConfirmScreen(confirm: {
  console: AuctionConsoleView;
  held: readonly ConsoleLot[];
  pick: LineupPick;
}): ShownScreen {
  const auction = uuidToToken(confirm.console.auctionId);
  return {
    id: "lineup-confirm",
    text: screenText(
      "Объявить состав финала?",
      lineupEntryLines(confirm.held, confirm.pick.order)
        .map(escapeHtml)
        .join("\n"),
      escapeHtml(
        "Отменить объявление нельзя: состав и порядок финала после него не меняются.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, объявить",
      yesData: consoleLineupConfirmData(auction, confirm.pick),
      noData: consoleViewData(auction),
      irreversible: true,
    }),
    format: "HTML",
  };
}

/**
 * Подтверждение удаления аукциона до торгов. Ключ команды рождён здесь и едет
 * в «Да»: повторное нажатие той же кнопки Auction примет как повтор.
 */
export function discardConfirmScreen(confirm: {
  auctionId: string;
  opId: string;
  lots: number;
}): ShownScreen {
  const auction = uuidToToken(confirm.auctionId);
  return {
    id: "discard-confirm",
    text: screenText(
      "Удалить аукцион?",
      confirm.lots === 0
        ? undefined
        : escapeHtml(`Из аукциона уйдут: ${lotsLabel(confirm.lots)}.`),
      escapeHtml(
        "Лоты и сроки пропадут. Включить аукцион у сходки можно заново.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, удалить",
      yesData: consoleDiscardConfirmData(auction, uuidToToken(confirm.opId)),
      noData: consoleViewData(auction),
      irreversible: true,
    }),
    format: "HTML",
  };
}

// «Отменить аукцион» (PER-606) — в ряду «Сводки дня» пульта: в онлайн-торгах
// с восемью лотами для финала отдельный ряд вывел бы пульт за двенадцать, как
// «Сводку дня» рядом со «Счастливыми часами». Без знака: «🗑» — у «Убрать» и
// «Удалить», а отмена, как «Отменить сходку», знака не несёт.
function withCancel(keyboard: InlineKeyboard, console: AuctionConsoleView) {
  if (!cancellable(console)) return;
  keyboard.text(cancelLabel, consoleCancelData(uuidToToken(console.auctionId)));
}

const cancelLabel = "Отменить аукцион";

// Отменить аукцион можно с открытия онлайн-недели до его конца (ADR-047,
// дополнение 2026-10-12); до неё действует удаление.
function cancellable(console: AuctionConsoleView): boolean {
  return (
    console.status !== "draft" &&
    console.status !== "scheduled" &&
    console.status !== "finished" &&
    console.status !== "cancelled"
  );
}

/**
 * Подтверждение отмены аукциона после старта торгов. Ключ команды рождён
 * здесь и едет в «Да»: повторное нажатие Auction примет как повтор.
 */
export function cancelConfirmScreen(confirm: {
  auctionId: string;
  opId: string;
  sold: number;
}): ShownScreen {
  const auction = uuidToToken(confirm.auctionId);
  return {
    id: "cancel-confirm",
    text: screenText(
      "Отменить аукцион?",
      escapeHtml(auctionCancelConsequence(confirm.sold)),
      escapeHtml("Отменить нельзя: нового аукциона у этой сходки не будет."),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, отменить аукцион",
      yesData: consoleCancelConfirmData(auction, uuidToToken(confirm.opId)),
      noData: consoleViewData(auction),
      irreversible: true,
    }),
    format: "HTML",
  };
}

/**
 * Подтверждение закрытия лота финала: продажа лидеру по текущей цене либо,
 * без ставок, закрытие без продажи. Ключ закрытия рождён здесь и едет в «Да»:
 * повторное нажатие той же кнопки Auction примет как повтор, и второй
 * продажи не будет.
 */
export function closeConfirmScreen(confirm: {
  auctionId: string;
  position: number;
  opId: string;
  title?: string | undefined;
  price?: LotAmount | undefined;
  leaderName?: string | undefined;
  leaderUsername?: string | undefined;
  changed?: true | undefined;
}): ShownScreen {
  const auction = uuidToToken(confirm.auctionId);
  const title = truncate(confirm.title ?? untitled, titleLimit);
  const buyer =
    confirm.leaderName === undefined
      ? ""
      : `, покупатель — ${withAccount(confirm.leaderName, confirm.leaderUsername)}`;
  return {
    id: "final-close-confirm",
    text: screenText(
      `Закрыть лот «${escapeHtml(title)}»?`,
      confirm.changed === true
        ? escapeHtml(
            "Лот изменился, пока было открыто подтверждение. Проверь заново.",
          )
        : undefined,
      escapeHtml(
        confirm.price === undefined
          ? "Ставок нет: лот закроется без продажи."
          : `Продажа за ${money(confirm.price)}${buyer}.`,
      ),
      escapeHtml("Отменить закрытие нельзя: торги по лоту закончатся."),
    ),
    keyboard: confirmKeyboard({
      yes: confirm.price === undefined ? "Да, закрыть" : "Да, продать",
      yesData: consoleCloseConfirmData(
        auction,
        confirm.position,
        uuidToToken(confirm.opId),
        confirm.price === undefined
          ? { kind: "no-sale" }
          : { kind: "sale", minorUnits: confirm.price.minorUnits },
      ),
      noData: consoleViewData(auction),
      irreversible: true,
    }),
    format: "HTML",
  };
}

/**
 * Исход закрытия лота финала — свой экран (решение владельца 11 октября 2026
 * года): продажа необратима, и ведущий видит её итог явно, а не строкой
 * состава. Возврат — пульт ведущего.
 */
export function closedScreen(closed: {
  auctionId: string;
  title?: string | undefined;
  closure:
    | {
        kind: "sold";
        price: LotAmount;
        buyerName?: string | undefined;
        buyerUsername?: string | undefined;
      }
    | { kind: "unsold" };
  finished?: { soldLots: number; total: LotAmount } | undefined;
}): ShownScreen {
  const { closure, finished } = closed;
  const buyer =
    closure.kind === "sold" && closure.buyerName !== undefined
      ? `, покупатель — ${withAccount(closure.buyerName, closure.buyerUsername)}`
      : "";
  const toConsole = consoleViewData(uuidToToken(closed.auctionId));
  // Последний лот состава завершает аукцион (PER-639): исход говорит об этом
  // сам, а «Итоги» ведут в пульт завершённого аукциона. Возврат тогда — в
  // аукцион, как у самого пульта, чтобы две кнопки не вели в одно место.
  const keyboard = new InlineKeyboard();
  if (finished !== undefined) keyboard.text("Итоги", toConsole);
  return {
    id: "outcome",
    text: outcomeText(
      [
        closure.kind === "sold"
          ? `Лот продан. Цена: ${money(closure.price)}${buyer}.`
          : "Лот закрыт без продажи. Ставок не было.",
        ...(finished === undefined ? [] : [finishedLine(finished)]),
      ].join(" "),
      truncate(closed.title ?? untitled, titleLimit),
    ),
    keyboard: withNav(
      keyboard,
      finished === undefined
        ? { name: "Пульт", data: toConsole }
        : toAuctionRoot(closed.auctionId),
    ),
    format: "HTML",
  };
}

function finishedLine(finished: {
  soldLots: number;
  total: LotAmount;
}): string {
  return finished.soldLots === 0
    ? "Это был последний лот — аукцион завершён, продаж нет."
    : `Это был последний лот — аукцион завершён: ${plural(finished.soldLots, ["лот", "лота", "лотов"])}, ${money(finished.total)}.`;
}

/** Причина отказа ответу о следующей цене: заголовок экрана исхода. */
export function finalAskErrorText(
  error: FinalAskError,
  mustExceed?: LotAmount,
): string {
  switch (error) {
    case "amount-format":
      return "Нужно целое число рублей. Только цифры, без копеек.";
    case "amount-range":
      return "Сумма — от 1 до 9 999 999 рублей.";
    case "ask-below-current-price":
      return mustExceed === undefined
        ? "Новая цена должна быть выше текущей."
        : `Новая цена должна быть выше ${money(mustExceed)}.`;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

/**
 * Вопрос о следующей цене лота финала: лот, текущая следующая цена, порог и
 * образец. Порог — следующая цена, а не текущая (PER-640): ниже неё бот ответ
 * не принимает. Образец — ближайшая сотня рублей выше порога. Ставка зала
 * после ответа принимается ровно на эту цену (ADR-049).
 */
export function finalAskText(ask: {
  title?: string | undefined;
  nextPrice?: LotAmount | undefined;
}): string {
  const lot = `Лот: ${truncate(ask.title ?? untitled, titleLimit)}`;
  if (ask.nextPrice === undefined) {
    return [
      lot,
      "Новая следующая цена в целых рублях, выше текущей. Например: 5000",
    ].join("\n");
  }
  const rubles = ask.nextPrice.minorUnits / 100;
  const sample = (Math.floor(rubles / 100) + 1) * 100;
  return [
    lot,
    `Сейчас следующая цена: ${money(ask.nextPrice)}`,
    // Сотня выше предела суммы ответа образцом не годится: его не примет
    // разбор, поэтому образца нет.
    `Новая следующая цена в целых рублях, выше ${money(ask.nextPrice)}.${sample > maxLotRubles ? "" : ` Например: ${sample}`}`,
  ].join("\n");
}

export const auctionDiscardedText =
  "Аукцион удалён. Включить его у сходки можно заново.";

/** Причина отказа ответу о сроках недели: заголовок экрана исхода. */
export const weekAskErrorText: Record<WeekAskError, string> = {
  "week-format":
    "Не получилось разобрать сроки. Нужны начало и конец: ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ.",
  "week-moment":
    "Такого времени нет по времени сообщества: в этот час переводили часы.",
  "week-order": "Конец недели должен быть позже начала.",
  "week-ended": "Конец недели уже прошёл.",
  "week-cuts-window":
    "Окно счастливых часов не помещается в новые сроки. Удали его или задай сроки шире.",
  "week-cuts-raffle":
    "Момент розыгрыша не помещается в новые сроки. Сдвинь или убери его кнопкой «Розыгрыш» на пульте или задай сроки шире.",
};

/** Причина отказа ответу о сроках с номером окна, которое сроки отрезали. */
export function weekAskError(error: WeekAskError, window?: number): string {
  return error === "week-cuts-window" && window !== undefined
    ? `Окно ${window} счастливых часов не помещается в новые сроки. Удали его или задай сроки шире.`
    : weekAskErrorText[error];
}

export const weekPrompt =
  "Сроки онлайн-недели по времени сообщества: начало и конец через тире. Конец — общий дедлайн лотов, например 00:00 дня финала.\nНапример: 20.10.2026 18:00 — 27.10.2026 00:00";

/**
 * Вопрос о сроках недели (дизайн-код, «Вопросы»): причина отказа первой
 * строкой, затем текущие сроки в том же виде, в каком их вводят, и образец.
 */
export function weekQuestionText(timeZone: string, week?: AuctionWeek): string {
  const local = (instant: string) =>
    formatLocalMoment(communityLocalTime(instant, timeZone));
  return [
    ...(week?.opensAt === undefined || week.closesAt === undefined
      ? []
      : [`Сейчас: ${local(week.opensAt)} — ${local(week.closesAt)}`]),
    weekPrompt,
  ].join("\n");
}

/** Причина отказа ответу о моменте розыгрыша: заголовок экрана исхода. */
export const raffleAskErrorText: Record<RaffleAskError, string> = {
  "raffle-format":
    "Не получилось разобрать момент. Нужны дата и время: ДД.ММ.ГГГГ ЧЧ:ММ.",
  "raffle-moment":
    "Такого времени нет по времени сообщества: в этот час переводили часы.",
  "raffle-ended": "Этот момент уже прошёл.",
  "raffle-not-after-opens":
    "Регистрация в розыгрыше должна закрыться позже начала недели.",
  "raffle-not-before-closes":
    "Регистрация в розыгрыше должна закрыться раньше конца недели.",
};

export const rafflePrompt =
  "Когда закрыть регистрацию в розыгрыше? Дата и время по времени сообщества, между началом и концом недели. Итог — через пару минут после закрытия.\nНапример: 22.10.2026 18:00";

/**
 * Вопрос о моменте розыгрыша (дизайн-код, «Вопросы»): сроки недели и текущий
 * момент в том же виде, в каком их вводят, затем образец.
 */
export function raffleQuestionText(
  timeZone: string,
  week: AuctionWeek,
): string {
  const local = (instant: string) =>
    formatLocalMoment(communityLocalTime(instant, timeZone));
  return [
    ...(week.opensAt === undefined || week.closesAt === undefined
      ? []
      : [`Неделя: ${local(week.opensAt)} — ${local(week.closesAt)}`]),
    ...(week.raffleClosesAt === undefined
      ? []
      : [`Сейчас: ${local(week.raffleClosesAt)}`]),
    rafflePrompt,
  ].join("\n");
}

/** Причина отказа ответу о призе розыгрыша (PER-649). */
export const rafflePrizeAskErrorText: Record<RafflePrizeAskError, string> = {
  "prize-blank":
    "Пустой приз призом не считается: напиши, что получит победитель.",
  "prize-too-long": `Приз длиннее ${rafflePrizeLimit} знаков: строку увидят участники, и её нужно сократить.`,
};

export const rafflePrizePrompt = `Приз одной строкой — то, что получит победитель. Например: сертификат в книжный магазин на 5000 ₽. Не длиннее ${rafflePrizeLimit} знаков`;

/**
 * Вопрос о призе розыгрыша: текущий приз в том же виде, в каком его вводят,
 * затем образец.
 */
export function rafflePrizeQuestionText(prize: string | undefined): string {
  return [
    ...(prize === undefined ? [] : [`Сейчас: ${prize}`]),
    rafflePrizePrompt,
  ].join("\n");
}

/** Причина отказа ответу о времени финала (PER-663). */
export const finalTimeAskErrorText: Record<FinalTimeAskError, string> = {
  "final-time-format":
    "Не получилось разобрать момент. Нужны дата и время: ДД.ММ.ГГГГ ЧЧ:ММ.",
  "final-time-moment":
    "Такого времени нет по времени сообщества: в этот час переводили часы.",
  "final-time-past": "Этот момент уже прошёл.",
};

export const finalTimePrompt =
  "Когда ждать финал в зале? Дата и время по времени сообщества — анонс, а не обещание.\nНапример: 31.10.2026 19:00";

/**
 * Вопрос об ориентировочном времени финала (PER-663): текущее время в том
 * же виде, в каком его вводят, затем образец.
 */
export function finalTimeQuestionText(
  timeZone: string,
  finalAt: string | undefined,
): string {
  return [
    ...(finalAt === undefined
      ? []
      : [
          `Сейчас: ${formatLocalMoment(communityLocalTime(finalAt, timeZone))}`,
        ]),
    finalTimePrompt,
  ].join("\n");
}

// «Счастливые часы» (PER-504): окна сниженного шага онлайн-недели. Окно
// задаётся до открытия недели одним ответом и рождается со всеми лотами
// реестра; лишние организатор снимает на экране окна (решение владельца
// 11 октября 2026 года).

const toWindows = (auction: string) => ({
  name: "Счастливые часы",
  data: consoleWindowsData(auction),
});

export type WindowsScreenView = {
  console: AuctionConsoleView;
  note?: WindowNote | undefined;
  timeZone: string;
  today: CommunityDay;
  // Запуск окна доступен (PER-615): идут онлайн-торги и общий дедлайн не
  // прошёл. Решает край по часам бота — статус аукциона может отставать.
  launch?: boolean | undefined;
};

function windowsOf(console: AuctionConsoleView): readonly StepWindow[] {
  return console.week?.windows ?? [];
}

function refOf(window: StepWindow, index: number): WindowRef {
  return { index, print: windowPrint(window) };
}

function spanLine(
  window: StepWindow,
  view: { timeZone: string; today: CommunityDay },
): string {
  const local = (instant: string) =>
    readableMoment(communityLocalTime(instant, view.timeZone), view.today);
  return `с ${local(window.from)} до ${local(window.until)}, шаг ${money(window.step)}`;
}

// Лоты окна, которых нет в реестре, Auction принимает молча (ADR-047,
// дополнение 2026-10-08, «Открыто»): пульт — единственное место, где они видны.
function lotsOfWindow(window: StepWindow, console: AuctionConsoleView): string {
  const registry = new Set(console.lots.map((each) => each.lot.lotId));
  const inRegistry = window.lotIds.filter((lotId) => registry.has(lotId));
  const outside = window.lotIds.length - inRegistry.length;
  return [
    `лотов ${inRegistry.length} из ${console.lots.length}`,
    ...(outside === 0 ? [] : [`не в реестре: ${outside}`]),
  ].join(" · ");
}

export function windowNoteText(
  note: WindowNote,
  view: { timeZone: string; today: CommunityDay },
): string {
  switch (note.kind) {
    case "saved":
      return `Окно ${note.window} сохранено. В нём все лоты аукциона — лишние сними на экране окна.`;
    case "removed":
      return `Окно ${note.window} удалено.`;
    case "changed":
      return "Окна изменились, пока был открыт экран. Проверь заново.";
    case "last-lot":
      return `Это последний лот окна ${note.window}. Окна без лотов не бывает — удали окно целиком.`;
    case "no-lots":
      return "Лотов пока нет. Окну нужны лоты — сначала добавь их.";
    case "limit":
      return `Окон уже ${windowLimit}. Удали лишнее окно, чтобы добавить новое.`;
    case "overlap":
      return `Лот уже в окне ${note.other}, а оно пересекается с окном ${note.window} по времени. Сначала убери лот из окна ${note.other}.`;
    case "launched": {
      const local = (instant: string) =>
        readableMoment(communityLocalTime(instant, view.timeZone), view.today);
      return `Окно запущено: с ${local(note.from)} до ${local(note.until)}, шаг ${money(note.step)}.`;
    }
    case "launch-closed":
      return "Запуск окна доступен только во время онлайн-торгов.";
    case "launch-empty":
      return "Окну нужны лоты. Оставь хотя бы один.";
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

/** Всплывающий текст принятого переключателя лота в окне. */
export function windowLotToast(selected: boolean): string {
  return selected ? "Лот добавлен в окно." : "Лот убран из окна.";
}

/**
 * «Счастливые часы»: окна строками с номером, сроками, шагом и числом лотов.
 * Пока неделя не открыта — кнопка на каждое окно и «Добавить окно»; после —
 * только список.
 */
export function windowsScreen(view: WindowsScreenView): ShownScreen {
  const { console } = view;
  const auction = uuidToToken(console.auctionId);
  if (view.note !== undefined) {
    return {
      id: "outcome",
      text: outcomeText(windowNoteText(view.note, view)),
      keyboard: withNav(new InlineKeyboard(), toWindows(auction)),
      format: "HTML",
    };
  }
  const windows = windowsOf(console);
  const launched = console.launchedWindows;
  const editable = acceptsLots(console.status);
  const keyboard = new InlineKeyboard();
  // Окно открывается и после открытия недели — только для просмотра его лотов.
  windows.slice(0, windowLimit).forEach((window, index) => {
    nextRow(keyboard).text(
      `Окно ${index + 1}`,
      consoleWindowData(auction, refOf(window, index)),
    );
  });
  if (editable && windows.length < windowLimit) {
    nextRow(keyboard).text("Добавить окно", consoleWindowAskData(auction));
  }
  // Запуск окна по ходу торгов (PER-615): действие есть, пока идут онлайн-торги.
  if (view.launch === true) {
    nextRow(keyboard).text("Запустить окно", consoleWindowLaunchData(auction));
  }
  return {
    id: "step-windows",
    text: screenText(
      "Счастливые часы",
      escapeHtml(
        "В окне ставка на выбранных лотах растёт на меньший шаг. Окна задаются до открытия недели.",
      ),
      windows.length === 0
        ? "Окон пока нет."
        : windows
            .map((window, index) =>
              escapeHtml(
                `${index + 1}. ${spanLine(window, view)} · ${lotsOfWindow(window, console)}`,
              ),
            )
            .join("\n"),
      launched.length === 0
        ? undefined
        : [
            "Запущенные окна:",
            ...launched.map((window) =>
              escapeHtml(
                `• ${spanLine(window, view)} · ${lotsOfWindow(window, console)}`,
              ),
            ),
          ].join("\n"),
    ),
    keyboard: withNav(keyboard, {
      name: "Пульт",
      data: consoleViewData(auction),
    }),
    format: "HTML",
  };
}

/**
 * Окно: сроки и шаг, затем лоты реестра в порядке заведения переключателями
 * «в окне — нет». Страницу задаёт кнопка листания либо лот, который только
 * что переключили. После открытия недели — только список лотов окна.
 */
export function windowScreen(view: {
  console: AuctionConsoleView;
  index: number;
  at: { page: number } | { lotId: string };
  timeZone: string;
  today: CommunityDay;
}): ShownScreen {
  const { console, index } = view;
  const auction = uuidToToken(console.auctionId);
  const window = windowsOf(console)[index];
  if (window === undefined) {
    return windowsScreen({ ...view, note: { kind: "changed" } });
  }
  const ref = refOf(window, index);
  const lots = [...console.lots].sort((a, b) =>
    a.lot.lotId.localeCompare(b.lot.lotId),
  );
  const at = view.at;
  const requested =
    "page" in at
      ? at.page
      : Math.floor(
          Math.max(
            lots.findIndex((each) => each.lot.lotId === at.lotId),
            0,
          ) / pageSize,
        );
  const inWindow = new Set(window.lotIds);
  const editable = acceptsLots(console.status);
  const keyboard = new InlineKeyboard();
  let lines: string;
  let title: string;
  if (editable) {
    const page = paginate(lots, requested);
    title = pagedTitle(`Окно ${index + 1}`, page);
    for (const entry of page.items) {
      const selected = inWindow.has(entry.lot.lotId);
      nextRow(keyboard).text(
        buttonText(toggleLabel(titleOf(entry), selected)),
        consoleWindowLotData({
          auction,
          window: ref,
          lot: uuidToToken(entry.lot.lotId),
          selected: !selected,
        }),
      );
    }
    withPager(keyboard, page, (target) =>
      consoleWindowData(auction, ref, target),
    );
    nextRow(keyboard).text(
      removeLabel("Удалить окно"),
      consoleWindowRemoveData(auction, ref),
    );
    lines =
      lots.length === 0
        ? "Лотов пока нет."
        : escapeHtml("Вкл — лот в окне, Выкл — шаг у лота обычный.");
  } else {
    const shown = lots.filter((entry) => inWindow.has(entry.lot.lotId));
    const page = paginate(shown, requested);
    title = pagedTitle(`Окно ${index + 1}`, page);
    withPager(keyboard, page, (target) =>
      consoleWindowData(auction, ref, target),
    );
    lines =
      shown.length === 0
        ? "Лотов реестра в окне нет."
        : page.items
            .map((entry) => escapeHtml(`• ${titleOf(entry)}`))
            .join("\n");
  }
  return {
    id: "step-window",
    text: screenText(
      title,
      escapeHtml(
        `${spanLine(window, view)}. ${lotsOfWindow(window, console)}.`,
      ),
      lines,
    ),
    keyboard: withNav(keyboard, toWindows(auction)),
    format: "HTML",
  };
}

/** Причина отказа ответу об окне: заголовок экрана исхода. */
export function windowAskErrorText(
  error: WindowAskError,
  context: {
    timeZone: string;
    week?: AuctionWeek | undefined;
    window?: number | undefined;
    // Отказ запуска окна (PER-615) называет лот и границы окна, с которым
    // запущенное пересеклось: номер окна у запуска нет.
    lot?: string | undefined;
    other?: { from: string; until: string } | undefined;
  },
): string {
  switch (error) {
    case "window-format":
      return "Не получилось разобрать окно. Нужны начало, конец и шаг: ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ, 50.";
    case "window-moment":
      return weekAskErrorText["week-moment"];
    case "window-order":
      return "Конец окна должен быть позже начала.";
    case "window-ended":
      return "Конец окна уже прошёл.";
    case "amount-format":
      return "Шаг — целое число рублей. Только цифры, без копеек.";
    case "amount-range":
      return "Шаг — от 1 до 9 999 999 рублей.";
    case "window-outside-week": {
      const span = weekSpan(context.timeZone, context.week);
      return span === undefined
        ? "Окно должно лежать внутри онлайн-недели."
        : `Окно должно лежать внутри онлайн-недели: ${span}.`;
    }
    case "window-overlap":
      return context.window === undefined
        ? "Окно пересекается с другим окном, а лоты у них общие. Сдвинь время."
        : `Окно пересекается с окном ${context.window}, а лоты у них общие. Сдвинь время или удали окно ${context.window}.`;
    case "window-step":
      return "Шаг окна не принят: он должен быть больше нуля.";
    case "window-in-past":
      return "Начало окна уже прошло. Запусти окно с текущего момента или с будущего.";
    case "window-not-in-prebidding":
      return "Запуск окна доступен только во время онлайн-торгов.";
    case "window-lot-not-in-auction":
      return `Лот «${context.lot ?? "—"}» не в реестре аукциона.`;
    case "window-lot-not-open":
      return `Лот «${context.lot ?? "—"}» не в торгах: запустить окно на нём нельзя.`;
    case "launch-overlap": {
      const other =
        context.other === undefined
          ? undefined
          : `${formatLocalMoment(communityLocalTime(context.other.from, context.timeZone))} — ${formatLocalMoment(communityLocalTime(context.other.until, context.timeZone))}`;
      return other === undefined
        ? "Окно пересекается с другим окном, а лоты у них общие. Сдвинь время."
        : `Окно пересекается с другим окном по лоту «${context.lot ?? "—"}»: ${other}. Сдвинь время.`;
    }
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

function weekSpan(timeZone: string, week?: AuctionWeek): string | undefined {
  const local = (instant: string) =>
    formatLocalMoment(communityLocalTime(instant, timeZone));
  return week?.opensAt === undefined || week.closesAt === undefined
    ? undefined
    : `${local(week.opensAt)} — ${local(week.closesAt)}`;
}

export const windowPrompt =
  "Окно по времени сообщества: начало и конец через тире, затем шаг в целых рублях через запятую. Окно — внутри недели, шаг — меньше обычного.\nНапример: 21.10.2026 18:00 — 21.10.2026 21:00, 50";

/**
 * Вопрос о запуске окна по ходу торгов (PER-615): начало — «сейчас» или
 * момент, конец — момент, шаг — целыми рублями.
 */
export const launchPrompt =
  "Окно по времени сообщества: начало — «сейчас» или момент, конец — момент, затем шаг в целых рублях через запятую. Окно — внутри онлайн-недели, шаг — меньше обычного.\nНапример: сейчас — 21.10.2026 21:00, 50";

/**
 * Вопрос о новом окне (дизайн-код, «Вопросы»): сроки недели в том же виде, в
 * каком вводят окно, и образец.
 */
export function windowQuestionText(
  timeZone: string,
  week?: AuctionWeek,
): string {
  const span = weekSpan(timeZone, week);
  return [
    ...(span === undefined ? [] : [`Неделя: ${span}`]),
    windowPrompt,
  ].join("\n");
}

/** Вопрос о запуске окна: сроки недели и вид ответа — как у объявленного окна. */
export function launchQuestionText(
  timeZone: string,
  week?: AuctionWeek,
): string {
  const span = weekSpan(timeZone, week);
  return [
    ...(span === undefined ? [] : [`Неделя: ${span}`]),
    launchPrompt,
  ].join("\n");
}

/**
 * Запуск окна по ходу торгов (PER-615): сроки и шаг запускаемого окна, лоты
 * реестра переключателями и ряд запуска. Черновик едет в кнопке: состояния у
 * пульта нет, а лот в кнопку не помещается.
 */
export function launchScreen(view: {
  console: AuctionConsoleView;
  draft: LaunchDraft;
  at: { page: number } | { lot: number };
  timeZone: string;
  today: CommunityDay;
}): ShownScreen {
  const { console, draft } = view;
  const auction = uuidToToken(console.auctionId);
  const lots = launchableLots(console);
  const registry = sortedLots(console);
  const selected = new Set(draft.lots);
  const requested =
    "page" in view.at ? view.at.page : Math.floor(view.at.lot / pageSize);
  const page = paginate(lots, requested);
  const keyboard = new InlineKeyboard();
  const title = pagedTitle("Запуск окна", page);
  for (const entry of page.items) {
    const at = indexOf(lots, entry);
    const on = selected.has(at);
    nextRow(keyboard).text(
      buttonText(toggleLabel(titleOf(entry), on)),
      consoleWindowLaunchLotData(auction, draft, at),
    );
  }
  withPager(keyboard, page, (target) =>
    consoleWindowLaunchPageData(auction, draft, target),
  );
  nextRow(keyboard).text(
    "Запустить окно",
    consoleWindowLaunchGoData(auction, draft),
  );
  const local = (instant: string) =>
    readableMoment(communityLocalTime(instant, view.timeZone), view.today);
  // Начало «сейчас» — момент, в который сервис решил команду, и назвать его
  // нечем: пульт пишет «сейчас».
  const from = draft.from === undefined ? "сейчас" : local(draft.from);
  return {
    id: "step-window-launch",
    text: screenText(
      title,
      escapeHtml(
        `с ${from} до ${local(draft.until)}, шаг ${money(draft.step)}`,
      ),
      escapeHtml("Вкл — лот в окне, Выкл — шаг у лота обычный."),
      escapeHtml(`лотов ${selected.size} из ${lots.length}`),
      // Набор лотов едет в кнопке пульта битовой маской (PER-615): реестр
      // больше окна не накрывает, и пульт говорит об этом прямо.
      registry.length > lots.length
        ? escapeHtml(
            `Окно накрывает первые ${lots.length} лотов реестра — остальные в него не входят.`,
          )
        : undefined,
    ),
    keyboard: withNav(keyboard, toWindows(auction)),
    format: "HTML",
  };
}

// Номер лота в отсортированном реестре: номера лотов запуска едут в кнопке.
function indexOf(lots: readonly ConsoleLot[], entry: ConsoleLot): number {
  return lots.findIndex((each) => each.lot.lotId === entry.lot.lotId);
}

/** Текст кадра отказа пульту; отказ по праву несёт общий текст хаба. */
export const consoleMissingText = "Аукцион не найден. Открой сходку заново.";

/** Отменённая сходка закрыла команды пульта (ADR-047, дополнение 2026-10-12). */
export const consoleMeetupCancelledText =
  "Сходку отменили. Управлять её аукционом больше нельзя.";
