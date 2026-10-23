import { InlineKeyboard } from "grammy";
import type {
  AuctionStageView,
  AuctionSummaryView,
} from "../../../../auction-ui/index.js";
import { marked, pictogram } from "../../../../core/pictograms.js";
import type { CommunityDay } from "../../community-time.js";
import { auctionStateLine } from "./auction-stage.js";
import {
  auctionRootData,
  escapeHtml,
  nextRow,
  screenText,
  toMenu,
  viaEvents,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Раздел «События» (PER-669; решение владельца по отзыву тестовой группы
// 19 октября 2026 года): идущие события расширений сходок. Ядро не знает, что
// за событие: расширение отдаёт строку о нём и вход. Сегодня событие одно —
// аукцион от открытия онлайн-торгов до конца финала. Сходку строка не
// называет: Auction её не отдаёт («a list must not lead from an auction to its
// meetup»).

/** Идущее событие расширения: аукцион и его снимок для строки. */
export type HubEvent = {
  kind: "auction";
  auctionId: string;
  auction: AuctionSummaryView;
};

// Аукцион — событие, пока в нём есть что делать: онлайн-торги, итоги, перерыв
// и финал. Черновик и запланированный ещё не идут, завершённый уже прошёл.
const eventStages: ReadonlySet<AuctionStageView> = new Set([
  "prebidding",
  "settling",
  "on-break",
  "lineup-frozen",
  "in-final",
]);

/** Идёт ли аукцион как событие сообщества. */
export function isAuctionEvent(auction: AuctionSummaryView): boolean {
  return eventStages.has(auction.stage);
}

export const eventsTitle = "События";
const noEventsText = "Сейчас не идут события, привязанные к сходкам.";
const auctionEventLabel = marked(pictogram.auction, "Аукцион");

/** Строки событий: в «Событиях» и в тексте меню — одни и те же. */
export function eventLines(
  events: readonly HubEvent[],
  timeZone: string,
  today: CommunityDay,
): string[] {
  return events.map((event) =>
    auctionStateLine(event.auction, timeZone, today),
  );
}

/**
 * «События» — раздел под меню: строки идущих событий и вход в каждое; без
 * событий — одна строка о том, что их нет, и «‹ Меню». Вход в аукцион несёт
 * отметку «Событий»: его корень возвращает сюда.
 */
export function eventsScreen(
  events: readonly HubEvent[],
  timeZone: string,
  today: CommunityDay,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  for (const event of events) {
    nextRow(keyboard).text(
      auctionEventLabel,
      viaEvents(auctionRootData(event.auctionId)),
    );
  }
  const lines = eventLines(events, timeZone, today);
  return {
    id: "events",
    text: screenText(
      eventsTitle,
      lines.length === 0
        ? noEventsText
        : lines.map((line) => escapeHtml(line)).join("\n"),
    ),
    keyboard: withNav(keyboard, toMenu),
    format: "HTML",
  };
}
