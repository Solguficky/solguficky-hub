import type {
  AuctionBotPorts,
  EntryPort,
  Viewer,
} from "../../auction-ui/index.js";
import type { AuctionNotificationsPort } from "../../core/notifications/outbid.js";
import type { AuctionCatalogPort } from "./auctions.js";

// FAQ и списки аукционов — локальные намерения оболочки: аукционное дерево торгов о
// них не знает. Вход `entry` зовёт «Подать заявку» вместо разрешения личности
// (дополнение ADR-060 от 2026-10-12). Настройки уведомлений аукциона — у
// Notifications (PER-515, PER-539); без адреса Notifications порта нет, и
// настроек в боте тоже.
export type EntryPorts = AuctionBotPorts & {
  entry: EntryPort;
  catalog: AuctionCatalogPort;
  faq: {
    acknowledged(viewer: Viewer): Promise<boolean>;
    acknowledge(viewer: Viewer): Promise<void>;
  };
  outbid?: AuctionNotificationsPort;
};
