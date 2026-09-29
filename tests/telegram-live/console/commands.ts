// Язык живого пульта: одна строка — одно действие синтетического аккаунта.
// Людей здесь не заводят: аккаунт один, и его роль задаёт владелец в Identity
// (local-development.md, «Живой прогон `/start`»). Разбор держат L0-тесты
// (`commands.test.ts`).
//
//   say <текст>                 написать боту; висит вопрос формы — ответ на него
//   reply <сообщение> <текст>   ответить на сообщение бота с этим номером
//   press <подпись>             нажать inline-кнопку по подписи
//   link <ссылка или payload>   /start с payload ссылки для чата: диплинки
//                               тестовой среды ведут в продакшн (ADR-046)
//   look                        перечитать чат из Telegram, ничего не делая
//   help                        справка
//   quit                        остановить пульт; бот остаётся работать

export type Command =
  | { kind: "say"; text: string }
  | { kind: "reply"; message: number; text: string }
  | { kind: "press"; label: string }
  | { kind: "link"; payload: string }
  | { kind: "look" }
  | { kind: "help" }
  | { kind: "quit" };

export const help = [
  "say <текст>                 написать боту, например: say /start",
  "reply <сообщение> <текст>   ответить на сообщение бота с этим номером",
  "press <подпись>             нажать inline-кнопку по подписи",
  "link <ссылка или payload>   /start <payload> ссылки для чата",
  "look                        перечитать чат из Telegram",
  "quit                        остановить пульт",
];

// Та же граница, что у payload `/start` в Bot API: 1–64 символа base64url.
const payloadPattern = /^[A-Za-z0-9_-]{1,64}$/;
const linkPayload = /[?&]start=([A-Za-z0-9_-]{1,64})(?:&|$)/;

export class CommandError extends Error {}

export function parseCommand(line: string): Command {
  const trimmed = line.replace(/\r?\n$/, "").trim();
  if (trimmed === "") {
    throw new CommandError("пустая команда; help — справка");
  }
  const [action = "", rest] = splitWord(trimmed);
  switch (action) {
    case "look":
    case "help":
    case "quit":
      if (rest !== "") {
        throw new CommandError(`${action} не принимает аргументов`);
      }
      return { kind: action };
    case "say":
      return { kind: "say", text: nonEmpty(rest, "текст") };
    case "press":
      return { kind: "press", label: nonEmpty(rest, "подпись кнопки") };
    case "reply": {
      const [message, text] = splitWord(rest);
      if (!/^[1-9]\d*$/.test(message)) {
        throw new CommandError(`номер сообщения «${message}» — не целое от 1`);
      }
      return {
        kind: "reply",
        message: Number(message),
        text: nonEmpty(text, "текст"),
      };
    }
    case "link": {
      const payload = payloadPattern.test(rest)
        ? rest
        : linkPayload.exec(rest)?.[1];
      if (payload === undefined) {
        throw new CommandError(
          `«${rest}» — ни ссылка с ?start=, ни payload: нужна «Ссылка для чата» или m_…`,
        );
      }
      return { kind: "link", payload };
    }
    default:
      throw new CommandError(
        `действие «${action}» неизвестно; допустимы say, reply, press, link, look, help, quit`,
      );
  }
}

/** Payload ссылки для чата в тексте экрана: его подставляют в `link`. */
export function startPayloadIn(text: string): string | undefined {
  return /\?start=([A-Za-z0-9_-]{1,64})/.exec(text)?.[1];
}

function splitWord(text: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

function nonEmpty(value: string, what: string): string {
  if (value === "") {
    throw new CommandError(`не хватает: ${what}`);
  }
  return value;
}
