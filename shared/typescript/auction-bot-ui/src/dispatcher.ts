import type { AuctionIntent } from "./callback-data.js";
import { openLot } from "./internal/use-cases/open-lot.js";
import type { AuctionPort, Viewer } from "./ports.js";
import type { AuctionScreenBody } from "./screen.js";

// Диспетчер принимает личность, которую уже установил шлюз, и сам доступ не
// проверяет. Из пакета не экспортируется по той же причине, что и юзкейсы.
export function dispatchAuctionIntent(input: {
  auction: AuctionPort;
  viewer: Viewer;
  intent: AuctionIntent;
}): Promise<AuctionScreenBody> {
  const { intent } = input;
  switch (intent.kind) {
    case "lot":
      return openLot({
        auction: input.auction,
        viewer: input.viewer,
        lotId: intent.lotId,
      });
    default: {
      const _exhaustive: never = intent.kind;
      return _exhaustive;
    }
  }
}
