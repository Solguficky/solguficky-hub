import { type Context, InlineKeyboard } from "grammy";
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
  ctx: Context,
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
  try {
    const message = ctx.callbackQuery.message;
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

/** Повторная правка тем же содержимым: Telegram отвечает отказом, человеку это успех. */
export function isNotModified(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes("message is not modified");
}
