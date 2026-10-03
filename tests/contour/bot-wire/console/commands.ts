// Язык пульта: одна строка — одно действие. Разбор отделён от исполнения,
// чтобы его держали L0-тесты без контура (`commands.test.ts`).
//
//   new <имя> admin|member|guest   завести человека
//   <имя> say <текст>              написать боту; висит вопрос формы — ответ на него
//   <имя> answer <n> <текст>       ответить на n-й вопрос бота в чате
//   <имя> press <подпись>          нажать кнопку по подписи
//   <имя> link <uuid сходки>       открыть ссылку на сходку из чата сообщества
//   <имя> forward <канал> <пост>   переслать боту пост публичного канала
//   <имя> document <имя файла>     отправить боту документ
//   <имя> photo                    отправить боту фотографию
//   <имя> look                     показать экраны чата, ничего не делая
//   people                         кто заведён
//   restart                        рестарт процесса бота: память о вопросах теряется
//   slow <сервис> <мс>             задержать запросы бота к identity или meetups; 0 снимает
//   help                           эта справка
//   quit                           остановить пульт; контур снимет Contour.Host

export const roles = ["admin", "member", "guest"] as const;
export type Role = (typeof roles)[number];

export const slowServices = ["identity", "meetups"] as const;
export type SlowService = (typeof slowServices)[number];

// Дольше минуты ждать нечего: дедлайн RPC у бота — секунды, и задержка выше
// него уже неотличима от сервиса, который не отвечает вовсе.
export const maxDelayMs = 60_000;

export type Command =
  | { kind: "new"; who: string; role: Role }
  | { kind: "say"; who: string; text: string }
  | { kind: "answer"; who: string; number: number; text: string }
  | { kind: "press"; who: string; label: string }
  | { kind: "link"; who: string; meetupId: string }
  | { kind: "forward"; who: string; channel: string; postId: number }
  | { kind: "document"; who: string; fileName: string }
  | { kind: "photo"; who: string }
  | { kind: "look"; who: string }
  | { kind: "people" }
  | { kind: "restart" }
  | { kind: "slow"; service: SlowService; delayMs: number }
  | { kind: "help" }
  | { kind: "quit" };

export const help = [
  "new <имя> admin|member|guest   завести человека (member — ник в whitelist первого admin)",
  "<имя> say <текст>              написать боту, например: alice say /start",
  "<имя> answer <n> <текст>       ответить на n-й вопрос бота в чате",
  "<имя> press <подпись>          нажать кнопку по подписи",
  "<имя> link <uuid>              открыть ссылку на сходку из чата сообщества",
  "<имя> forward <канал> <пост>   переслать боту пост публичного канала: alice forward solguficky 77",
  "<имя> document <имя файла>     отправить боту документ",
  "<имя> photo                    отправить боту фотографию",
  "<имя> look                     экраны чата без действия",
  "people                         кто заведён",
  "restart                        рестарт процесса бота",
  "slow <сервис> <мс>             задержать запросы бота к identity или meetups; 0 снимает задержку",
  "quit                           остановить пульт",
];

const globalWords = new Set([
  "new",
  "people",
  "restart",
  "slow",
  "help",
  "quit",
]);
const channelPattern = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const namePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CommandError extends Error {}

/**
 * Хвост после действия берётся как есть, без кавычек: подпись кнопки и текст
 * человека несут пробелы, эмодзи и знаки препинания, и экранирование заставило
 * бы агента угадывать правила оболочки дважды.
 */
export function parseCommand(line: string): Command {
  const trimmed = line.replace(/\r?\n$/, "").trim();
  if (trimmed === "") {
    throw new CommandError("пустая команда; help — справка");
  }
  const [head = "", rest] = splitWord(trimmed);

  switch (head) {
    case "people":
    case "restart":
    case "help":
    case "quit":
      if (rest !== "") {
        throw new CommandError(`${head} не принимает аргументов`);
      }
      return { kind: head };
    case "new": {
      const [who, role] = splitWord(rest);
      checkName(who);
      if (!isRole(role)) {
        throw new CommandError(
          `роль «${role}» неизвестна; допустимы ${roles.join(", ")}`,
        );
      }
      return { kind: "new", who, role };
    }
    case "slow": {
      const [service, delay] = splitWord(rest);
      if (!isSlowService(service)) {
        throw new CommandError(
          `сервис «${service}» задержать нельзя; допустимы ${slowServices.join(", ")}`,
        );
      }
      if (!/^\d+$/.test(delay) || Number(delay) > maxDelayMs) {
        throw new CommandError(
          `задержка «${delay}» — не целое число миллисекунд от 0 до ${maxDelayMs}`,
        );
      }
      return { kind: "slow", service, delayMs: Number(delay) };
    }
  }

  const who = head;
  checkName(who);
  const [action, tail] = splitWord(rest);
  switch (action) {
    case "say":
      return { kind: "say", who, text: nonEmpty(tail, "текст") };
    case "press":
      return { kind: "press", who, label: nonEmpty(tail, "подпись кнопки") };
    case "answer": {
      const [number, text] = splitWord(tail);
      if (!/^[1-9]\d*$/.test(number)) {
        throw new CommandError(`номер вопроса «${number}» — не целое от 1`);
      }
      return {
        kind: "answer",
        who,
        number: Number(number),
        text: nonEmpty(text, "текст"),
      };
    }
    case "link":
      if (!uuidPattern.test(tail)) {
        throw new CommandError(`«${tail}» — не UUID сходки`);
      }
      return { kind: "link", who, meetupId: tail.toLowerCase() };
    case "forward": {
      const [channel, post] = splitWord(tail);
      if (!channelPattern.test(channel)) {
        throw new CommandError(
          `«${channel}» — не ник канала: латиница, цифры и _, от 4 знаков, без @`,
        );
      }
      // Номер уезжает в ссылку на пост числом: за пределом точных целых он
      // округлился бы до соседнего поста.
      if (!/^[1-9]\d*$/.test(post) || !Number.isSafeInteger(Number(post))) {
        throw new CommandError(`номер поста «${post}» — не целое от 1`);
      }
      return { kind: "forward", who, channel, postId: Number(post) };
    }
    case "document":
      return { kind: "document", who, fileName: nonEmpty(tail, "имя файла") };
    case "photo":
      if (tail !== "") {
        throw new CommandError("photo не принимает аргументов");
      }
      return { kind: "photo", who };
    case "look":
      if (tail !== "") {
        throw new CommandError("look не принимает аргументов");
      }
      return { kind: "look", who };
    default:
      throw new CommandError(
        `действие «${action}» неизвестно; допустимы say, answer, press, link, forward, document, photo, look`,
      );
  }
}

function splitWord(text: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

function checkName(who: string): void {
  if (!namePattern.test(who) || globalWords.has(who)) {
    throw new CommandError(
      `«${who}» не годится в имя: латиница в нижнем регистре, цифры, _ и -, не служебное слово`,
    );
  }
}

function isRole(value: string): value is Role {
  return (roles as readonly string[]).includes(value);
}

function isSlowService(value: string): value is SlowService {
  return (slowServices as readonly string[]).includes(value);
}

function nonEmpty(value: string, what: string): string {
  if (value === "") {
    throw new CommandError(`не хватает: ${what}`);
  }
  return value;
}
