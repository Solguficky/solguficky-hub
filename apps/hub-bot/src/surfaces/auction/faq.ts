// Тексты и адреса принадлежат организатору, а не правилам торгов в боте.
// Пока они не заполнены, места явно называют отсутствие, не обещая условия.
export type FaqContent = {
  items: string;
  purpose: string;
  simultaneousBids: string;
  connectionFailure: string;
  delivery: string;
  detailsUrl?: string;
  questionUrl?: string;
};

export const defaultFaq: FaqContent = {
  items: "Состав лотов организатор объявит отдельно.",
  purpose: "Организатор ещё не указал, куда идут средства.",
  simultaneousBids:
    "Организатор ещё не опубликовал порядок при почти одновременных ставках.",
  connectionFailure:
    "Организатор ещё не опубликовал порядок действий при сбое и потере связи.",
  delivery: "Организатор ещё не опубликовал условия доставки победителю.",
};

export type FaqConfigResult =
  | { ok: true; content: FaqContent }
  | { ok: false; error: string };

// Ограничение каждого текста держит весь FAQ в бюджете одного sendMessage.
export function readFaqContent(
  env: Readonly<Record<string, string | undefined>>,
): FaqConfigResult {
  const fields = {
    items: "AUCTION_FAQ_ITEMS",
    purpose: "AUCTION_FAQ_PURPOSE",
    simultaneousBids: "AUCTION_FAQ_SIMULTANEOUS_BIDS",
    connectionFailure: "AUCTION_FAQ_CONNECTION_FAILURE",
    delivery: "AUCTION_FAQ_DELIVERY",
  } as const;
  const content: FaqContent = { ...defaultFaq };
  for (const [field, name] of Object.entries(fields)) {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") continue;
    if (raw.length > 500)
      return { ok: false, error: `${name} exceeds 500 characters` };
    // Все ключи entries происходят из литерального fields выше.
    content[field as keyof typeof fields] = raw;
  }
  for (const [field, name] of [
    ["detailsUrl", "AUCTION_FAQ_DETAILS_URL"],
    ["questionUrl", "AUCTION_FAQ_QUESTION_URL"],
  ] as const) {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") continue;
    if (raw.length > 2048)
      return { ok: false, error: `${name} exceeds 2048 characters` };
    try {
      const url = new URL(raw);
      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return {
          ok: false,
          error: `${name} must be an HTTPS URL without credentials`,
        };
      }
      // URL кодирует кириллицу в пути: бюджет проверяется и после нормализации.
      if (url.href.length > 2048)
        return { ok: false, error: `${name} exceeds 2048 characters` };
      content[field] = url.href;
    } catch {
      return {
        ok: false,
        error: `${name} must be an HTTPS URL without credentials`,
      };
    }
  }
  return { ok: true, content };
}

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
