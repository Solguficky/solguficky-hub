// Ссылка канала прихода — `s_<код>` рядом с `m_<uuid>` сходки (ADR-060,
// пункт 17). Реестр кодов ведёт Identity; бот только разбирает payload и
// собирает ссылку для пересылки.
export const sourceDeepLinkPrefix = "s_";

// Код — хвост payload в алфавите deep link Telegram: 64 символа payload без
// префикса. Identity проверяет то же самое и отвечает INVALID_ARGUMENT; бот
// проверяет заранее, чтобы переспросить код до вопроса о подписи.
const sourceChannelCodePattern = /^[A-Za-z0-9_-]{1,62}$/;

export function isSourceChannelCode(code: string): boolean {
  return sourceChannelCodePattern.test(code);
}

export function sourceStartLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${sourceDeepLinkPrefix}${code}`;
}

// Имя бота без «@»: 5–32 символа, латиница, цифры и «_», в конце «bot».
// Telegram требует того же при создании бота.
const telegramBotUsernamePattern = /^[A-Za-z][A-Za-z0-9_]{2,29}bot$/i;

export function isTelegramBotUsername(value: string): boolean {
  return telegramBotUsernamePattern.test(value);
}
