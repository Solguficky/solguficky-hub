import { z } from "zod";

const CallbackSchema = z.string().max(64);
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export type CallbackAction =
  | { kind: "hub" }
  | { kind: "manage-menu" }
  | { kind: "community" }
  | { kind: "ask-allowed-username" }
  | { kind: "admit-member"; token: string }
  | { kind: "block-member"; token: string }
  | { kind: "remove-allowed-username"; username: string }
  | { kind: "create-meetup"; token: string }
  | { kind: "publish-meetup"; token: string }
  | { kind: "view-meetup"; token: string }
  | { kind: "outdated" }
  | { kind: "malformed" };

export function parseCallback(raw: unknown): CallbackAction {
  const parsed = CallbackSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed" };
  const parts = parsed.data.split(":");
  if (parts[0] !== "v1") return { kind: "outdated" };
  if (parsed.data === "v1:manage:menu") return { kind: "manage-menu" };
  if (parsed.data === "v1:community:list") return { kind: "community" };
  if (parsed.data === "v1:community:allow")
    return { kind: "ask-allowed-username" };
  if (parsed.data === "v1:nav:hub") return { kind: "hub" };
  if (parts.length === 3 && parts[1] === "view") {
    const viewToken = TokenSchema.safeParse(parts[2]);
    return viewToken.success
      ? { kind: "view-meetup", token: viewToken.data }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[1] === "community") {
    if (parts[2] === "remove" && /^[A-Za-z0-9_]{1,32}$/.test(parts[3] ?? "")) {
      return { kind: "remove-allowed-username", username: parts[3] ?? "" };
    }
    const identityToken = TokenSchema.safeParse(parts[3]);
    if (!identityToken.success) return { kind: "malformed" };
    if (parts[2] === "admit")
      return { kind: "admit-member", token: identityToken.data };
    if (parts[2] === "block")
      return { kind: "block-member", token: identityToken.data };
  }
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success || parts.length !== 4 || parts[1] !== "manage") {
    return { kind: "malformed" };
  }
  if (parts[2] === "new") return { kind: "create-meetup", token: token.data };
  if (parts[2] === "publish")
    return { kind: "publish-meetup", token: token.data };
  return { kind: "malformed" };
}
