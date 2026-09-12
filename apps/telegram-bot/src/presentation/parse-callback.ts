import { z } from "zod";

const CallbackSchema = z.string().max(64);
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export type CallbackAction =
  | { kind: "hub" }
  | { kind: "manage-menu" }
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
  if (parsed.data === "v1:nav:hub") return { kind: "hub" };
  if (parts.length === 3 && parts[1] === "view") {
    const viewToken = TokenSchema.safeParse(parts[2]);
    return viewToken.success
      ? { kind: "view-meetup", token: viewToken.data }
      : { kind: "malformed" };
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
