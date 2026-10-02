import { type Context, InlineKeyboard } from "grammy";
import type { Waiting } from "../waiting.js";
import type { ScreenId } from "./catalog.js";

// Метка экрана едет вместе с самим вызовом Bot API: grammY переносит параметры
// вызова разворотом объекта, а он копирует и свойства с ключом-символом. До
// Telegram метка не доходит — JSON символы не сериализует, — зато её видит
// трансформер test kit и по ней сверяет экран с каталогом.
export const screenTag: unique symbol = Symbol("screen");

/** Разворачивается в параметры вызова: `{ ...screenMark("menu"), reply_markup }`. */
export function screenMark(id: ScreenId): { [screenTag]: ScreenId } {
  return { [screenTag]: id };
}

export type ShownScreen = {
  id: ScreenId;
  text: string;
  keyboard: InlineKeyboard;
  /** Разметка текста; без неё текст уходит как есть. */
  format?: "HTML";
};

/**
 * Единый отправитель экрана. Нажатие правит своё сообщение, команда отвечает
 * новым: править после команды нечего. Правку, которую Telegram не принял,
 * заменяет новое сообщение, а у прежнего снимается клавиатура.
 */
export async function showScreen(
  ctx: Context & { waiting?: Waiting },
  { id, text, keyboard, format }: ShownScreen,
): Promise<void> {
  const other = {
    ...screenMark(id),
    reply_markup: keyboard,
    ...(format === undefined ? {} : { parse_mode: format }),
  };
  // Экран, открытый командой, править нечем: кнопки под сообщением нет, и
  // попытка правки дала бы два заведомо неудачных вызова Bot API.
  if (ctx.callbackQuery === undefined) {
    await ctx.reply(text, other);
    return;
  }
  const message = ctx.callbackQuery.message;
  // Экран тот же, что под нажатой кнопкой: править нечем, и молчание человек
  // прочёл бы как несработавшую кнопку. Всплывающий текст говорит, что
  // нажатие дошло, — кадр E-09, а на повторе после сбоя — что сбой остался.
  if (sameScreen(message, text, keyboard, format)) {
    await ctx.waiting?.answer(
      id === "refusal" ? "Пока не получилось." : "Без изменений.",
    );
    return;
  }
  try {
    if (
      message !== undefined &&
      ("document" in message || "photo" in message)
    ) {
      await ctx.editMessageCaption({ caption: text, ...other });
    } else {
      await ctx.editMessageText(text, other);
    }
  } catch (cause) {
    if (isNotModified(cause)) {
      return;
    }
    await clearCallbackKeyboard(ctx);
    await ctx.reply(text, other);
  }
}

export async function clearCallbackKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  } catch {
    // A replacement screen still gets sent below; this is best-effort cleanup.
  }
}

// У размеченного сообщения Telegram возвращает видимый текст и сущности, а не
// исходный HTML, поэтому сравнивается видимый текст: теги сняты, сущности
// раскрыты. Разметка бота — только то, что собирает он сам, без вложенности.
function sameScreen(
  message: unknown,
  text: string,
  keyboard: InlineKeyboard,
  format: "HTML" | undefined,
): boolean {
  if (typeof message !== "object" || message === null) return false;
  const shown = message as {
    text?: unknown;
    reply_markup?: { inline_keyboard?: unknown };
  };
  return (
    shown.text === (format === "HTML" ? visibleText(text) : text) &&
    JSON.stringify(shown.reply_markup?.inline_keyboard ?? []) ===
      JSON.stringify(keyboard.inline_keyboard)
  );
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

/** Повторная правка тем же содержимым: Telegram отвечает отказом, человеку это успех. */
export function isNotModified(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes("message is not modified");
}
