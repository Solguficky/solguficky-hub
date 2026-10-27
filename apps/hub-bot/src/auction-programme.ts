import type {
  AuctionBlock,
  AuctionStepWindowView,
  AuctionSummaryView,
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
 * финал — пока он не начался и его ориентировочное время впереди.
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
    ahead(auction.finalAt) &&
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

// Строка состояния аукциона (PER-767; постановка согласована владельцем
// 27.10.2026) — пассивная реклама недели в меню и «Событиях» хаба и в
// «Аукционах» бота аукциона: «день 4 из 7 · 🔥 Счастливые часы до 22:00 ·
// розыгрыш: регистрация до 30.10». Данные — та же сводка, что у программы, без
// своих чтений. Части, которых нет, пропадают, а не пустеют.

/** Поля сводки, из которых складывается строка состояния. */
export type AuctionWeekFacts = Pick<
  AuctionSummaryView,
  "stage" | "opensAt" | "closesAt" | "stepWindows" | "raffleClosesAt"
>;

export type StatusLineOptions = { timeZone: string; now: Date };

/**
 * Строка состояния или `undefined`, когда сказать нечего. День недели — пока
 * идут онлайн-торги; «Счастливые часы» — идущее окно или ближайшее, пока
 * онлайн-неделя впереди или идёт; розыгрыш — пока идут торги и регистрация
 * открыта. С итогов онлайн-торгов строки нет: финал строка не рекламирует.
 */
export function auctionStatusLine(
  auction: AuctionWeekFacts,
  options: StatusLineOptions,
): string | undefined {
  const now = options.now.getTime();
  const trading = auction.stage === "prebidding";
  const online = trading || auction.stage === "scheduled";
  const parts = [
    ...(trading ? weekDayPart(auction, options) : []),
    ...(online ? windowPart(auction.stepWindows ?? [], options) : []),
    ...(trading &&
    auction.raffleClosesAt !== undefined &&
    Date.parse(auction.raffleClosesAt) > now
      ? [
          `розыгрыш: регистрация до ${shortMoment(auction.raffleClosesAt, options)}`,
        ]
      : []),
  ];
  return parts.length === 0 ? undefined : parts.join(" · ");
}

// «день 4 из 7» — сутки от открытия онлайн-торгов, а не календарные дни:
// неделя, открытая в понедельник в 18:00 и закрытая в следующий понедельник
// в 18:00, — семь дней, а не восемь. Неполные последние сутки — тоже день.
function weekDayPart(
  auction: AuctionWeekFacts,
  options: StatusLineOptions,
): string[] {
  if (auction.opensAt === undefined || auction.closesAt === undefined) {
    return [];
  }
  const now = options.now.getTime();
  const opens = Date.parse(auction.opensAt);
  const closes = Date.parse(auction.closesAt);
  if (now < opens || now >= closes) return [];
  const total = Math.ceil((closes - opens) / DAY_MS);
  const current = Math.floor((now - opens) / DAY_MS) + 1;
  return [`день ${current} из ${total}`];
}

const DAY_MS = 86_400_000;

// Идущее окно — «до 22:00»; иначе ближайшее — «сегодня с 18:00» или «30.10 с
// 18:00».
function windowPart(
  windows: readonly AuctionStepWindowView[],
  options: StatusLineOptions,
): string[] {
  const now = options.now.getTime();
  const upcoming = windows
    .filter((window) => Date.parse(window.until) > now)
    .sort((left, right) => Date.parse(left.from) - Date.parse(right.from));
  const running = upcoming.find((window) => Date.parse(window.from) <= now);
  if (running !== undefined) {
    // Окно через полночь называет и дату конца: «до 31.10 02:00».
    const until = timeOf(running.until, options.timeZone);
    return [
      `🔥 Счастливые часы до ${
        isToday(running.until, options)
          ? until
          : `${shortDay(running.until, options.timeZone)} ${until}`
      }`,
    ];
  }
  const [next] = upcoming;
  if (next === undefined) return [];
  return [
    `🔥 Счастливые часы ${
      isToday(next.from, options)
        ? "сегодня"
        : shortDay(next.from, options.timeZone)
    } с ${timeOf(next.from, options.timeZone)}`,
  ];
}

// Момент короче, чем в корне: сегодня — время «22:00», в другой день — дата
// «30.10».
function shortMoment(instant: string, options: StatusLineOptions): string {
  return isToday(instant, options)
    ? timeOf(instant, options.timeZone)
    : shortDay(instant, options.timeZone);
}

function isToday(instant: string, options: StatusLineOptions): boolean {
  return (
    dayOf(instant, options.timeZone) ===
    dayOf(options.now.toISOString(), options.timeZone)
  );
}

// «30.10» в поясе сообщества.
function shortDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(instant));
}

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
  const running = Date.parse(window.from) <= options.now.getTime();
  // Конец в другой день сообщества называется моментом целиком.
  const start = running ? options.now.toISOString() : window.from;
  const until =
    dayOf(start, options.timeZone) === dayOf(window.until, options.timeZone)
      ? timeOf(window.until, options.timeZone)
      : options.moment(window.until);
  return running
    ? `Счастливые часы: сейчас, до ${until} — ${lots}`
    : `Счастливые часы: ${options.moment(window.from)}–${until} — ${lots}`;
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
