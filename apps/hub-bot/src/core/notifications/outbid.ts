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
// настройки у человека одни. Их четыре: частота «перебили» (PER-514, PER-515),
// выключатель «перебили» в живом финале (PER-645), выключатель анонса финала и
// выключатель вестей о новом аукционе и открытии торгов (PER-646).
// Аукционной категории в общих «Уведомлениях» хаба нет — решение владельца 13
// октября 2026 года.
//
// Частота — фиксированный список, а не число минут, — те же значения, что
// `notifications.v1.OutbidFrequency`. Она правит перебития и ответы своей
// автоставки онлайн-недели; интервал — одно окно на человека по всем лотам, в
// конце которого приходит сводка (PER-596). «Не присылать» и есть выключатель
// этих сообщений. В живом финале частота не действует: там решает свой
// выключатель, по умолчанию выключенный, — включивший получает каждое
// событие. Покупку и допуск не трогает ни одна настройка.
export const OUTBID_FREQUENCIES = ["every", "5", "15", "60", "off"] as const;
export type OutbidFrequency = (typeof OUTBID_FREQUENCIES)[number];

export type AuctionNotificationSettings = {
  frequency: OutbidFrequency;
  finalAnnouncements: boolean;
  liveFinalOutbids: boolean;
  auctionAnnouncements: boolean;
};

// Одна настройка за нажатие, целевым значением: экран меняет одну настройку,
// и остальные сервер не трогает.
export type AuctionNotificationChange =
  | { kind: "frequency"; frequency: OutbidFrequency }
  | { kind: "final"; enabled: boolean }
  | { kind: "live"; enabled: boolean }
  | { kind: "announcements"; enabled: boolean };

// Каждая настройка — одна кнопка, и нажатие ведёт к следующему варианту
// (решение владельца по прогону 14 октября 2026 года, №72): частота идёт по
// кругу пяти режимов. Кнопка несёт следующий режим целевым значением, а не
// шагом: повтор нажатия на том же сообщении ставит то же значение.
export function nextOutbidFrequency(current: OutbidFrequency): OutbidFrequency {
  const next = OUTBID_FREQUENCIES[OUTBID_FREQUENCIES.indexOf(current) + 1];
  return next ?? OUTBID_FREQUENCIES[0];
}

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

// Подпись режима на кнопке частоты и состояние для ответа на нажатие: кнопка
// называет текущий режим, состояние — что человек получает.
export const outbidLabels: Record<
  OutbidFrequency,
  { button: string; state: string }
> = {
  every: { button: "о каждом", state: "о каждом событии сразу" },
  "5": { button: "раз в 5 минут", state: "сводкой не чаще раза в 5 минут" },
  "15": { button: "раз в 15 минут", state: "сводкой не чаще раза в 15 минут" },
  "60": { button: "раз в час", state: "сводкой не чаще раза в час" },
  off: { button: "не присылать", state: "не присылаю" },
};

const frequencyLabel = "Перебили";

// Кнопка частоты показывает текущий режим (№72) — «Перебили: о каждом». Это
// не выключатель: колокольчик словаря стоит только перед «Вкл ·» и «Выкл ·».
export function outbidFrequencyButtonLabel(current: OutbidFrequency): string {
  return `${frequencyLabel}: ${outbidLabels[current].button}`;
}

const finalLabel = "Анонс финала";
const liveFinalLabel = "Перебили в финале";
const announcementsLabel = "Новый аукцион и торги";

// Выключатель — переключатель уведомлений словаря: колокольчик перед
// состоянием, как у категорий хаба — «🔔 Вкл · Анонс финала».
function switchLabel(enabled: boolean, label: string): string {
  return marked(
    enabled ? pictogram.on : pictogram.off,
    `${enabled ? "Вкл" : "Выкл"} · ${label}`,
  );
}

export function finalAnnouncementsButtonLabel(enabled: boolean): string {
  return switchLabel(enabled, finalLabel);
}

export function liveFinalOutbidsButtonLabel(enabled: boolean): string {
  return switchLabel(enabled, liveFinalLabel);
}

