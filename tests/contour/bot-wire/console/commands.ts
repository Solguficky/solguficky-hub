// Язык пульта: одна строка — одно действие. Разбор отделён от исполнения,
// чтобы его держали L0-тесты без контура (`commands.test.ts`).
//
//   new <имя> admin|member|guest   завести человека
//   <имя> say <текст>              написать боту; висит вопрос формы — ответ на него
//   <имя> answer <n> <текст>       ответить на n-й вопрос бота в чате
//   <имя> press <подпись>          нажать кнопку по подписи
//   <имя> link <uuid сходки>       открыть ссылку на сходку из чата сообщества
//   <имя> look                     показать экраны чата, ничего не делая
//   people                         кто заведён
//   restart                        рестарт процесса бота: память о вопросах теряется
//   help                           эта справка
//   quit                           остановить пульт; контур снимет Contour.Host

export const roles = ["admin", "member", "guest"] as const;
export type Role = (typeof roles)[number];

export type Command =
  | { kind: "new"; who: string; role: Role }
  | { kind: "say"; who: string; text: string }
  | { kind: "answer"; who: string; number: number; text: string }
  | { kind: "press"; who: string; label: string }
  | { kind: "link"; who: string; meetupId: string }
  | { kind: "look"; who: string }
  | { kind: "people" }
  | { kind: "restart" }
  | { kind: "help" }
  | { kind: "quit" };

export const help = [
  "new <имя> admin|member|guest   завести человека (member — ник в whitelist первого admin)",
  "<имя> say <текст>              написать боту, например: alice say /start",
  "<имя> answer <n> <текст>       ответить на n-й вопрос бота в чате",
  "<имя> press <подпись>          нажать кнопку по подписи",
  "<имя> link <uuid>              открыть ссылку на сходку из чата сообщества",
  "<имя> look                     экраны чата без действия",
  "people                         кто заведён",
  "restart                        рестарт процесса бота",
  "quit                           остановить пульт",
];

const globalWords = new Set(["new", "people", "restart", "help", "quit"]);
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
    case "look":
      if (tail !== "") {
        throw new CommandError("look не принимает аргументов");
      }
      return { kind: "look", who };
    default:
      throw new CommandError(
        `действие «${action}» неизвестно; допустимы say, answer, press, link, look`,
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

function nonEmpty(value: string, what: string): string {
  if (value === "") {
    throw new CommandError(`не хватает: ${what}`);
  }
  return value;
}
