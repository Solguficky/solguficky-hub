import type {
  AuctionBlock,
  AuctionStepWindowView,
} from "./auction-ui/index.js";

// Программа недели (PER-724; решение владельца 26.10.2026) — короткий абзац
// текста корня аукциона, общий у обоих ботов, как FAQ: «Счастливые часы»
// сегодня и ближайшие, момент розыгрыша, общий дедлайн онлайн-этапа и
// ориентировочное время финала. Своего экрана у неё нет. Данные несёт тело
// корня, а часы и формат момента — оболочка: в аукционном дереве часов нет.

export const programmeTitle = "Программа недели";

// Окон в абзаце не больше: программа — подсказка, а не расписание. Остальные
// окна недели называются числом.
export const PROGRAMME_WINDOWS = 3;

type RootBlock = Extract<AuctionBlock, { kind: "root" }>;

export type ProgrammeOptions = {
  // Момент RFC 3339 для чтения в поясе сообщества: «27 октября, вт, 18:00».
  moment: (instant: string) => string;
  timeZone: string;
  now: Date;
};

/**
 * Абзац программы с заголовком жирным или `undefined`, когда рассказать
 * нечего: торги онлайн-недели прошли, а финал без анонса. Окна и дедлайн —
 * пока онлайн-неделя впереди или идёт, розыгрыш — пока регистрация открыта,
 * финал — пока он не начался и у него есть ориентировочное время.
 */
export function programmeParagraph(
  root: RootBlock,
  options: ProgrammeOptions,
): string | undefined {
  const { auction } = root;
  if (auction === undefined) return undefined;
  const now = options.now.getTime();
  const ahead = (instant: string) => Date.parse(instant) > now;
  const online =
    auction.stage === "scheduled" || auction.stage === "prebidding";
  const lines = [
    ...(online ? windowLines(auction.stepWindows ?? [], options) : []),
    ...(root.raffleClosesAt !== undefined &&
    ahead(root.raffleClosesAt) &&
    auction.stage !== "cancelled"
      ? [`Розыгрыш: ${options.moment(root.raffleClosesAt)}`]
      : []),
    ...(online && auction.closesAt !== undefined && ahead(auction.closesAt)
      ? [`Онлайн-торги до ${options.moment(auction.closesAt)}`]
      : []),
    ...(auction.final &&
    auction.finalAt !== undefined &&
    finalAhead.has(auction.stage)
      ? [`Финал: ориентировочно ${options.moment(auction.finalAt)}`]
      : []),
  ];
  if (lines.length === 0) return undefined;
  return [`<b>${programmeTitle}</b>`, ...lines].join("\n");
}

const finalAhead: ReadonlySet<string> = new Set([
  "draft",
  "scheduled",
  "prebidding",
  "settling",
  "on-break",
  "lineup-frozen",
]);

// Сегодняшние окна — идущее и те, что начнутся до конца дня сообщества, — и
// одно ближайшее после них; без сегодняшних — только ближайшее.
function windowLines(
  windows: readonly AuctionStepWindowView[],
  options: ProgrammeOptions,
): string[] {
  const now = options.now.getTime();
  const upcoming = windows
    .filter((window) => Date.parse(window.until) > now)
    .sort((left, right) => Date.parse(left.from) - Date.parse(right.from));
  const today = dayOf(options.now.toISOString(), options.timeZone);
  const todays = upcoming.filter(
    (window) => dayOf(window.from, options.timeZone) <= today,
  );
  const shown = upcoming.slice(
    0,
    Math.min(PROGRAMME_WINDOWS, todays.length + 1),
  );
  const rest = upcoming.length - shown.length;
  return [
    ...shown.map((window) => windowLine(window, options)),
    ...(rest === 0 ? [] : [`Ещё счастливых часов на неделе: ${rest}`]),
  ];
}

function windowLine(
  window: AuctionStepWindowView,
  options: ProgrammeOptions,
): string {
  const lots = counted(window.lotIds.length, ["лот", "лота", "лотов"]);
  if (Date.parse(window.from) <= options.now.getTime()) {
    return `Счастливые часы: сейчас, до ${timeOf(window.until, options.timeZone)} — ${lots}`;
  }
  const sameDay =
    dayOf(window.from, options.timeZone) ===
    dayOf(window.until, options.timeZone);
  const until = sameDay
    ? timeOf(window.until, options.timeZone)
    : options.moment(window.until);
  return `Счастливые часы: ${options.moment(window.from)}–${until} — ${lots}`;
}

// День сообщества строкой «ГГГГ-ММ-ДД»: такие строки сравниваются по порядку.
function dayOf(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

// «20:00» в поясе сообщества.
function timeOf(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
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
