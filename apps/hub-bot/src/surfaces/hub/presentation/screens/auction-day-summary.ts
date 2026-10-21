import { InlineKeyboard } from "grammy";
import { money, truncate } from "../../../../core/format.js";
import type { DaySummaryLot } from "../../application/types.js";
import type { CommunityDay } from "../../community-time.js";
import { lotStartLink } from "../lot-deep-link.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { consoleViewData } from "../parse-callback.js";
import { bidsLabel, counted } from "./auction-console.js";
import { bullet, escapeHtml, readableDay, screenText, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Сводка дня торгов (PER-492): метрики окна суток и текст, готовый к
// пересылке в чат. Нарративные метрики P-15 RFC-007 — самый оспариваемый лот по
// сменам лидера, «тёмная лошадка» и «эпичная дуэль» — добавил PER-511.
//
// Ссылка на лот — deep link бота аукциона `l_<токен>`: клавиатура при пересылке теряется, поэтому лот называется ссылкой в самом
// тексте, а не кнопкой. В группу бот не пишет — текст публикует организатор
// (R-4 RFC-007).
//
// Строки отбирает экран, а не Auction: тот отдаёт агрегаты всего реестра без
// значимого порядка, как и статистику недели. Валюту лот несёт свою, и сводка
// не пересчитывает суммы между лотами — так же, как сортировка пульта.

const topLimit = 3;
// «Тёмная лошадка» — лот, у которого до суток было не больше стольких ставок,
// а за сутки ему ставили; из таких — с наибольшим ростом от стартовой цены.
const darkHorseMaxBidsBefore = 3;
// «Эпичная дуэль» — не меньше стольких смен лидера подряд между одними и теми
// же двумя людьми: A, B, A, B, A.
const duelMinChanges = 4;
const titleLimit = 120;
const untitled = "Лот без названия";

export type DaySummaryScreenView = {
  auctionId: string;
  // День, за который собрана сводка, и сегодняшний день сообщества: по нему
  // подпись называет чужой год.
  day: CommunityDay;
  today: CommunityDay;
  lots: readonly DaySummaryLot[];
  // Имя бота аукциона из конфигурации: без него ссылок на лоты нет.
  auctionBotUsername?: string;
};

export function daySummaryScreen(view: DaySummaryScreenView): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const traded = view.lots.filter((lot) => lot.bidCount > 0);
  const priced = traded.filter((lot) => lot.maxPrice !== undefined);
  const top = [...priced]
    .sort((left, right) => minor(right.maxPrice) - minor(left.maxPrice))
    .slice(0, topLimit);
  const contested = biggest(
    traded.filter((lot) => lot.leaderChanges > 0),
    (lot) => lot.leaderChanges,
  );
  const growth = biggest(
    traded.filter((lot) => minor(lot.growth) > 0),
    (lot) => minor(lot.growth),
  );
  const darkHorse = biggest(
    traded.filter(
      (lot) =>
        lot.bidsBefore <= darkHorseMaxBidsBefore && minor(lot.priceGrowth) > 0,
    ),
    (lot) => minor(lot.priceGrowth),
  );
  const duel = biggest(
    traded.filter((lot) => lot.longestDuel >= duelMinChanges),
    (lot) => lot.longestDuel,
  );

  const line = (lot: DaySummaryLot, tail: string): string => {
    const title = escapeHtml(truncate(lot.title ?? untitled, titleLimit));
    const link = hrefOf(lot, view);
    const name =
      link === undefined ? title : `<a href="${escapeHtml(link)}">${title}</a>`;
    return bullet(`${name} — ${escapeHtml(tail)}`);
  };

  return {
    id: "day-summary",
    text: screenText(
      "Сводка дня",
      escapeHtml(readableDay(view.day, view.today)),
      ...(traded.length === 0
        ? [
            escapeHtml(
              // Пустой реестр и сутки без ставок — разные вещи: «ставок не
              // было» про аукцион без лотов сказало бы лишнее.
              view.lots.length === 0
                ? "Лотов в аукционе пока нет."
                : "Ставок не было.",
            ),
          ]
        : [
            section(
              "Новые максимумы цены:",
              top.flatMap((lot) =>
                lot.maxPrice === undefined
                  ? []
                  : [line(lot, money(lot.maxPrice))],
              ),
            ),
            section(
              "Спорнее всех:",
              contested === undefined
                ? []
                : [
                    line(
                      contested,
                      leaderChangesLabel(contested.leaderChanges),
                    ),
                  ],
            ),
            section(
              "Больше всех выросла цена:",
              growth?.growth === undefined
                ? []
                : [line(growth, `+${money(growth.growth)}`)],
            ),
            section(
              "Тёмная лошадка:",
              darkHorse?.priceGrowth === undefined
                ? []
                : [
                    line(
                      darkHorse,
                      `+${money(darkHorse.priceGrowth)} от старта, ${bidsLabel(darkHorse.bidsBefore)} до этого дня`,
                    ),
                  ],
            ),
            section(
              "Эпичная дуэль:",
              duel === undefined
                ? []
                : [
                    line(
                      duel,
                      `${counted(duel.longestDuel, ["перебивание", "перебивания", "перебиваний"])} подряд вдвоём`,
                    ),
                  ],
            ),
          ]),
    ),
    keyboard: withNav(new InlineKeyboard(), {
      name: "Пульт",
      data: consoleViewData(auction),
    }),
    format: "HTML",
  };
}

// «3 смены лидера» — тем же склонением, что число ставок пульта.
function leaderChangesLabel(count: number): string {
  return `${counted(count, ["смена", "смены", "смен"])} лидера`;
}

// Раздел сводки — имя строкой и строки под ним; пустой раздел выпадает, а не
// оставляет заголовок без содержимого.
function section(name: string, lines: readonly string[]): string | undefined {
  return lines.length === 0 ? undefined : [name, ...lines].join("\n");
}

function hrefOf(
  lot: DaySummaryLot,
  view: DaySummaryScreenView,
): string | undefined {
  return view.auctionBotUsername === undefined
    ? undefined
    : lotStartLink(view.auctionBotUsername, lot.lotId);
}

function minor(amount: { minorUnits: number } | undefined): number {
  return amount?.minorUnits ?? 0;
}

/** Лот с наибольшим значением метрики; равные не переставляются. */
function biggest(
  lots: readonly DaySummaryLot[],
  metric: (lot: DaySummaryLot) => number,
): DaySummaryLot | undefined {
  let best: DaySummaryLot | undefined;
  for (const lot of lots) {
    if (best === undefined || metric(lot) > metric(best)) best = lot;
  }
  return best;
}
