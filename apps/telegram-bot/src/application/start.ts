import type { ExecuteRequest, ExecuteResult } from "./types.js";

const welcomeText = `Привет. Здесь живёт информация о сходках солегуфиков.

Можно посмотреть, что запланировано, открыть связанные сообщения из чата и подписаться на уведомления о конкретной сходке.

Писать буду только по твоей подписке.`;

export function start(_request: ExecuteRequest): ExecuteResult {
  return { kind: "message", text: welcomeText };
}
