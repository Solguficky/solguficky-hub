import { organizerFaqText } from "./auction-faq-text.js";

// FAQ организатора общий для обеих поверхностей; навигацию каждая оболочка
// задаёт отдельно. Текст — свободный, Telegram HTML (`auction-faq-text.ts`),
// ссылки кнопок — конфигурация среды.
export type FaqContent = {
  text: string;
  detailsUrl?: string;
  questionUrl?: string;
};

export const defaultFaq: FaqContent = { text: organizerFaqText };

export type FaqConfigResult =
  | { ok: true; content: FaqContent }
  | { ok: false; error: string };

export function readFaqContent(
  env: Readonly<Record<string, string | undefined>>,
): FaqConfigResult {
  const content: FaqContent = { ...defaultFaq };
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

// Telegram принимает в тексте сообщения до 4096 знаков после разбора
// разметки; запас оставлен под правку текста без пересчёта.
export const FAQ_TEXT_LIMIT = 4000;

const ALLOWED_TAG = /^<(\/?)(b|i|u|a)(\s+href="https:\/\/[^"\s<>]+")?>$/;

// Нарушения формы текста FAQ: неизвестный или незакрытый тег, ссылка не по
// https, голые «<» и «&», текст длиннее сообщения Telegram. Пустой список —
// текст уйдёт в `parse_mode: HTML` без отказа Bot API.
export function faqTextProblems(text: string): string[] {
  const problems: string[] = [];
  const open: string[] = [];
  for (const match of text.matchAll(/<[^>]*>/g)) {
    const tag = ALLOWED_TAG.exec(match[0]);
    if (tag === null) {
      problems.push(`tag ${match[0]} is not allowed`);
      continue;
    }
    const [, closing, name] = tag;
    if (name === undefined) continue;
    if (closing === "/") {
      if (open.pop() !== name) problems.push(`tag </${name}> is unbalanced`);
    } else {
      if (name === "a" && tag[3] === undefined)
        problems.push("link without an https href");
      open.push(name);
    }
  }
  if (open.length > 0) problems.push(`tags ${open.join(", ")} are not closed`);
  const plain = text.replace(/<[^>]*>/g, "");
  if (/<|>/.test(plain)) problems.push("bare angle bracket");
  if (/&(?!(amp|lt|gt|quot);)/.test(plain)) problems.push("bare ampersand");
  const visible = plain.replace(/&(amp|lt|gt|quot);/g, "x");
  if (visible.length > FAQ_TEXT_LIMIT)
    problems.push(`visible text is ${visible.length} > ${FAQ_TEXT_LIMIT}`);
  return problems;
}

// Текст организатора уже размечен: он уходит в сообщение как есть.
export function renderFaqText(faq: FaqContent): string {
  return faq.text;
}
