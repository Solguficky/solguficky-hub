import { uuidToToken } from "./meetup-deep-link.js";

// Ссылка на лот в боте аукциона — `l_<токен>` рядом с `m_<uuid>` сходки и
// `s_<код>` канала (ADR-060, пункт 17; PER-492). Собирает её хаб: сводку дня он
// отдаёт организатору для пересылки в чат, а клавиатура при пересылке
// теряется, поэтому лот называется ссылкой в самом тексте. Открывает её бот
// аукциона — карточкой лота.
export const lotDeepLinkPrefix = "l_";

export function lotStartLink(botUsername: string, lotId: string): string {
  return `https://t.me/${botUsername}?start=${lotDeepLinkPrefix}${uuidToToken(lotId)}`;
}
