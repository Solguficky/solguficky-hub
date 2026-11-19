import type { MessageEntity } from "grammy/types";
import { escapeHtml } from "./screens/kit.js";

// Разметка описания сходки (PER-902, вариант A владельца 19.11.2026). Описание
// хранится в Meetups той же строкой, что раньше, но HTML Telegram: ответ на
// вопрос «Описание» переводится из текста и сущностей сообщения. Старые
// описания — простой текст с голыми `<` и `&`. Строку без признака формата
// различает экранирование при вводе: набранный руками `<b>` хранится как
// `&lt;b&gt;`, а голые `<` и `&` бывают только в старых описаниях.

/** Предел видимого текста описания: запас под заголовок и статус плоской карточки. */
export const descriptionLimit = 3000;

type InlineTag = "b" | "i" | "u" | "s" | "tg-spoiler" | "code";
type BlockTag = "pre" | "blockquote";
type Tag = InlineTag | BlockTag | "a";

type Token =
  | { kind: "text"; html: string }
  | { kind: "open"; tag: Tag; html: string }
  | { kind: "close"; tag: Tag };

const entityTags: Partial<Record<MessageEntity["type"], InlineTag | BlockTag>> =
  {
    bold: "b",
    italic: "i",
    underline: "u",
    strikethrough: "s",
    spoiler: "tg-spoiler",
    code: "code",
    pre: "pre",
    blockquote: "blockquote",
    expandable_blockquote: "blockquote",
  };

// Ссылка под текстом — только те схемы, которые Telegram показывает ссылкой:
// иная схема в `href` — отказ Bot API на всю карточку.
const linkSchemes = /^(https?|tg|mailto):/i;

type Opening = { tag: Tag; html: string; end: number };

function opening(entity: MessageEntity): Opening | undefined {
  const end = entity.offset + entity.length;
  if (entity.type === "text_link") {
    return linkSchemes.test(entity.url)
      ? { tag: "a", html: `<a href="${escapeHtml(entity.url)}">`, end }
      : undefined;
  }
  const tag = entityTags[entity.type];
  return tag === undefined ? undefined : { tag, html: `<${tag}>`, end };
}

/**
 * Текст ответа с сущностями Telegram — в HTML Telegram. Смещения сущностей —
 * в единицах UTF-16, как индексы строки JavaScript. Сущности вне набора
 * остаются текстом; пересекающиеся — закрываются и открываются заново.
 */
export function descriptionHtml(
  text: string,
  entities: readonly MessageEntity[] = [],
): string {
  const openings = entities
    .filter(
      (entity) =>
        entity.length > 0 &&
        entity.offset >= 0 &&
        entity.offset + entity.length <= text.length,
    )
    .flatMap((entity) => {
      const open = opening(entity);
      return open === undefined ? [] : [{ offset: entity.offset, open }];
    })
    // Внешняя сущность открывается раньше вложенной: при общем начале — длинная.
    .sort((a, b) => a.offset - b.offset || b.open.end - a.open.end);
  const points = [
    ...new Set([
      0,
      text.length,
      ...openings.flatMap(({ offset, open }) => [offset, open.end]),
    ]),
  ].sort((a, b) => a - b);
  const stack: Opening[] = [];
  let html = "";
  let cursor = 0;
  let next = 0;
  for (const point of points) {
    html += escapeHtml(text.slice(cursor, point));
    cursor = point;
    if (stack.some((open) => open.end === point)) {
      const reopen: Opening[] = [];
      while (stack.some((open) => open.end === point)) {
        const top = stack.pop() as Opening;
        html += `</${top.tag}>`;
        if (top.end !== point) reopen.unshift(top);
      }
      for (const open of reopen) {
        html += open.html;
        stack.push(open);
      }
    }
    while (next < openings.length && openings[next]?.offset === point) {
      const { open } = openings[next] as { open: Opening };
      next += 1;
      html += open.html;
      stack.push(open);
    }
  }
  return html;
}

const tokenPattern =
  /<(\/?)(b|i|u|s|tg-spoiler|code|pre|blockquote)>|<a href="([^"<>]*)">|<\/a>|&(?:lt|gt|amp|quot);|[<>&"]/g;

