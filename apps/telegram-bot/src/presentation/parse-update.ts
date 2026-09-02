import {
  type ResolveIdentityInput,
  toResolveIdentityInput,
} from "../identity/port.js";
import { IncomingUpdateSchema } from "./schemas.js";

export type ParsedUpdate =
  | ({ kind: "message"; text: string } & ResolveIdentityInput)
  | { kind: "ignored" }
  | { kind: "malformed" };

export function parseUpdate(raw: unknown): ParsedUpdate {
  const parsed = IncomingUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "malformed" };
  }
  const message = parsed.data.message;
  if (message === undefined) {
    return { kind: "ignored" };
  }
  const from = message.from;
  if (from === undefined || from.is_bot) {
    return { kind: "ignored" };
  }
  const text = message.text;
  if (text === undefined || text === "") {
    return { kind: "ignored" };
  }
  return {
    kind: "message",
    text,
    ...toResolveIdentityInput(BigInt(from.id), from.username),
  };
}
