import type { Viewer } from "../../auction-ui/index.js";

// Частота «перебили» (PER-514, PER-515): фиксированный список, а не число
// минут, — те же значения, что `notifications.v1.OutbidFrequency`. Интервал
// считается по лоту. Покупку, ответ автоставки и допуск настройка не трогает.
export const OUTBID_FREQUENCIES = ["every", "5", "15", "60", "off"] as const;
export type OutbidFrequency = (typeof OUTBID_FREQUENCIES)[number];

// Порт настройки у Notifications. Его нет, когда адрес Notifications боту не
// передан: тогда нет ни пункта меню, ни кнопки «Реже» под уведомлением.
// Значения, которого бот не знает, порт не выдумывает: `undefined` — ответ
// вне контракта.
export type OutbidPreferencePort = {
  get(viewer: Viewer): Promise<OutbidFrequency | undefined>;
  set(
    viewer: Viewer,
    frequency: OutbidFrequency,
  ): Promise<OutbidFrequency | undefined>;
};

// Подпись кнопки выбора и строка «Сейчас: …» экрана: кнопка называет режим,
// строка — что человек получает.
export const outbidLabels: Record<
  OutbidFrequency,
  { button: string; state: string }
> = {
  every: { button: "О каждом перебитии", state: "о каждом перебитии" },
  "5": {
    button: "Не чаще раза в 5 минут",
    state: "не чаще раза в 5 минут по лоту",
  },
  "15": {
    button: "Не чаще раза в 15 минут",
    state: "не чаще раза в 15 минут по лоту",
  },
  "60": { button: "Не чаще раза в час", state: "не чаще раза в час по лоту" },
  off: { button: "Не присылать", state: "не присылаю" },
};