/**
 * Разбор сохранённого описания. Строка, которая не складывается в разметку
 * из набора — незакрытый или чужой тег, перекрёст, — читается целиком как
 * старое описание простым текстом.
 */
function tokens(stored: string): Token[] {
  const result: Token[] = [];
  const stack: Tag[] = [];
  let cursor = 0;
  const text = (html: string) => {
    if (html === "") return;
    const last = result.at(-1);
    if (last?.kind === "text") last.html += html;
    else result.push({ kind: "text", html });
  };
  for (const match of stored.matchAll(tokenPattern)) {
    text(stored.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const [whole, slash, tag, href] = match;
    if (tag !== undefined) {
      const name = tag as Tag;
      if (slash === "/") {
        if (stack.pop() !== name) return legacy(stored);
        result.push({ kind: "close", tag: name });
      } else {
        stack.push(name);
        result.push({ kind: "open", tag: name, html: whole });
      }
    } else if (href !== undefined) {
      if (!linkSchemes.test(href)) return legacy(stored);
      stack.push("a");
      result.push({ kind: "open", tag: "a", html: whole });
    } else if (whole === "</a>") {
      if (stack.pop() !== "a") return legacy(stored);
      result.push({ kind: "close", tag: "a" });
    } else if (whole.length > 1) {
      text(whole);
    } else {
      return legacy(stored);
    }
  }
  if (stack.length > 0) return legacy(stored);
  text(stored.slice(cursor));
  return result;
}

function legacy(stored: string): Token[] {
  return stored === "" ? [] : [{ kind: "text", html: escapeHtml(stored) }];
}

/** Описание для сообщения с `parse_mode: HTML`: переносы строк — как есть. */
export function plainDescription(stored: string): string {
  return tokens(stored)
    .map((token) => (token.kind === "close" ? `</${token.tag}>` : token.html))
    .join("");
}

/** Видимый текст описания: без тегов, сущности HTML раскрыты. */
export function visibleDescription(stored: string): string {
  return tokens(stored)
    .map((token) => (token.kind === "text" ? unescapeHtml(token.html) : ""))
    .join("");
}

function unescapeHtml(html: string): string {
  return html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/**
 * Описание внутри абзаца `<p>` rich-карточки. Перенос строки в `html`
 * rich-сообщения не рисуется (дизайн-код, «Перенос строки»), поэтому строка —
 * `<br>`, а пустая строка между абзацами — две. Цитата и блок кода — блоки:
 * абзац закрывается перед ними и открывается после, а разметка строки,
 * которая их охватывает, закрывается и открывается заново.
 */
export function richDescription(stored: string): string {
  const inline: Extract<Token, { kind: "open" }>[] = [];
  let block: BlockTag | undefined;
  let html = "";
  let pending = 0;
  // У края блока перенос не рисуется: блок и так начинается с новой строки.
  let edge = false;
  const closeInline = () =>
    inline
      .slice()
      .reverse()
      .map((open) => `</${open.tag}>`)
      .join("");
  const reopenInline = () => inline.map((open) => open.html).join("");
  const flush = () => {
    if (pending > 0) {
      html +=
        block === "blockquote"
          ? "<br>".repeat(pending)
          : pending === 1
            ? "<br>"
            : "<br><br>";
    }
    pending = 0;
    edge = false;
  };
  for (const token of tokens(stored)) {
    if (token.kind === "text") {
      if (block === "pre") {
        html += token.html;
        continue;
      }
      token.html.split("\n").forEach((line, index) => {
        if (index > 0 && !edge) pending += 1;
        if (line !== "") {
          flush();
          html += line;
        }
      });
      continue;
    }
    if (token.tag === "pre" || token.tag === "blockquote") {
      pending = 0;
      edge = true;
      if (token.kind === "open") {
        html += `${closeInline()}</p><${token.tag}>`;
        if (token.tag === "blockquote") html += reopenInline();
        block = token.tag;
      } else {
        if (token.tag === "blockquote") html += closeInline();
        html += `</${token.tag}><p>${reopenInline()}`;
        block = undefined;
      }
      continue;
    }
    if (token.kind === "open") {
      flush();
      html += token.html;
      inline.push(token);
    } else {
      html += `</${token.tag}>`;
      inline.pop();
    }
  }
  return html;
}
