import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, FavoritesPort, Viewer } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import { hasRaffle } from "./open-feed.js";

// Корень аукциона (PER-605; ADR-064, дополнение 2026-10-12): стадия и сроки,
// вход в лоты, пока Auction его отдаёт, — в розыгрыш и, у процесса с
// Notifications, в избранное. Корень один у двух ботов (PER-644, решение
// владельца по прогону 14 октября 2026 года): лента, розыгрыш и избранное
// возвращают в него. Остальные ряды — правила, пульт и возврат — ставит
// оболочка поверхности.
//
// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Отказ чтения аукциона бросается, как у ленты; отказ чтения розыгрыша убирает
// его кнопку, а не роняет корень.
export async function openRoot(input: {
  auction: AuctionPort;
  favorites?: FavoritesPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<AuctionScreenBody> {
  const raffleRead = hasRaffle(input);
  const auction = await input.auction.getAuction({
    viewer: input.viewer,
    auctionId: input.auctionId,
  });
  const raffle = await raffleRead;
  if (auction === undefined) {
    return {
      blocks: [{ kind: "root", auctionId: input.auctionId }],
      keyboard: [],
    };
  }
  return {
    blocks: [{ kind: "root", auctionId: input.auctionId, auction }],
    keyboard: [
      [
        {
          action: "root.lots",
          callbackData: encodeAuctionCallback({
            kind: "feed",
            auctionId: input.auctionId,
            page: 0,
          }),
        },
      ],
      ...(raffle
        ? [
            [
              {
                action: "root.raffle" as const,
                callbackData: encodeAuctionCallback({
                  kind: "raffle",
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]
        : []),
      // Вход в избранное — только отсюда (PER-644): не из «Настроек» и не из
      // меню бота. Список общий на все аукционы, аукцион в кнопке — возврат.
      ...(input.favorites === undefined
        ? []
        : [
            [
              {
                action: "root.favorites" as const,
                callbackData: encodeAuctionCallback({
                  kind: "favorites",
                  page: 0,
                  auctionId: input.auctionId,
                }),
              },
            ],
          ]),
    ],
  };
}
