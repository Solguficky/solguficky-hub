import type {
  AuctionBotPorts,
  EntryPort,
  Viewer,
} from "@solguficky/auction-bot-ui";

// FAQ — локальное намерение оболочки: общий пакет торгов о нём не знает. Вход
// `entry` зовёт `/start` вместо разрешения личности (ADR-060).
export type EntryPorts = AuctionBotPorts & {
  entry: EntryPort;
  faq: {
    acknowledged(viewer: Viewer): Promise<boolean>;
    acknowledge(viewer: Viewer): Promise<void>;
  };
};
