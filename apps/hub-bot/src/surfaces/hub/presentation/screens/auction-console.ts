import { InlineKeyboard } from "grammy";
import type { LotStatusView } from "../../../../auction-ui/index.js";
import {
  acceptsLots,
  activeLot,
  windowLimit,
  windowPrint,
} from "../../application/auction-console.js";
import { formatLocalMoment } from "../../application/meetup-form.js";
import type {
  AuctionConsoleView,
  AuctionWeek,
  ConsoleLot,
  ConsoleNote,
  ConsoleSort,
  ConsoleSortMetric,
  FinalAskError,
  LotAmount,
  RaffleAskError,
  StepWindow,
  WeekAskError,
  WindowAskError,
  WindowNote,
  WindowRef,
} from "../../application/types.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleAskData,
  consoleCloseConfirmData,
  consoleCloseData,
  consoleConfirmData,
  consoleDiscardConfirmData,
  consoleDiscardData,
  consoleFinalData,
  consoleMarkData,
  consoleNextLotData,
  consoleOpenData,
  consoleRaffleData,
  consoleRaffleRemoveData,
  consoleStartFinalData,
  consoleViewData,
  consoleWeekData,
  consoleWindowAskData,
  consoleWindowData,
  consoleWindowLotData,
  consoleWindowRemoveData,
  consoleWindowsData,
  defaultConsoleSort,
} from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  pagedTitle,
  pageSize,
  paginate,
  readableMoment,
  removeLabel,
  screenText,
  toAuctionRoot,
  toggleLabel,
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
  page: number;
  sort: ConsoleSort;
  timeZone: string;
  today: CommunityDay;
};

export const consoleNoteText: Record<ConsoleNote, string> = {
  "week-saved": "Сроки недели сохранены.",
  "week-opened": "Онлайн-неделя открыта. Лоты принимают ставки.",
  "week-already-open": "Неделя уже открыта.",
  "week-not-scheduled":
    "Сначала задай сроки недели. Без них неделю не открыть.",
  "week-frozen":
    "Онлайн-неделя уже открыта. Сроки, финал, счастливые часы и розыгрыш больше не меняются.",
  "week-needed": "Сначала задай сроки недели.",
  "raffle-saved": "Момент розыгрыша сохранён.",
  "raffle-removed": "Розыгрыш убран. Неделя пройдёт без него.",
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

// Окна видны в снимке пульта строкой (PER-504); сами окна — на своём экране.
function windowsLines(week: AuctionWeek): string[] {
  return week.windows.length === 0
    ? []
    : [`Счастливые часы: ${windowsLabel(week.windows.length)}.`];
}

// Розыгрыш (PER-593) виден строкой всегда: без момента у участников нет
// кнопки «Розыгрыш», и администратор видит почему.
function raffleLine(week: AuctionWeek, view: ConsoleScreenView): string {
  return week.raffleClosesAt === undefined
    ? "Розыгрыш: нет."
    : `Розыгрыш: регистрация до ${moment(week.raffleClosesAt, view)}.`;
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
        : [
            weekLine(week, view),
            finalLine(week),
            ...windowsLines(week),
            raffleLine(week, view),
          ];
    case "prebidding":
      return [
        week?.closesAt === undefined
          ? "Идут онлайн-торги."
          : `Идут онлайн-торги до ${moment(week.closesAt, view)}.`,
        ...(week === undefined
          ? []
          : [finalLine(week), ...windowsLines(week), raffleLine(week, view)]),
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

// Финал ведущего (PER-337): у замороженного состава и в финале пульт
// показывает состав в порядке выхода, а не реестр, и торги текущего лота.
function inFinal(console: AuctionConsoleView): boolean {
  return console.status === "lineup-frozen" || console.status === "final";
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
  nextRow(keyboard).text("Обновить", consoleViewData(auction));
  const trading = tradingLines(console);
  return {
    id: "auction-console",
    text: screenText(
      "Пульт",
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

/** «1 лот», «3 лота», «12 лотов». */
function lotsLabel(count: number): string {
  return counted(count, ["лот", "лота", "лотов"]);
}

/** «1 окно», «3 окна», «5 окон». */
function windowsLabel(count: number): string {
  return counted(count, ["окно", "окна", "окон"]);
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
    return {
      id: "outcome",
      text: outcomeText(consoleNoteText[view.note]),
      keyboard: withNav(new InlineKeyboard(), {
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
    nextRow(keyboard).text("Счастливые часы", consoleWindowsData(auction));
    nextRow(keyboard).text("Розыгрыш", consoleRaffleData(auction));
    if (week.raffleClosesAt !== undefined) {
      nextRow(keyboard).text(
        removeLabel("Убрать розыгрыш"),
        consoleRaffleRemoveData(auction),
      );
    }
    nextRow(keyboard).text("Открыть онлайн-неделю", consoleOpenData(auction));
  } else if (
    console.status === "prebidding" &&
    (week?.windows.length ?? 0) > 0
  ) {
    // После открытия окна только видны: править их уже нельзя.
    nextRow(keyboard).text("Счастливые часы", consoleWindowsData(auction));
  }
  if (editable) {
    nextRow(keyboard).text(
      removeLabel("Удалить аукцион"),
      consoleDiscardData(auction),
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
      statusLines(view).map(escapeHtml).join("\n"),
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
}): ShownScreen {
  const auction = uuidToToken(confirm.console.auctionId);
  const closesAt = confirm.console.week?.closesAt;
  const view = { ...confirm, page: 0, sort: defaultConsoleSort };
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
  changed?: true | undefined;
}): ShownScreen {
  const auction = uuidToToken(confirm.auctionId);
  const title = truncate(confirm.title ?? untitled, titleLimit);
  const buyer =
    confirm.leaderName === undefined
      ? ""
      : `, покупатель — ${confirm.leaderName}`;
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
    | { kind: "sold"; price: LotAmount; buyerName?: string | undefined }
    | { kind: "unsold" };
}): ShownScreen {
  const { closure } = closed;
  const buyer =
    closure.kind === "sold" && closure.buyerName !== undefined
      ? `, покупатель — ${closure.buyerName}`
      : "";
  return {
    id: "outcome",
    text: outcomeText(
      closure.kind === "sold"
        ? `Лот продан. Цена: ${money(closure.price)}${buyer}.`
        : "Лот закрыт без продажи. Ставок не было.",
      truncate(closed.title ?? untitled, titleLimit),
    ),
    keyboard: withNav(new InlineKeyboard(), {
      name: "Пульт",
      data: consoleViewData(uuidToToken(closed.auctionId)),
    }),
    format: "HTML",
  };
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
 * Вопрос о следующей цене лота финала: лот, текущая следующая цена и образец.
 * Ставка зала после ответа принимается ровно на эту цену (ADR-049).
 */
export function finalAskText(ask: {
  title?: string | undefined;
  nextPrice?: LotAmount | undefined;
}): string {
  return [
    `Лот: ${truncate(ask.title ?? untitled, titleLimit)}`,
    ...(ask.nextPrice === undefined
      ? []
      : [`Сейчас следующая цена: ${money(ask.nextPrice)}`]),
    "Новая следующая цена в целых рублях, выше текущей. Например: 5000",
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

export function windowNoteText(note: WindowNote): string {
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
      text: outcomeText(windowNoteText(view.note)),
      keyboard: withNav(new InlineKeyboard(), toWindows(auction)),
      format: "HTML",
    };
  }
  const windows = windowsOf(console);
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

/** Текст кадра отказа пульту; отказ по праву несёт общий текст хаба. */
export const consoleMissingText = "Аукцион не найден. Открой сходку заново.";
