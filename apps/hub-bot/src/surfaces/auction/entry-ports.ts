import type {
  AuctionBotPorts,
  EntryPort,
  Viewer,
} from "../../auction-ui/index.js";
import type { AuctionCatalogPort } from "./auctions.js";

// FAQ и списки аукционов — локальные намерения оболочки: аукционное дерево торгов о
// них не знает. Вход `entry` зовёт `/start` вместо разрешения личности
// (ADR-060).
export type EntryPorts = AuctionBotPorts & {
  entry: EntryPort;
  catalog: AuctionCatalogPort;
  faq: {
    acknowledged(viewer: Viewer): Promise<boolean>;
    acknowledge(viewer: Viewer): Promise<void>;
  };
};
