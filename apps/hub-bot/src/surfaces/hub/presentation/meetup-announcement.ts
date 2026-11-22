import { randomBytes } from "node:crypto";
import { GrammyError } from "grammy";
import { checkBroadcastBody } from "../application/broadcasts.js";
import { fingerprint } from "../application/fingerprint.js";
import { uuidV7Of } from "../../../core/uuid-v7.js";
import { escapeHtml } from "./screens/kit.js";

// Анонс сходки (PER-925, ADR-087): пост бота-участника в чате сообщества и
// материал сходки источником `message-link`. Telegram не идемпотентен, а пост
// и материал пишутся двумя шагами, поэтому повтор действия свершается по
// детерминированному id материала и номеру уже опубликованного поста, который
// бот запомнил между шагами (ADR-087, п. 4).

export const announcementBodyCheck = checkBroadcastBody;

/** Ключ действия: 12 знаков uuid — 72 бита, в кнопку укладывается с запасом. */
export function announcementKey(): string {
  return randomBytes(9).toString("base64url");
}

/**
 * Id материала выведен из сходки и ключа подтверждения: повтор того же
 * подтверждения не заведёт второй материал, а уже прикреплённый материал —
 * след того, что пост ушёл. Время не участвует: ключ рождается один раз на
 * кадр подтверждения.
 */
export function announcementMaterialId(meetupId: string, key: string): string {
  return uuidV7Of(`hub-bot:meetup-announcement:${meetupId}:${key}`, 0);
}

/**
 * Ссылка на пост собирается из id чата и номера сообщения (ADR-087, п. 4;
 * RFC-003, «Шёпот в группе»). Id супергруппы Bot API равен `-1000000000000-N`,
 * поэтому номер берётся вычитанием, а не снятием префикса строки.
 */
export function communityMessageLink(
  chatId: number,
  messageId: number,
): string {
  const supergroupFloor = -1000000000000;
  const part =
    chatId < supergroupFloor
      ? String(-chatId - 1000000000000)
      : String(Math.abs(chatId));
  return `https://t.me/c/${part}/${messageId}`;
}

/** Пост от бота: подпись организатора и свободный текст, разметка HTML. */
export function announcementPostText(organizer: string, body: string): string {
  return `<b>${escapeHtml(organizer)}:</b>\n\n${escapeHtml(body)}`;
}

/** Отпечаток текста едет в кнопке подтверждения: текст в неё не помещается. */
export function announcementPrint(body: string): string {
  return fingerprint(body);
}

/** Отказ Telegram, который ADR-087 называет текстом поста. */
export const noRightsDescription =
  "not enough rights to send text messages to the chat";

export function communityRightsError(cause: unknown): boolean {
  return (
    cause instanceof GrammyError && cause.description.includes(noRightsDescription)
  );
}

/**
 * Память поста между шагами: после успешной отправки и до записи материала
 * бот помнит номер сообщения по ключу подтверждения. Повтор после сбоя
 * `AttachMaterial` прикрепит материал к тому же посту. Память процесса, без
 * нового хранилища (ADR-030): после рестарта повтор confirmation-кнопки
 * проверит уже прикреплённый материал в Meetups и не станет публиковать
 * второй пост, если материал успел записаться.
 */
export type AnnouncementPosts = {
  remember(key: string, messageId: number): void;
  posted(key: string): number | undefined;
};

export function createAnnouncementPosts(limit = 1_000): AnnouncementPosts {
  const messages = new Map<string, number>();
  return {
    remember(key, messageId) {
      messages.delete(key);
      messages.set(key, messageId);
      while (messages.size > limit) {
        const oldest = messages.keys().next();
        if (oldest.done === true) break;
        messages.delete(oldest.value);
      }
    },
    posted(key) {
      return messages.get(key);
    },
  };
}
