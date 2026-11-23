import { randomBytes } from "node:crypto";
import { GrammyError } from "grammy";
import { uuidV7Of } from "../../../core/uuid-v7.js";
import { checkBroadcastBody } from "../application/broadcasts.js";
import { fingerprint } from "../application/fingerprint.js";
import { telegramTextLimit } from "./notification-message.js";
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

/** Номер чата в ссылке `t.me/c/…`: у супергруппы Bot API даёт `-100…`. */
export function communityChatPart(chatId: number): string {
  const supergroupFloor = -1000000000000;
  return chatId < supergroupFloor
    ? String(-chatId - 1000000000000)
    : String(Math.abs(chatId));
}

/**
 * Ссылка на пост собирается из id чата и номера сообщения (ADR-087, п. 4;
 * RFC-003, «Шёпот в группе»).
 */
export function communityMessageLink(
  chatId: number,
  messageId: number,
): string {
  return `https://t.me/c/${communityChatPart(chatId)}/${messageId}`;
}

/**
 * Обратный разбор ссылки, которую человек присылает после неопределённого
 * результата отправки. Источник и чат обязаны совпадать с настроенным чатом
 * сообщества: ссылка из другого чата не даёт права прикреплять её как анонс.
 */
export function parseCommunityPostLink(
  text: string,
  chatId: number,
): number | undefined {
  const part = communityChatPart(chatId);
  for (const word of text.trim().split(/\s+/)) {
    const matched =
      /^https:\/\/t\.me\/c\/([1-9]\d*)\/([1-9]\d*)(?:\?\S*)?$/.exec(word);
    if (matched?.[1] !== part) continue;
    const messageId = Number(matched[2]);
    if (Number.isSafeInteger(messageId)) return messageId;
  }
  return undefined;
}

/**
 * Разбор ссылки материала для правки поста (PER-926): `chat_id` и номер
 * сообщения едут в ссылке `message-link`, а чат обязан быть тем самым чатом
 * сообщества. Ссылка на другое сообщение или канал правке не подлежит.
 */
export function communityPostRef(
  url: string,
  chatId: number,
): { chatId: number; messageId: number } | undefined {
  const matched =
    /^https:\/\/t\.me\/c\/([1-9]\d*)\/([1-9]\d*)(?:\?\S*)?$/.exec(url.trim());
  if (matched?.[1] !== communityChatPart(chatId)) return undefined;
  const messageId = Number(matched[2]);
  return Number.isSafeInteger(messageId) ? { chatId, messageId } : undefined;
}

/** Пост от бота: подпись организатора и свободный текст, разметка HTML. */
export function announcementPostText(organizer: string, body: string): string {
  return `<b>${escapeHtml(organizer)}:</b>\n\n${escapeHtml(body)}`;
}

/**
 * Telegram считает предел по тексту после разбора entities, а не по длине
 * HTML-строки: `<b>` и `&amp;` в счёт не идут, идёт видимый текст. Поэтому
 * проверяем `${organizer}:\n\n${body}`, а экранирование остаётся в посте.
 */
export function announcementFits(organizer: string, body: string): boolean {
  return `${organizer}:\n\n${body}`.length <= telegramTextLimit;
}

/** Пост старше предела Telegram: это Permanent-отказ, повтор его не исправит. */
export const tooLongDescription = "message is too long";

export function postTooLongError(cause: unknown): boolean {
  return (
    cause instanceof GrammyError &&
    cause.description.includes(tooLongDescription)
  );
}

/** Ссылка на пост есть только у супергруппы (ADR-087, п. «факты»). */
export function isCommunitySupergroup(chatId: number): boolean {
  return chatId < -1000000000000;
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
    cause instanceof GrammyError &&
    cause.description.includes(noRightsDescription)
  );
}

/**
 * Память операции между шагами: номер отправленного поста или признак того,
 * что исход отправки неизвестен. Номер позволяет повторить только привязку
 * материала; неизвестный исход запрещает автоматическую повторную публикацию и
 * требует от человека проверки чата. Память процесса, без нового хранилища
 * (ADR-030): запись живёт до рестарта или вытеснения по лимиту.
 */
type AnnouncementRecord =
  | { kind: "posted"; messageId: number }
  | { kind: "unknown"; body: string; version: number; nonce?: string };

export type UnknownAnnouncement = {
  body: string;
  version: number;
  nonce?: string;
};

export type AnnouncementPosts = {
  remember(key: string, messageId: number): void;
  posted(key: string): number | undefined;
  markUnknown(key: string, body: string, version: number): void;
  unknown(key: string): UnknownAnnouncement | undefined;
  setResendNonce(key: string, nonce: string): void;
  forget(key: string): void;
  /**
   * Подпись поста по id материала (PER-926). Держится в памяти процесса рядом с
   * номером поста: Bot API не отдаёт текст чужого нам сообщения, а подпись
   * организатора при правке должна остаться прежней.
   */
  rememberSignature(materialId: string, signature: string): void;
  signatureOf(materialId: string): string | undefined;
};

export function createAnnouncementPosts(limit = 1_000): AnnouncementPosts {
  const records = new Map<string, AnnouncementRecord>();
  const signatures = new Map<string, string>();
  const put = (key: string, record: AnnouncementRecord): void => {
    records.delete(key);
    records.set(key, record);
    while (records.size > limit) {
      const oldest = records.keys().next();
      if (oldest.done === true) break;
      records.delete(oldest.value);
    }
  };
  return {
    remember(key, messageId) {
      put(key, { kind: "posted", messageId });
    },
    posted(key) {
      const record = records.get(key);
      return record?.kind === "posted" ? record.messageId : undefined;
    },
    markUnknown(key, body, version) {
      put(key, { kind: "unknown", body, version });
    },
    unknown(key) {
      const record = records.get(key);
      return record?.kind === "unknown"
        ? {
            body: record.body,
            version: record.version,
            ...(record.nonce === undefined ? {} : { nonce: record.nonce }),
          }
        : undefined;
    },
    setResendNonce(key, nonce) {
      const record = records.get(key);
      if (record?.kind === "unknown") {
        records.set(key, { ...record, nonce });
      }
    },
    forget(key) {
      records.delete(key);
    },
    rememberSignature(materialId, signature) {
      signatures.delete(materialId);
      signatures.set(materialId, signature);
      while (signatures.size > limit) {
        const oldest = signatures.keys().next();
        if (oldest.done === true) break;
        signatures.delete(oldest.value);
      }
    },
    signatureOf(materialId) {
      return signatures.get(materialId);
    },
  };
}
