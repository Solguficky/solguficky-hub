// Payload `/start`: канал прихода `s_<код>` (ADR-060, пункт 17). Ссылку на
// сходку `m_<uuid>` бот аукциона не открывает — у него нет сходок, — и такой
// payload, как и любой чужой, читается как `/start` без канала. Код —
// недоверенный хвост без префикса: известен ли канал, решает Identity, а
// доносит код до него операция входа `RequestRole`.
const sourcePrefix = "s_";

// Алфавит и длина payload deep link Telegram: что в них не помещается, по
// ссылке прийти не могло, и до Identity оно не доходит.
const deepLinkPayloadPattern = /^[A-Za-z0-9_-]{1,64}$/;

export function sourceCodeOf(payload: string): string | undefined {
  if (!deepLinkPayloadPattern.test(payload)) return undefined;
  return payload.startsWith(sourcePrefix)
    ? payload.slice(sourcePrefix.length)
    : undefined;
}
