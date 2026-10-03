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
  /**
   * Разметка текста: `HTML` — обычное сообщение с разметкой, `rich` — богатое
   * сообщение (ADR-034). Без неё текст уходит как есть.
   */
  format?: "HTML" | "rich";
  /** `new` — экран приходит новым сообщением, даже если его открыло нажатие. */
  delivery?: "auto" | "new";
  /**
   * Что остаётся подписью у сообщения с файлом, под которым нажали кнопку: оно
   * становится следом. Без подписи у него только снимается клавиатура.
   */
  fileTrace?: string;
};

/** Update с тем, что отправителю нужно знать о нажатии. */
export type ScreenContext = Context & {
  waiting?: Waiting;
  /** Кнопка стояла под следом: экран не вправе его затереть. */
  fresh?: boolean;
};

/**
 * Единый отправитель экрана (дизайн-код, «Доставка»). Нажатие правит своё
 * сообщение. Новым сообщением экран приходит после команды, из-под следа и
 * из-под сообщения с файлом: текст у файла Telegram править не даёт. Правку,
 * которую Telegram не принял, тоже заменяет новое сообщение.
 */
export async function showScreen(
  ctx: ScreenContext,
  { id, text, keyboard, format, delivery, fileTrace }: ShownScreen,
): Promise<void> {
  const other = {
    ...screenMark(id),
    reply_markup: keyboard,
    ...(format === "HTML" ? { parse_mode: format } : {}),
  };
  const send = (): Promise<unknown> =>
    format === "rich"
      ? ctx.replyWithRichMessage({ html: text }, other)
      : ctx.reply(text, other);
  const message = ctx.callbackQuery?.message;
  if (message === undefined || delivery === "new" || ctx.fresh === true) {
    await send();
    return;
  }
  if ("document" in message || "photo" in message) {
    await leaveFileTrace(ctx, fileTrace);
    await send();
    return;
  }
  // Экран тот же, что под нажатой кнопкой: править нечем, и молчание человек
  // прочёл бы как несработавшую кнопку. Всплывающий текст говорит, что
  // нажатие дошло, — кадр E-09, а на повторе после сбоя — что сбой остался.
  if (format !== "rich" && sameScreen(message, text, keyboard, format)) {
    await ctx.waiting?.answer(
      id === "refusal" ? "Пока не получилось." : "Без изменений.",
    );
    return;
  }
  try {
    if (format === "rich") {
      await ctx.api.editMessageText(
        message.chat.id,
        message.message_id,
        { html: text },
        other,
      );
    } else {
      await ctx.editMessageText(text, other);
    }
  } catch (cause) {
    if (isNotModified(cause)) {
      return;
    }
    await clearCallbackKeyboard(ctx);
    await send();
  }
}

export async function clearCallbackKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  } catch {
    // A replacement screen still gets sent below; this is best-effort cleanup.
  }
}

// Сообщение с файлом остаётся в истории следом: без клавиатуры и, если
// действие его касалось, с подписью о том, чем оно кончилось.
async function leaveFileTrace(
  ctx: Context,
  caption: string | undefined,
): Promise<void> {
  if (caption === undefined) {
    await clearCallbackKeyboard(ctx);
    return;
  }
  try {
    await ctx.editMessageCaption({
      caption,
      reply_markup: new InlineKeyboard(),
    });
  } catch {
    // Экран всё равно уходит следом новым сообщением.
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
