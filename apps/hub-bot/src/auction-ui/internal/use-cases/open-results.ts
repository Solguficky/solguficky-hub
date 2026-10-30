import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, Money, Viewer } from "../../ports.js";
import type { AuctionResultLot, AuctionScreenBody } from "../../screen.js";
import { namesOf } from "./names.js";
import { loadFeed } from "./open-feed.js";

// Проданных лотов на экране итогов: дороже всех первыми, остальные числом.
// Предел держит длину сообщения Telegram.
export const RESULTS_SHOWN = 30;

// Итоги завершённого аукциона (PER-813): что продано, кому и за сколько.
// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Имена покупателей — подсказка: отказ `GetDisplayNames` оставляет цены без
// имён. Аукцион, которого Auction не отдаёт, показывает те же итоги по ленте:
// она пуста, и экран говорит, что продаж нет.
export async function openAuctionResults(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<AuctionScreenBody> {
  const lots = await loadFeed(input);
  const sold = lots
    .flatMap((lot) =>
      lot.status.kind === "sold"
        ? [
            {
              lotId: lot.lotId,
              ...(lot.card === undefined ? {} : { title: lot.card.title }),
              price: lot.status.price,
              winnerId: lot.status.winnerId,
            },
          ]
        : [],
    )
    .sort(
      (a, b) =>
        b.price.minorUnits - a.price.minorUnits ||
        (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0),
    );
  const shown = sold.slice(0, RESULTS_SHOWN);
  const names = await namesOf({
    auction: input.auction,
    viewer: input.viewer,
    auctionId: input.auctionId,
    participantIds: shown.map((lot) => lot.winnerId),
  });
  const items: AuctionResultLot[] = shown.map((lot) => {
    const winnerName = names[lot.winnerId];
    return {
      lotId: lot.lotId,
      ...(lot.title === undefined ? {} : { title: lot.title }),
      price: lot.price,
      ...(winnerName === undefined ? {} : { winnerName }),
      mine: lot.winnerId === input.viewer.identityId,
    };
  });
  const total = totalOf(sold.map((lot) => lot.price));
  return {
    blocks: [
      {
        kind: "auction-results",
        auctionId: input.auctionId,
        sold: items,
        ...(sold.length > shown.length
          ? { hiddenSold: sold.length - shown.length }
          : {}),
        unsoldCount: lots.filter((lot) => lot.status.kind === "unsold").length,
        ...(total === undefined ? {} : { total }),
      },
    ],
    keyboard: [
      [
        {
          action: "results.back",
          callbackData: encodeAuctionCallback({
            kind: "root",
            auctionId: input.auctionId,
          }),
        },
      ],
    ],
  };
}

// Валюта у платформы одна; чужая в списке — сбой данных, и сумма не называется.
function totalOf(prices: readonly Money[]): Money | undefined {
  const first = prices[0];
  if (first === undefined) return undefined;
  if (prices.some((price) => price.currency !== first.currency)) {
    return undefined;
  }
  return {
    minorUnits: prices.reduce((sum, price) => sum + price.minorUnits, 0),
    currency: first.currency,
  };
}
