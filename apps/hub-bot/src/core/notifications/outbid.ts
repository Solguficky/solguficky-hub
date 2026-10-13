import type { Client } from "@connectrpc/connect";
import {
  type NotificationsService,
  OutbidFrequency as WireFrequency,
} from "../../../gen/notifications/v1/notifications_service_pb.js";
import type { Viewer } from "../../auction-ui/index.js";
import type { FavoritesCallOptions } from "./favorites.js";

// Частота «перебили» (PER-514, PER-515) — общая у двух ботов: гость меняет её
// в боте аукциона, участник — в боте хаба (PER-552), а настройка у человека
// одна. Фиксированный список, а не число минут, — те же значения, что
// `notifications.v1.OutbidFrequency`. Настройка правит перебития и ответы
// своей автоставки; интервал — одно окно на человека по всем лотам, в конце
// которого приходит сводка (PER-596). Покупку и допуск она не трогает.
export const OUTBID_FREQUENCIES = ["every", "5", "15", "60", "off"] as const;
export type OutbidFrequency = (typeof OUTBID_FREQUENCIES)[number];

// Порт настройки у Notifications. Его нет, когда бот настройку не показывает:
// тогда нет ни экрана, ни кнопки «Реже» под уведомлением. Значения, которого
// бот не знает, порт не выдумывает: `undefined` — ответ вне контракта.
export type OutbidPreferencePort = {
  get(viewer: Viewer): Promise<OutbidFrequency | undefined>;
  set(
    viewer: Viewer,
    frequency: OutbidFrequency,
  ): Promise<OutbidFrequency | undefined>;
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

// Пояснение экрана частоты — одно у двух ботов, две строки: чем управляет
// настройка и что такое сводка, затем что она не трогает.
export const outbidExplanation = [
  "Как часто писать, что твою ставку перебили или ответила твоя автоставка. Не чаще — значит одной сводкой за это время: каждый лот с ценой на её конец.",
  "О покупке лота пишу всегда: настройка её не трогает.",
] as const;

/** Подтверждение выбора всплывающим текстом: что теперь будет приходить. */
export function outbidToast(current: OutbidFrequency): string {
  return `Теперь: ${outbidLabels[current].state}.`;
}

// Тип клиента берётся из схемы: Pick роняет typecheck на расхождении с
// contracts/proto.
export type OutbidPreferenceRpc = Pick<
  Client<typeof NotificationsService>,
  "getOutbidPreference" | "setOutbidPreference"
>;

// Настройка лежит на личности, а не на смотрящем: права в Notifications не
// уезжают (notifications.v1 — «Platform roles are deliberately absent»).
export function createOutbidPreferencePort(
  rpc: OutbidPreferenceRpc,
  options: FavoritesCallOptions,
): OutbidPreferencePort {
  return {
    async get(viewer) {
      const response = await rpc.getOutbidPreference(
        { identityId: viewer.identityId },
        options(),
      );
      return outbidFrequencyOf(response.frequency);
    },
    async set(viewer, frequency) {
      const response = await rpc.setOutbidPreference(
        {
          identityId: viewer.identityId,
          frequency: outbidFrequencyToWire(frequency),
        },
        options(),
      );
      return outbidFrequencyOf(response.frequency);
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

export function outbidFrequencyToWire(
  frequency: OutbidFrequency,
): WireFrequency {
  return wireFrequency[frequency];
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
