import type {
  AuctionBotPorts,
  EntryPort,
  Viewer,
} from "../../auction-ui/index.js";
import type { OutbidPreferencePort } from "../../core/notifications/outbid.js";
import type { AuctionCatalogPort } from "./auctions.js";

// FAQ и списки аукционов — локальные намерения оболочки: аукционное дерево торгов о
// них не знает. Вход `entry` зовёт `/start` вместо разрешения личности
// (ADR-060). Настройка «перебили» — у Notifications (PER-515); без адреса
// Notifications порта нет, и настройки в боте тоже.
export type EntryPorts = AuctionBotPorts & {
  entry: EntryPort;
  catalog: AuctionCatalogPort;
  faq: {
    acknowledged(viewer: Viewer): Promise<boolean>;
    acknowledge(viewer: Viewer): Promise<void>;
  };
  outbid?: OutbidPreferencePort;
};
