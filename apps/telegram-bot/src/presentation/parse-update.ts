import type { DeepLink } from "../application/types.js";
import {
  type ResolveIdentityInput,
  toResolveIdentityInput,
} from "../identity/port.js";
import { type NavScreen, screenCommands } from "./commands.js";
import {
  IncomingUpdateSchema,
  MeetupDeepLinkPayloadSchema,
  TelegramDeepLinkPayloadSchema,
} from "./schemas.js";

export type ParsedUpdate =
  | ({ kind: "start" } & ResolveIdentityInput &
      ({ deepLink: DeepLink } | Record<never, never>))
  | ({ kind: "screen"; screen: NavScreen } & ResolveIdentityInput)
  | { kind: "ignored" }
  | { kind: "malformed" };

const commandPattern =
  /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{5,32}))?(?: (.*))?$/;

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
  const command = parseCommand(text, botUsername);
  if (command === undefined) {
    return { kind: "ignored" };
  }
  const identity = toResolveIdentityInput(BigInt(from.id), from.username);
  if (command.name === "start") {
    return parsedStart(identity, startDeepLink(command.argument));
  }
  // Хвост после команды меню не значит ничего: экран открывается тот же.
  const screen = screenCommands.get(command.name);
  if (screen === undefined) {
    return { kind: "ignored" };
  }
  return { kind: "screen", screen, ...identity };
}

type Command = { name: string; argument: string | undefined };

function parseCommand(
  text: string,
  botUsername: string | undefined,
): Command | undefined {
  const match = commandPattern.exec(text.trimEnd());
  if (match === null) {
    return undefined;
  }
  const mentionedBot = match[2];
  if (mentionedBot !== undefined) {
    if (
      botUsername === undefined ||
      mentionedBot.toLowerCase() !== botUsername.toLowerCase()
    ) {
      return undefined;
    }
  }
  return { name: (match[1] ?? "").toLowerCase(), argument: match[3] };
}

function startDeepLink(payloadRaw: string | undefined): DeepLink | undefined {
  if (payloadRaw === undefined || payloadRaw === "") {
    return undefined;
  }
  const payload = TelegramDeepLinkPayloadSchema.safeParse(payloadRaw);
  if (!payload.success) {
    return undefined;
  }
  return classifyDeepLink(payload.data);
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
