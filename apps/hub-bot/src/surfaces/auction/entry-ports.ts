import type {
  AuctionBotPorts,
  EntryPort,
  Viewer,
} from "../../auction-ui/index.js";
import type { OutbidPreferencePort } from "../../core/notifications/outbid.js";
import type { AuctionCatalogPort } from "./auctions.js";

// FAQ и списки аукционов — локальные намерения оболочки: аукционное дерево торгов о
// них не знает. Вход `entry` зовёт «Подать заявку» вместо разрешения личности
// (дополнение ADR-060 от 2026-10-12). Настройка «перебили» — у Notifications (PER-515); без адреса
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
