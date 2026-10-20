import { withSourceCode } from "../../core/entry.js";
import {
  type AuctionNotificationChange,
  OUTBID_FREQUENCIES,
} from "../../core/notifications/outbid.js";

export type { FaqConfigResult, FaqContent } from "../../auction-faq.js";
export { defaultFaq, readFaqContent } from "../../auction-faq.js";

// `menu` — корневое меню, общий родитель разделов: «‹ Меню» и прежние кнопки
// «Меню» в чатах (PER-592). `read` — кнопка «Аукционы» под FAQ: только она
// ставит отметку ознакомления (дизайн-код, «Дерево бота аукциона»). `start` —
// повтор `/start` после сбоя. `apply` — «Подать заявку» под приветствием:
// единственное действие, которое ставит заявку (дополнение ADR-060).
// `notify` — настройки уведомлений аукциона (PER-515, PER-539): без хвоста —
// экран, с хвостом частоты — её выбор, с хвостом `final:<0|1>` — выключатель
// анонса финала. `settings` — раздел «Настройки» (PER-595).
export const ENTRY_ACTIONS = [
  "faq",
  "menu",
  "read",
  "start",
  "apply",
  "auctions",
  "past",
  "details",
  "question",
  "notify",
  "settings",
] as const;
export type EntryAction = (typeof ENTRY_ACTIONS)[number];

// Списки аукционов листаются: номер страницы едет хвостом `:<N>`. Первая
// страница хвоста не несёт, поэтому возврат в список — та же строка, что и до
// листания.
export type ListAction = Extract<EntryAction, "auctions" | "past">;
export const MAX_LIST_PAGE = 999;

// `sourceCode` — код канала прихода: он есть только у повтора `/start` и у
// «Подать заявку», хвостом действия. `choose` — выбранная настройка: целевое
// значение, а не шаг, поэтому повтор нажатия безопасен.
export type EntryIntent =
  | {
      action: Exclude<EntryAction, "start" | "apply" | "notify">;
      page: number;
    }
  | { action: "start" | "apply"; page: 0; sourceCode?: string }
  | { action: "notify"; page: 0; choose?: AuctionNotificationChange };

export function entryCallback(action: EntryAction): string {
  return `v1:entry:${action}`;
}

// Код канала занимает до 62 символов payload, а кнопке после префикса
// остаётся 49 байт: код длиннее в повтор не едет, и вход повторяется без
// канала прихода.
const MAX_RETRY_SOURCE = 49;

export function startCallback(sourceCode?: string): string {
  return sourceCode === undefined || sourceCode.length > MAX_RETRY_SOURCE
    ? entryCallback("start")
    : `${entryCallback("start")}:${sourceCode}`;
}

/** «Подать заявку»: код канала хвостом, пока данные укладываются в 64 байта. */
export function applyCallback(sourceCode?: string): string {
  return withSourceCode(entryCallback("apply"), sourceCode);
}

export function notifyCallback(choose?: AuctionNotificationChange): string {
  if (choose === undefined) return entryCallback("notify");
  switch (choose.kind) {
    case "frequency":
      return `${entryCallback("notify")}:${choose.frequency}`;
    case "final":
      return `${entryCallback("notify")}:final:${choose.enabled ? "1" : "0"}`;
    case "live":
      return `${entryCallback("notify")}:live:${choose.enabled ? "1" : "0"}`;
  }
}

const NOTIFY_CHOICES: readonly AuctionNotificationChange[] = [
  ...OUTBID_FREQUENCIES.map(
    (frequency) => ({ kind: "frequency", frequency }) as const,
  ),
  { kind: "final", enabled: true },
  { kind: "final", enabled: false },
  { kind: "live", enabled: true },
  { kind: "live", enabled: false },
];

export function listCallback(action: ListAction, page: number): string {
  return page === 0
    ? entryCallback(action)
    : `${entryCallback(action)}:${page}`;
}

const LIST_PAGE = /^v1:entry:(auctions|past):([1-9][0-9]{0,2})$/;
// Алфавит кода — тот же, что у payload deep link (`start-payload.ts`).
// Пустой код значим: `/start s_` несёт канал с пустым кодом, и повтор его
// сохраняет.
const START_SOURCE = /^v1:entry:(start|apply):([A-Za-z0-9_-]{0,49})$/;

// Строка — недоверенный вход. Страница принимается только в канонической
// записи: без ведущих нулей и без `:0`, у которого есть короткая форма.
export function parseEntryCallback(raw: unknown): EntryIntent | undefined {
  if (typeof raw !== "string") return undefined;
  const action = ENTRY_ACTIONS.find((each) => raw === entryCallback(each));
  if (action !== undefined) return { action, page: 0 };
  const choose = NOTIFY_CHOICES.find((each) => raw === notifyCallback(each));
  if (choose !== undefined) return { action: "notify", page: 0, choose };
  const sourced = START_SOURCE.exec(raw);
  if (sourced !== null) {
    return {
      action: sourced[1] === "apply" ? "apply" : "start",
      page: 0,
      sourceCode: sourced[2] ?? "",
    };
  }
  const paged = LIST_PAGE.exec(raw);
  if (paged === null) return undefined;
  return { action: paged[1] as ListAction, page: Number(paged[2]) };
}
