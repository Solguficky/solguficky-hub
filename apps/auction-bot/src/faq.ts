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

export const ENTRY_ACTIONS = [
  "faq",
  "menu",
  "auctions",
  "details",
  "question",
] as const;
export type EntryAction = (typeof ENTRY_ACTIONS)[number];

export function entryCallback(action: EntryAction): string {
  return `v1:entry:${action}`;
}

export function parseEntryCallback(raw: unknown): EntryAction | undefined {
  if (typeof raw !== "string") return undefined;
  return ENTRY_ACTIONS.find((action) => raw === entryCallback(action));
}
