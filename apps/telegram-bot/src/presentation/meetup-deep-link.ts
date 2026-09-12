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

export function meetupStartLink(
  botUsername: string | undefined,
  meetupId: string,
): string {
  const payload = meetupDeepLinkPayload(meetupId);
  if (botUsername === undefined || botUsername === "") {
    return `?start=${payload}`;
  }
  return `https://t.me/${botUsername}?start=${payload}`;
}
