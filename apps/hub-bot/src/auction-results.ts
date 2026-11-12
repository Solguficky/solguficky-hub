import type { AuctionBlock, Money } from "./auction-ui/index.js";

// Итоги завершённого аукциона для участника (PER-813): что продано, кому и за
// сколько. Тексты общие у двух оболочек.
export const auctionResultsButtonLabel = "Итоги";
export const auctionResultsTitle = "Итоги аукциона";
export const auctionResultsNoSales = "Ничего не продано.";
const untitled = "Лот без названия";

type ResultsBlock = Extract<AuctionBlock, { kind: "auction-results" }>;

export function auctionResultsParagraphs(
  block: ResultsBlock,
  options: { money: (amount: Money) => string },
): string[] {
  const soldCount = block.sold.length + (block.hiddenSold ?? 0);
  if (soldCount === 0) {
    return [
      auctionResultsNoSales,
      ...(block.unsoldCount === 0
        ? []
        : [`Лотов без продажи: ${block.unsoldCount}.`]),
    ];
  }
  const summary = [
    `Продано лотов: ${soldCount}${block.total === undefined ? "" : ` на ${options.money(block.total)}`}.`,
    ...(block.unsoldCount === 0 ? [] : [`Без продажи: ${block.unsoldCount}.`]),
  ].join(" ");
  const lines = block.sold.map((lot) => {
    const title = escapeHtml(shorten(lot.title?.trim() || untitled));
    const buyer = lot.mine
      ? "<b>ты</b>"
      : lot.winnerName === undefined
        ? "покупатель определён"
        : escapeHtml(lot.winnerName);
    return `• «${title}» — ${options.money(lot.price)}, ${buyer}`;
  });
  const hidden =
    block.hiddenSold === undefined
      ? []
      : [`…и ещё лотов: ${block.hiddenSold}.`];
  return [summary, lines.join("\n"), ...hidden];
}

// Название лота Auction не ограничивает, а сообщение Telegram — да: тридцать
// строк с длинными названиями не должны его переполнить.
const TITLE_LIMIT = 60;

function shorten(title: string): string {
  return title.length <= TITLE_LIMIT
    ? title
    : `${title.slice(0, TITLE_LIMIT - 1)}…`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
