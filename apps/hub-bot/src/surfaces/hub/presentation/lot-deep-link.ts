import { tokenToUuid, uuidToToken } from "./meetup-deep-link.js";

// Ссылка на лот — `l_<токен>` рядом с `m_<uuid>` сходки и `s_<код>` канала
// (ADR-060, пункт 17; PER-492). Собирает её хаб и открывают оба бота —
// карточкой лота. Сводка дня ведёт ссылкой в бот аукциона: её организатор
// пересылает в чат, а клавиатура при пересылке теряется, поэтому лот назван
// ссылкой в самом тексте. Шёпот лота финала в чате сообщества ведёт ею в бот
// хаба (PER-685): его читает участник сообщества, а бот аукциона держателю
// права хаба карточку не открывает (ADR-064).
export const lotDeepLinkPrefix = "l_";

export function lotStartLink(botUsername: string, lotId: string): string {
  return `https://t.me/${botUsername}?start=${lotDeepLinkPrefix}${uuidToToken(lotId)}`;
}

// Токен лота — base64url шестнадцати байт UUIDv7, как его пишет `uuidToToken`.
const lotTokenPattern = /^[A-Za-z0-9_-]{22}$/;

/**
 * Идентификатор лота из payload `l_<токен>`. Payload недоверенный, а значение
 * едет в данные кнопки дерева: разобрать его — значит назвать лот, а не
 * поверить ему. Не разобранный payload — `undefined`, и тогда `/start`
 * читается без цели.
 */
export function lotIdOfPayload(payload: string): string | undefined {
  if (!payload.startsWith(lotDeepLinkPrefix)) return undefined;
  const token = payload.slice(lotDeepLinkPrefix.length);
  if (!lotTokenPattern.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== token) {
    return undefined;
  }
  return tokenToUuid(token);
}
