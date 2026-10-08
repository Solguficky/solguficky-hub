export type { FaqConfigResult, FaqContent } from "../../auction-faq.js";
export { defaultFaq, readFaqContent } from "../../auction-faq.js";

// `menu` — вход в меню с любого экрана. `read` — возврат «‹ Меню» под FAQ:
// только он ставит отметку ознакомления (дизайн-код, «Дерево бота аукциона»).
// `start` — повтор входа после сбоя `/start`.
export const ENTRY_ACTIONS = [
  "faq",
  "menu",
  "read",
  "start",
  "auctions",
  "past",
  "details",
  "question",
] as const;
export type EntryAction = (typeof ENTRY_ACTIONS)[number];

// Списки аукционов листаются: номер страницы едет хвостом `:<N>`. Первая
// страница хвоста не несёт, поэтому кнопка меню — та же строка, что и до
// листания.
export type ListAction = Extract<EntryAction, "auctions" | "past">;
export const MAX_LIST_PAGE = 999;

// `sourceCode` — код канала прихода: он есть только у повтора входа, хвостом
// `start`.
export type EntryIntent =
  | { action: Exclude<EntryAction, "start">; page: number }
  | { action: "start"; page: 0; sourceCode?: string };

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

export function listCallback(action: ListAction, page: number): string {
  return page === 0
    ? entryCallback(action)
    : `${entryCallback(action)}:${page}`;
}

const LIST_PAGE = /^v1:entry:(auctions|past):([1-9][0-9]{0,2})$/;
// Алфавит кода — тот же, что у payload deep link (`start-payload.ts`).
// Пустой код значим: `/start s_` несёт канал с пустым кодом, и повтор его
// сохраняет.
const START_SOURCE = /^v1:entry:start:([A-Za-z0-9_-]{0,49})$/;

// Строка — недоверенный вход. Страница принимается только в канонической
// записи: без ведущих нулей и без `:0`, у которого есть короткая форма.
export function parseEntryCallback(raw: unknown): EntryIntent | undefined {
  if (typeof raw !== "string") return undefined;
  const action = ENTRY_ACTIONS.find((each) => raw === entryCallback(each));
  if (action === "start") return { action, page: 0 };
  if (action !== undefined) return { action, page: 0 };
  const sourceCode = START_SOURCE.exec(raw)?.[1];
  if (sourceCode !== undefined) return { action: "start", page: 0, sourceCode };
  const paged = LIST_PAGE.exec(raw);
  if (paged === null) return undefined;
  return { action: paged[1] as ListAction, page: Number(paged[2]) };
}
