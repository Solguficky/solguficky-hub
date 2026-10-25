import type { AuctionBlock, Money } from "./auction-ui/index.js";
import { truncate } from "./core/format.js";

// Хроники дня (PER-725): тексты «Спорнее всех», «Тёмной лошадки» и «Эпичной
// дуэли», общие у сводки дня пульта хаба и у экрана участника в обоих ботах.
// Выбор лотов — `dayNominations` аукционного дерева; здесь только слова.

export const dayChronicleButtonLabel = "Хроники дня";
export const dayChronicleTitle = "Хроники дня";
export const dayChronicleWindow = "За последние сутки.";
export const dayChronicleNoLots = "Лотов в аукционе пока нет.";
export const dayChronicleNoBids = "За последние сутки ставок не было.";
export const dayChronicleNoNominee =
  "За сутки ни один лот не набрал на номинацию.";

export const contestedName = "Спорнее всех:";
export const darkHorseName = "Тёмная лошадка:";
export const duelName = "Эпичная дуэль:";

const untitled = "Лот без названия";
const titleLimit = 120;

/** «3 смены лидера». */
export function contestedTail(leaderChanges: number): string {
  return `${counted(leaderChanges, ["смена", "смены", "смен"])} лидера`;
}

/**
 * «+500 ₽ от старта, 2 ставки до этого дня». Окно называет вызывающий: сводка
 * пульта считает день сообщества, а хроники участника — последние сутки.
 */
export function darkHorseTail(
  priceGrowth: Money,
  bidsBefore: number,
  options: { money: (amount: Money) => string; window: "day" | "last-day" },
): string {
  const before =
    bidsBefore === 0
      ? "нет ставок"
      : counted(bidsBefore, ["ставка", "ставки", "ставок"]);
  const until = options.window === "day" ? "до этого дня" : "до этих суток";
  return `+${options.money(priceGrowth)} от старта, ${before} ${until}`;
}

/** «5 перебиваний подряд вдвоём». */
export function duelTail(longestDuel: number): string {
  return `${counted(longestDuel, ["перебивание", "перебивания", "перебиваний"])} подряд вдвоём`;
}

type ChronicleBlock = Extract<AuctionBlock, { kind: "day-chronicle" }>;

/** Абзацы экрана участника: окно и номинации, пустой раздел выпадает. */
export function dayChronicleParagraphs(
  block: ChronicleBlock,
  options: { money: (amount: Money) => string },
): string[] {
  const { chronicle } = block;
  switch (chronicle.kind) {
    case "no-lots":
      return [dayChronicleNoLots];
    case "no-bids":
      return [dayChronicleNoBids];
    case "nominated": {
      const { contested, darkHorse, duel } = chronicle;
      const sections = [
        contested === undefined
          ? undefined
          : section(
              contestedName,
              contested.title,
              contestedTail(contested.leaderChanges),
            ),
        darkHorse === undefined
          ? undefined
          : section(
              darkHorseName,
              darkHorse.title,
              darkHorseTail(darkHorse.priceGrowth, darkHorse.bidsBefore, {
                ...options,
                window: "last-day",
              }),
            ),
        duel === undefined
          ? undefined
          : section(duelName, duel.title, duelTail(duel.longestDuel)),
      ].filter((paragraph) => paragraph !== undefined);
      return [
        dayChronicleWindow,
        ...(sections.length === 0 ? [dayChronicleNoNominee] : sections),
      ];
    }
    default: {
      const _exhaustive: never = chronicle;
      return _exhaustive;
    }
  }
}

function section(name: string, title: string | undefined, tail: string) {
  return `${name}\n• «${escapeHtml(truncate(title ?? untitled, titleLimit))}» — ${escapeHtml(tail)}`;
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

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
