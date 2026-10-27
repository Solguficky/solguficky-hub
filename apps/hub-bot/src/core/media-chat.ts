import { GrammyError } from "grammy";
import type { Logger } from "./logging.js";

// Чат медиа ботов (ADR-057, дополнение 2026-10-27, временное до PER-711):
// закрытый канал среды, где медиа вне каталога лота лежат постами. Бот хаба
// публикует в него присланное администратором фото или видео `copyMessage` из
// своего чата, ссылка на медиа — `message_id` поста, а показывают пост оба
// бота тем же `copyMessage` со своей подписью и клавиатурой: `file_id` не
// участвует, поэтому пост одинаково показывают бот хаба и бот аукциона.
// Первый потребитель — своё фото или видео объявления аукциона (PER-776),
// следующий — промо-видео аукциона (PER-774): модуль не знает ни того, ни
// другого.
//
// Пост живёт вне Git и базы: удалённый пост, бот, снятый с администраторов,
// или удалённый канал дают отказ Telegram. Такой отказ — исход `unavailable`
// с записью в лог, а не исключение: медиа украшает сообщение, и вызывающий
// отправляет его без медиа. Прочие сбои — сеть, лимит, 5xx — бросаются, и
// повтор решает вызывающий, как у любой отправки.

/** Минимум Bot API чата медиа: копия сообщения. */
export type MediaChatApi = {
  copyMessage(
    chatId: number,
    fromChatId: number,
    messageId: number,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
};

export type MediaPublishResult =
  | { kind: "published"; postId: number }
  | { kind: "unavailable"; reason: string };

export type MediaShowResult =
  | { kind: "shown"; messageId: number }
  | { kind: "unavailable"; reason: string };

export type MediaChat = {
  // Без `BOT_MEDIA_CHANNEL_ID` медиа выключены: форма, которой нужно медиа,
  // его не предлагает, а пришедшая ссылка на пост показывается без медиа.
  readonly enabled: boolean;
  /** Копия сообщения человека из его чата постом чата медиа. */
  publish(
    api: MediaChatApi,
    fromChatId: number,
    messageId: number,
  ): Promise<MediaPublishResult>;
  /** Пост человеку: своя подпись простым текстом и клавиатура. */
  show(
    api: MediaChatApi,
    chatId: number,
    postId: number,
    options: {
      caption: string;
      markup?: { inline_keyboard: readonly unknown[] } | undefined;
      // Метка каталога экранов: линтер test kit видит и эту отправку.
      mark?: Record<string, unknown>;
    },
  ): Promise<MediaShowResult>;
};

// Отказ, который говорит о посте или канале, а не о сети. 403 о самом
// получателе — бот заблокирован, аккаунт удалён — бросается: получателю не
// дойдёт и сообщение без медиа, и это исход отправки вызывающего.
function unavailableReason(
  cause: unknown,
  target: "post" | "recipient",
): string | undefined {
  if (!(cause instanceof GrammyError)) return undefined;
  if (cause.error_code === 400) return cause.description;
  if (cause.error_code !== 403) return undefined;
  if (target === "recipient" && /user/i.test(cause.description)) {
    return undefined;
  }
  return cause.description;
}

export function createMediaChat(options: {
  channelId: number | undefined;
  logger: Pick<Logger, "warn">;
}): MediaChat {
  const { channelId, logger } = options;
  const unavailable = (
    operation: "publish" | "show",
    reason: string,
    postId?: number,
  ) => {
    // Сообщение называет шаг: `operation` каркаса — транспортное имя, а
    // не логическое.
    logger.warn(
      operation === "publish"
        ? "media chat post not published"
        : "media chat post not shown",
      {
        error_category: "dependency_unavailable",
        error: reason,
        ...(postId === undefined ? {} : { media_post_id: postId }),
      },
    );
    return { kind: "unavailable" as const, reason };
  };
  return {
    enabled: channelId !== undefined,
    async publish(api, fromChatId, messageId) {
      if (channelId === undefined) {
        return unavailable("publish", "media chat is off");
      }
      try {
        const post = await api.copyMessage(channelId, fromChatId, messageId);
        return { kind: "published", postId: post.message_id };
      } catch (cause) {
        const reason = unavailableReason(cause, "post");
        if (reason === undefined) throw cause;
        return unavailable("publish", reason);
      }
    },
    async show(api, chatId, postId, shown) {
      if (channelId === undefined) {
        return unavailable("show", "media chat is off", postId);
      }
      try {
        const sent = await api.copyMessage(chatId, channelId, postId, {
          ...shown.mark,
          caption: shown.caption,
          ...(shown.markup === undefined ? {} : { reply_markup: shown.markup }),
        });
        return { kind: "shown", messageId: sent.message_id };
      } catch (cause) {
        const reason = unavailableReason(cause, "recipient");
        if (reason === undefined) throw cause;
        return unavailable("show", reason, postId);
      }
    },
  };
}
