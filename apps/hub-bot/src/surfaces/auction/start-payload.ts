// Payload `/start`: канал прихода `s_<код>` (ADR-060, пункт 17) и лот
// `l_<токен>` (PER-492). Первый едет дальше в кнопку «Подать заявку» и
// уходит в Identity операцией входа `RequestAccess`; второй открывает карточку
// лота пришедшему по ссылке. Всё остальное — в том числе ссылку на сходку
// `m_<uuid>` — бот аукциона не открывает: у него нет сходок, и такой payload,
// как и любой чужой, читается как `/start` без цели.

/** Разобранный payload `/start`: цель прихода, если бот её знает. */
export type StartPayload = {
  /** Код канала из `s_<код>` без префикса: известен ли канал, решает Identity. */
  sourceCode?: string;
  /** Токен лота из `l_<токен>`: карточку какого лота открыть. */
  lotToken?: string;
};

const sourcePrefix = "s_";
const lotPrefix = "l_";

// Алфавит и длина payload deep link Telegram: что в них не помещается, по
// ссылке прийти не могло, и до Identity оно не доходит.
const deepLinkPayloadPattern = /^[A-Za-z0-9_-]{1,64}$/;

// Токен лота — base64url шестнадцати байт UUIDv7, как его пишет хаб.
const lotTokenPattern = /^[A-Za-z0-9_-]{22}$/;

export function startPayloadOf(payload: string): StartPayload {
  if (!deepLinkPayloadPattern.test(payload)) return {};
  if (payload.startsWith(sourcePrefix)) {
    return { sourceCode: payload.slice(sourcePrefix.length) };
  }
  const token = payload.slice(lotPrefix.length);
  return payload.startsWith(lotPrefix) && lotTokenPattern.test(token)
    ? { lotToken: token }
    : {};
}

/**
 * Идентификатор лота из токена ссылки. Токен недоверенный, а значение едет в
 * данные кнопки дерева: разобрать его — значит назвать лот, а не поверить ему.
 * Не разобранный токен — `undefined`, и тогда приход читается как `/start` без
 * цели.
 */
export function lotIdOf(token: string): string | undefined {
  if (!lotTokenPattern.test(token)) return undefined;
  const bytes = Buffer.from(token, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== token) {
    return undefined;
  }
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
