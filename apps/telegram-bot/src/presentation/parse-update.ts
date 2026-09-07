import type { DeepLink } from "../application/types.js";
import {
  type ResolveIdentityInput,
  toResolveIdentityInput,
} from "../identity/port.js";
import {
  IncomingUpdateSchema,
  MeetupDeepLinkPayloadSchema,
  TelegramDeepLinkPayloadSchema,
} from "./schemas.js";

export type ParsedUpdate =
  | ({ kind: "start" } & ResolveIdentityInput &
      ({ deepLink: DeepLink } | Record<never, never>))
  | { kind: "ignored" }
  | { kind: "malformed" };

const startCommandPattern = /^\/start(?:@([A-Za-z0-9_]{5,32}))?(?: (.*))?$/i;

export function parseUpdate(raw: unknown, botUsername?: string): ParsedUpdate {
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
  const command = parseStartCommand(text, botUsername);
  if (command === undefined) {
    return { kind: "ignored" };
  }
  return parsedStart(
    toResolveIdentityInput(BigInt(from.id), from.username),
    command.deepLink,
  );
}

type StartCommand = { deepLink: DeepLink | undefined };

function parseStartCommand(
  text: string,
  botUsername: string | undefined,
): StartCommand | undefined {
  const match = startCommandPattern.exec(text.trimEnd());
  if (match === null) {
    return undefined;
  }
  const mentionedBot = match[1];
  if (mentionedBot !== undefined) {
    if (
      botUsername === undefined ||
      mentionedBot.toLowerCase() !== botUsername.toLowerCase()
    ) {
      return undefined;
    }
  }
  const payloadRaw = match[2];
  if (payloadRaw === undefined || payloadRaw === "") {
    return { deepLink: undefined };
  }
  const payload = TelegramDeepLinkPayloadSchema.safeParse(payloadRaw);
  if (!payload.success) {
    return { deepLink: undefined };
  }
  return { deepLink: classifyDeepLink(payload.data) };
}

function classifyDeepLink(payload: string): DeepLink {
  if (MeetupDeepLinkPayloadSchema.safeParse(payload).success) {
    return { kind: "meetup", payload };
  }
  return { kind: "unclassified", payload };
}

function parsedStart(
  identity: ResolveIdentityInput,
  deepLink: DeepLink | undefined,
): ParsedUpdate {
  if (deepLink === undefined) {
    return { kind: "start", ...identity };
  }
  return { kind: "start", ...identity, deepLink };
}
