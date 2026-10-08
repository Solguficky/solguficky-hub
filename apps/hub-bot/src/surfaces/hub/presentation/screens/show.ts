import { type Context, InlineKeyboard, type InputFile } from "grammy";
import type { Message } from "grammy/types";
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
  /**
   * Фото богатого сообщения: текст ссылается на них как `tg://photo?id=<id>`.
   * Сообщение с ними остаётся богатым, а не «сообщением с файлом»: оно правится
   * на месте в обе стороны (зонд PER-443).
   */
  media?: readonly ScreenPhoto[];
  /** `new` — экран приходит новым сообщением, даже если его открыло нажатие. */
  delivery?: "auto" | "new";
  /**
   * Что остаётся подписью у сообщения с файлом, под которым нажали кнопку: оно
   * становится следом. Без подписи у него только снимается клавиатура.
   */
  fileTrace?: string;
  /**
   * Клавиатура без ссылки `tg://user?id=`. Ссылку на профиль Telegram пускает
   * только по настройкам приватности человека, а иначе отклоняет всё сообщение
   * (`BUTTON_USER_PRIVACY_RESTRICTED`) — тогда экран уходит с этой клавиатурой.
   */
  privacyFallback?: InlineKeyboard;
  /**
   * Отказ Telegram не заменяется новым сообщением, а уходит вызывающему: так
   * экран с загрузкой фото решает сам, чем его заменить (дизайн-код, «Показ
   * фото лота»). Повтор тем же содержимым по-прежнему не отказ.
   */
  strict?: true;
};

/**
 * Фото богатого сообщения: готовым `file_id` или байтами. Загрузку Telegram
 * принимает и в отправке, и в правке (зонд PER-450), а `file_id` возвращает в
 * блоках ответа.
 */
export type ScreenPhoto =
  | { id: string; fileId: string }
  | { id: string; upload: InputFile };

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
  { privacyFallback, ...screen }: ShownScreen,
): Promise<Message | undefined> {
  if (privacyFallback === undefined) {
    return await deliverScreen(ctx, screen);
  }
  try {
    return await deliverScreen(ctx, screen);
  } catch (cause) {
    if (!isPrivacyRestricted(cause)) throw cause;
    return await deliverScreen(ctx, { ...screen, keyboard: privacyFallback });
  }
}

async function deliverScreen(
  ctx: ScreenContext,
  {
    id,
    text,
    keyboard,
    format,
    delivery,
    fileTrace,
    media,
    strict,
  }: ShownScreen,
): Promise<Message | undefined> {
  const rich = {
    html: text,
    ...(media === undefined || media.length === 0
      ? {}
      : {
          media: media.map((photo) => ({
            id: photo.id,
            media: {
              type: "photo" as const,
              media: "fileId" in photo ? photo.fileId : photo.upload,
            },
          })),
        }),
  };
  const other = {
    ...screenMark(id),
    reply_markup: keyboard,
    ...(format === "HTML" ? { parse_mode: format } : {}),
  };
  const send = (): Promise<Message> =>
    format === "rich"
      ? ctx.replyWithRichMessage(rich, other)
      : ctx.reply(text, other);
  const message = ctx.callbackQuery?.message;
  if (message === undefined || delivery === "new" || ctx.fresh === true) {
    return await send();
  }
  if ("document" in message || "photo" in message) {
    await leaveFileTrace(ctx, fileTrace);
    return await send();
  }
  // Экран тот же, что под нажатой кнопкой: править нечем, и молчание человек
  // прочёл бы как несработавшую кнопку. Всплывающий текст говорит, что
  // нажатие дошло, — кадр E-09, а на повторе после сбоя — что сбой остался.
  if (format !== "rich" && sameScreen(message, text, keyboard, format)) {
    await ctx.waiting?.answer(
      id === "refusal" ? "Пока не получилось." : "Без изменений.",
    );
    return undefined;
  }
  try {
    const edited =
      format === "rich"
        ? await ctx.api.editMessageText(
            message.chat.id,
            message.message_id,
            rich,
            other,
          )
        : await ctx.editMessageText(text, other);
    return edited === true ? undefined : edited;
  } catch (cause) {
    if (isNotModified(cause)) {
      return undefined;
    }
    // Новое сообщение с той же клавиатурой Telegram отклонит так же.
    if (isPrivacyRestricted(cause)) throw cause;
    if (strict === true) throw cause;
    await clearCallbackKeyboard(ctx);
    return await send();
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

/** Ссылку `tg://user?id=` не пускают настройки приватности её владельца. */
export function isPrivacyRestricted(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes("BUTTON_USER_PRIVACY_RESTRICTED");
}

/** Повторная правка тем же содержимым: Telegram отвечает отказом, человеку это успех. */
export function isNotModified(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.includes("message is not modified");
}
