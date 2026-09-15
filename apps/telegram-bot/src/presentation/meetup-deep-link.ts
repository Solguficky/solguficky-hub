export function uuidToToken(id: string): string {
  return Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url");
}

export function tokenToUuid(token: string): string {
  const hex = Buffer.from(token, "base64url").toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function meetupDeepLinkPayload(meetupId: string): string {
  return `m_${uuidToToken(meetupId)}`;
}

// Ветки «имени нет» здесь нет намеренно. getMe возвращает username бота
// обязательным полем, и grammY типизирует `ctx.me` как `UserFromGetMe`, где
// `username: string`. Запасной `?start=<payload>` был бы хуже отсутствия
// ссылки: человек копирует его в чат под надписью «Ссылка для чата», а
// ссылкой эта строка не является. Инвариант держит тип, а не проверка.
export function meetupStartLink(botUsername: string, meetupId: string): string {
  return `https://t.me/${botUsername}?start=${meetupDeepLinkPayload(meetupId)}`;
}
