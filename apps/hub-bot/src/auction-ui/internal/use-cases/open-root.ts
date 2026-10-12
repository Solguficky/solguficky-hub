import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, Viewer } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";
import { hasRaffle } from "./open-feed.js";

// Корень аукциона (PER-605; ADR-064, дополнение 2026-10-12): стадия и сроки,
// вход в лоты и, пока Auction его отдаёт, в розыгрыш. Остальные ряды корня —
// избранное, правила, пульт и возврат — ставит оболочка поверхности.
//
// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Отказ чтения аукциона бросается, как у ленты; отказ чтения розыгрыша убирает
// его кнопку, а не роняет корень.
export async function openRoot(input: {
  auction: AuctionPort;
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
    ],
  };
}
