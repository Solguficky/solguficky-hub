import { InlineKeyboard } from "grammy";
import {
  contestedName,
  contestedTail,
  darkHorseName,
  darkHorseTail,
  duelName,
  duelTail,
} from "../../../../auction-day-chronicle.js";
import { biggestBy, dayNominations } from "../../../../auction-ui/index.js";
import { money, truncate } from "../../../../core/format.js";
import type { DaySummaryLot } from "../../application/types.js";
import type { CommunityDay } from "../../community-time.js";
import { lotStartLink } from "../lot-deep-link.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { consoleViewData } from "../parse-callback.js";
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
// Номинации и их подписи — общие с «Хрониками дня» участника (PER-725):
// `dayNominations` аукционного дерева и `auction-day-chronicle.ts`.

const topLimit = 3;
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
  const { contested, darkHorse, duel } = dayNominations(view.lots);
  const growth = biggestBy(
    traded.filter((lot) => minor(lot.growth) > 0),
    (lot) => minor(lot.growth),
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
              contestedName,
              contested === undefined
                ? []
                : [line(contested, contestedTail(contested.leaderChanges))],
            ),
            section(
              "Больше всех выросла цена:",
              growth?.growth === undefined
                ? []
                : [line(growth, `+${money(growth.growth)}`)],
            ),
            section(
              darkHorseName,
              darkHorse?.priceGrowth === undefined
                ? []
                : [
                    line(
                      darkHorse,
                      darkHorseTail(
                        darkHorse.priceGrowth,
                        darkHorse.bidsBefore,
                        { money, window: "day" },
                      ),
                    ),
                  ],
            ),
            section(
              duelName,
              duel === undefined
                ? []
                : [line(duel, duelTail(duel.longestDuel))],
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
