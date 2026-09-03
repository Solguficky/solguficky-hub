import {
  type ResolveIdentityInput,
  toResolveIdentityInput,
} from "../identity/port.js";
import { IncomingUpdateSchema } from "./schemas.js";

export type ParsedUpdate =
  | ({ kind: "start"; deepLinkPayload?: string } & ResolveIdentityInput)
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
  if (message.chat.type !== "private") {
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
  const command = parseStartCommand(text);
  if (command === undefined) {
    return { kind: "ignored" };
  }
  return withPayload(
    toResolveIdentityInput(BigInt(from.id), from.username),
    command,
  );
}

type StartCommand = { deepLinkPayload?: string };

function parseStartCommand(text: string): StartCommand | undefined {
  const match = /^\/start(?: ([A-Za-z0-9_-]{1,64}))?$/.exec(text);
  if (match === null) {
    return undefined;
  }
  return match[1] === undefined ? {} : { deepLinkPayload: match[1] };
}

function withPayload(
  identity: ResolveIdentityInput,
  command: StartCommand,
): ParsedUpdate {
  return command.deepLinkPayload === undefined
    ? { kind: "start", ...identity }
    : {
        kind: "start",
        ...identity,
        deepLinkPayload: command.deepLinkPayload,
      };
}
