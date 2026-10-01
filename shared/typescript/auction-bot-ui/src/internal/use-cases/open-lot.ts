import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, Viewer } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";

// Сырой юзкейс: доступ он не проверяет и поэтому из пакета не экспортируется.
// Войти в него можно только через `handleAuctionUpdate`, после шлюза.
export async function openLot(input: {
  auction: AuctionPort;
  viewer: Viewer;
  lotId: string;
}): Promise<AuctionScreenBody> {
  const lot = await input.auction.getLot({
    viewer: input.viewer,
    lotId: input.lotId,
  });
  return {
    blocks: [
      {
        kind: "lot",
        lotId: lot.lotId,
        auctionId: lot.auctionId,
        version: lot.version,
      },
    ],
    keyboard: [
      [
        {
          action: "lot.refresh",
          callbackData: encodeAuctionCallback({
            kind: "lot",
            lotId: lot.lotId,
          }),
        },
      ],
    ],
  };
}
