import type { AuctionBotPorts, Viewer } from "@solguficky/auction-bot-ui";

// Это локальное намерение оболочки. Общий пакет торгов о FAQ не знает.
export type EntryPorts = AuctionBotPorts & {
  faq: {
    acknowledged(viewer: Viewer): Promise<boolean>;
    acknowledge(viewer: Viewer): Promise<void>;
  };
};
