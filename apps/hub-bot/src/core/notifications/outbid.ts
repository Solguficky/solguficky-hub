import type { Client } from "@connectrpc/connect";
import {
  type AuctionNotificationPreferences,
  type NotificationsService,
  OutbidFrequency as WireFrequency,
} from "../../../gen/notifications/v1/notifications_service_pb.js";
import type { Viewer } from "../../auction-ui/index.js";
import { marked, pictogram } from "../pictograms.js";
import type { FavoritesCallOptions } from "./favorites.js";

// Настройки уведомлений аукциона (PER-539) — самодостаточные и общие у двух
// ботов: гость меняет их в боте аукциона, участник — в боте хаба (PER-552), а
// настройки у человека одни. Их две: частота «перебили» (PER-514, PER-515) и
// выключатель анонса финала. Аукционной категории в общих «Уведомлениях» хаба
// нет — решение владельца 13 октября 2026 года.
//
// Частота — фиксированный список, а не число минут, — те же значения, что
// `notifications.v1.OutbidFrequency`. Она правит перебития и ответы своей
// автоставки; интервал — одно окно на человека по всем лотам, в конце
// которого приходит сводка (PER-596). «Не присылать» и есть выключатель этих
// сообщений: второго нет. Покупку и допуск не трогает ни одна настройка.
export const OUTBID_FREQUENCIES = ["every", "5", "15", "60", "off"] as const;
export type OutbidFrequency = (typeof OUTBID_FREQUENCIES)[number];

export type AuctionNotificationSettings = {
  frequency: OutbidFrequency;
  finalAnnouncements: boolean;
};

// Одна настройка за нажатие, целевым значением: экран меняет либо частоту,
// либо выключатель финала, и вторую сервер не трогает.
export type AuctionNotificationChange =
  | { kind: "frequency"; frequency: OutbidFrequency }
  | { kind: "final"; enabled: boolean };

// Порт настроек у Notifications. Его нет, когда бот настройки не показывает:
// тогда нет ни экрана, ни кнопки «Частота уведомлений» под вестью о торгах.
// Значения, которого бот не знает, порт не выдумывает: `undefined` — ответ
// вне контракта.
export type AuctionNotificationsPort = {
  get(viewer: Viewer): Promise<AuctionNotificationSettings | undefined>;
  set(
    viewer: Viewer,
    change: AuctionNotificationChange,
  ): Promise<AuctionNotificationSettings | undefined>;
};

// Подпись кнопки выбора и состояние для ответа на нажатие: кнопка называет
// режим, состояние — что человек получает.
export const outbidLabels: Record<
  OutbidFrequency,
  { button: string; state: string }
> = {
  every: { button: "О каждом перебитии", state: "о каждом событии сразу" },
  "5": {
    button: "Не чаще раза в 5 минут",
    state: "сводкой не чаще раза в 5 минут",
  },
  "15": {
    button: "Не чаще раза в 15 минут",
    state: "сводкой не чаще раза в 15 минут",
  },
  "60": { button: "Не чаще раза в час", state: "сводкой не чаще раза в час" },
  off: { button: "Не присылать", state: "не присылаю" },
};

// Выбранный режим отмечен на своей кнопке маркером «• » (решение владельца 13
// октября 2026 года, PER-598): строки «Сейчас: …» в теле больше нет.
export function outbidButtonLabel(
  frequency: OutbidFrequency,
  current: OutbidFrequency,
): string {
  const label = outbidLabels[frequency].button;
  return frequency === current ? `• ${label}` : label;
}

const finalLabel = "Анонс финала";

// Выключатель финала — переключатель уведомлений словаря: колокольчик перед
// состоянием, как у категорий хаба — «🔔 Вкл · Анонс финала».
export function finalAnnouncementsButtonLabel(enabled: boolean): string {
  return marked(
    enabled ? pictogram.on : pictogram.off,
    `${enabled ? "Вкл" : "Выкл"} · ${finalLabel}`,
  );
}

// Пояснение экрана — одно у двух ботов, две строки (дизайн-код,
// «Уведомления»): чем управляет частота и что такое сводка, затем что такое
// анонс финала и что настройки не трогают.
export const auctionNotificationsExplanation = [
  "Как часто писать, что твою ставку перебили или ответила твоя автоставка. Не чаще — значит одной сводкой за это время: каждый лот с ценой на её конец.",
  "Анонс финала — состав финала аукциона, где ты торговался, и его старт. О покупке лота пишу всегда: настройки её не трогают.",
] as const;

/** Подтверждение выбора всплывающим текстом: что теперь будет приходить. */
export function auctionNotificationsToast(
  change: AuctionNotificationChange,
  current: AuctionNotificationSettings,
): string {
  return change.kind === "frequency"
    ? `Теперь: ${outbidLabels[current.frequency].state}.`
    : `${current.finalAnnouncements ? "Включено" : "Выключено"}: ${finalLabel.toLowerCase()}.`;
}

// Тип клиента берётся из схемы: Pick роняет typecheck на расхождении с
// contracts/proto.
export type AuctionNotificationsRpc = Pick<
  Client<typeof NotificationsService>,
  "getAuctionNotificationPreferences" | "setAuctionNotificationPreferences"
>;

// Настройки лежат на личности, а не на смотрящем: права в Notifications не
// уезжают (notifications.v1 — «Platform roles are deliberately absent»).
export function createAuctionNotificationsPort(
  rpc: AuctionNotificationsRpc,
  options: FavoritesCallOptions,
): AuctionNotificationsPort {
  return {
    async get(viewer) {
      const response = await rpc.getAuctionNotificationPreferences(
        { identityId: viewer.identityId },
        options(),
      );
      return auctionNotificationsOf(response);
    },
    async set(viewer, change) {
      const response = await rpc.setAuctionNotificationPreferences(
        {
          identityId: viewer.identityId,
          ...auctionNotificationsToWire(change),
        },
        options(),
      );
      return auctionNotificationsOf(response);
    },
  };
}

const wireFrequency: Record<OutbidFrequency, WireFrequency> = {
  every: WireFrequency.EVERY,
  "5": WireFrequency.AT_MOST_EVERY_5_MINUTES,
  "15": WireFrequency.AT_MOST_EVERY_15_MINUTES,
  "60": WireFrequency.AT_MOST_EVERY_60_MINUTES,
  off: WireFrequency.OFF,
};

// Поле, которого нет в запросе, сервер не меняет: изменение несёт только
// свою настройку.
export function auctionNotificationsToWire(
  change: AuctionNotificationChange,
): { outbidFrequency: WireFrequency } | { finalAnnouncements: boolean } {
  return change.kind === "frequency"
    ? { outbidFrequency: wireFrequency[change.frequency] }
    : { finalAnnouncements: change.enabled };
}

// `UNSPECIFIED` и число, которого словарь ещё не знает, — ответ вне контракта:
// сервер отдаёт умолчание `EVERY` сам, и бот его не додумывает.
export function outbidFrequencyOf(
  wire: WireFrequency,
): OutbidFrequency | undefined {
  return (Object.keys(wireFrequency) as OutbidFrequency[]).find(
    (frequency) => wireFrequency[frequency] === wire,
  );
}

export function auctionNotificationsOf(
  wire: Pick<
    AuctionNotificationPreferences,
    "outbidFrequency" | "finalAnnouncements"
  >,
): AuctionNotificationSettings | undefined {
  const frequency = outbidFrequencyOf(wire.outbidFrequency);
  return frequency === undefined
    ? undefined
    : { frequency, finalAnnouncements: wire.finalAnnouncements };
}