export function auctionAnnouncementsButtonLabel(enabled: boolean): string {
  return switchLabel(enabled, announcementsLabel);
}

// Ряды экрана, одни у двух ботов (№72): по кнопке на настройку, кнопка
// называет текущее значение и несёт следующее — целевым значением, а не
// шагом. Данные кнопки поверхность кодирует своими следами.
export function auctionNotificationsRows(
  current: AuctionNotificationSettings,
): { text: string; change: AuctionNotificationChange }[] {
  return [
    {
      text: outbidFrequencyButtonLabel(current.frequency),
      change: {
        kind: "frequency",
        frequency: nextOutbidFrequency(current.frequency),
      },
    },
    {
      text: liveFinalOutbidsButtonLabel(current.liveFinalOutbids),
      change: { kind: "live", enabled: !current.liveFinalOutbids },
    },
    {
      text: finalAnnouncementsButtonLabel(current.finalAnnouncements),
      change: { kind: "final", enabled: !current.finalAnnouncements },
    },
    {
      text: auctionAnnouncementsButtonLabel(current.auctionAnnouncements),
      change: {
        kind: "announcements",
        enabled: !current.auctionAnnouncements,
      },
    },
  ];
}

// Пояснение экрана — одно у двух ботов (дизайн-код, «Уведомления»): как
// работают кнопки, чем управляет частота и что такое сводка, что такое
// перебитие в финале, затем анонс финала и что настройки не трогают.
export const auctionNotificationsExplanation = [
  "Нажатие на кнопку переключает её на следующий вариант.",
  "Перебили — как часто писать, что твою ставку перебили или ответила твоя автоставка. Раз в 5, 15 минут или час — значит одной сводкой за это время: каждый лот с ценой на её конец.",
  "Перебили в финале — то же о лоте на торгах в зале, о каждом сразу; частота здесь не действует.",
  "Анонс финала — состав финала аукциона, где ты торговался, и его старт. О покупке лота пишу всегда: настройки её не трогают.",
  "Новый аукцион и торги — что аукцион сходки открыли и когда началась онлайн-неделя. Выключатель гасит обе вести.",
] as const;

/** Подтверждение выбора всплывающим текстом: что теперь будет приходить. */
export function auctionNotificationsToast(
  change: AuctionNotificationChange,
  current: AuctionNotificationSettings,
): string {
  switch (change.kind) {
    case "frequency":
      return `Теперь: ${outbidLabels[current.frequency].state}.`;
    case "final":
      return `${current.finalAnnouncements ? "Включено" : "Выключено"}: ${finalLabel.toLowerCase()}.`;
    case "live":
      return `${current.liveFinalOutbids ? "Включено" : "Выключено"}: ${liveFinalLabel.toLowerCase()}.`;
    case "announcements":
      return `${current.auctionAnnouncements ? "Включено" : "Выключено"}: ${announcementsLabel.toLowerCase()}.`;
  }
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
):
  | { outbidFrequency: WireFrequency }
  | { finalAnnouncements: boolean }
  | { liveFinalOutbids: boolean }
  | { auctionAnnouncements: boolean } {
  switch (change.kind) {
    case "frequency":
      return { outbidFrequency: wireFrequency[change.frequency] };
    case "final":
      return { finalAnnouncements: change.enabled };
    case "live":
      return { liveFinalOutbids: change.enabled };
    case "announcements":
      return { auctionAnnouncements: change.enabled };
  }
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
    | "outbidFrequency"
    | "finalAnnouncements"
    | "liveFinalOutbids"
    | "auctionAnnouncements"
  >,
): AuctionNotificationSettings | undefined {
  const frequency = outbidFrequencyOf(wire.outbidFrequency);
  return frequency === undefined
    ? undefined
    : {
        frequency,
        finalAnnouncements: wire.finalAnnouncements,
        liveFinalOutbids: wire.liveFinalOutbids,
        auctionAnnouncements: wire.auctionAnnouncements,
      };
}
