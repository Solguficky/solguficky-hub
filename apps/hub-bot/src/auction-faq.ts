// FAQ организатора общий для обеих поверхностей; навигацию каждая оболочка
// задаёт отдельно.
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Тексты организатора дословны, но не являются Telegram HTML-разметкой.
export function renderFaqText(faq: FaqContent): string {
  const heading = (text: string) => `<b>${escapeHtml(text)}</b>`;
  const section = (name: string, text: string) =>
    `${heading(name)}\n${escapeHtml(text)}`;
  return [
    heading("Правила и FAQ"),
    section("Что продаём", faq.items),
    section("Куда идут средства", faq.purpose),
    section("Правила ставок", "Отменить сделанную ставку нельзя."),
    section("Почти одновременные ставки", faq.simultaneousBids),
    section("Сбой и потеря связи", faq.connectionFailure),
    section("Доставка победителю", faq.delivery),
  ].join("\n\n");
}
