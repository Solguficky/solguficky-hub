import { carriesPersonContent } from "../../../core/entry.js";
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
import { sourceDeepLinkPrefix } from "./source-deep-link.js";

export type ParsedUpdate =
  // `firstName` — имя из того же update: вход на `/start` несёт его в заявку
  // для карточки модератора (ADR-060, пункт 23).
  | ({ kind: "start"; firstName: string } & ResolveIdentityInput &
      ({ deepLink: DeepLink } | Record<never, never>))
  // Команда раздела из кнопки меню клиента: открывает свой раздел новым
  // сообщением, `/menu` — корневое меню (PER-592).
  | ({ kind: "command"; command: SectionCommand } & ResolveIdentityInput)
  // Сообщение человека в личном чате, которое бот не читает: текст без
  // команды, незнакомая команда, файл. Ответ на вопрос сюда не доходит — его
  // разбирают раньше. Бот отвечает подсказкой, а не молчит (PER-592).
  | { kind: "stray" }
  | { kind: "ignored" }
  | { kind: "malformed" };

export type SectionCommand =
  | "menu"
  | "meetups"
  | "next"
  | "settings"
  | "manage"
  | "help";

const sectionCommands: Readonly<Record<string, SectionCommand>> = {
  menu: "menu",
  meetups: "meetups",
  next: "next",
  settings: "settings",
  manage: "manage",
  help: "help",
};

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
    // Служебное событие чата подсказки не получает: человек ничего не писал.
    const rawMessage = (raw as { message?: unknown }).message;
    return carriesPersonContent(rawMessage)
      ? { kind: "stray" }
      : { kind: "ignored" };
  }
  const command = parseCommand(text, botUsername);
  // Команда другому боту обращена не к нам: на неё бот молчит.
  if (command === "foreign") {
    return { kind: "ignored" };
  }
  if (command === undefined) {
    return { kind: "stray" };
  }
  const person = {
    ...toResolveIdentityInput(BigInt(from.id), from.username),
    firstName: from.first_name,
  };
  if (command.name === "start") {
    return parsedStart(person, startDeepLink(command.argument));
  }
  // Хвост команды раздела ничего не значит и в deep link не превращается.
  const section = Object.hasOwn(sectionCommands, command.name)
    ? sectionCommands[command.name]
    : undefined;
  if (section !== undefined) {
    return {
      kind: "command",
      command: section,
      ...toResolveIdentityInput(BigInt(from.id), from.username),
    };
  }
  return { kind: "stray" };
}

type Command = { name: string; argument: string | undefined };

function parseCommand(
  text: string,
  botUsername: string | undefined,
): Command | "foreign" | undefined {
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
      return "foreign";
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
  if (payload.startsWith(sourceDeepLinkPrefix)) {
    return { kind: "source", code: payload.slice(sourceDeepLinkPrefix.length) };
  }
  return { kind: "unclassified", payload };
}

function parsedStart(
  identity: ResolveIdentityInput & { firstName: string },
  deepLink: DeepLink | undefined,
): ParsedUpdate {
  if (deepLink === undefined) {
    return { kind: "start", ...identity };
  }
  return { kind: "start", ...identity, deepLink };
}
