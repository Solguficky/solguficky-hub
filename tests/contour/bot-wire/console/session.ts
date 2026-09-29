import {
  freshTelegramUserId,
  type LogRecord,
  meetupIdFromStartLink,
  type openBotWire,
  type openDirectClients,
  type Person,
  type ScreenView,
  startConversation,
  usernameFor,
} from "../../../../apps/telegram-bot/testkit/index.js";
import { type Command, CommandError, help, type Role } from "./commands.js";

// Исполнение команд пульта поверх провода бота. Человек здесь тот же `Person`,
// что в сценариях L2: пульт — это сценарий, который пишут по шагу, глядя на
// ответ, а не заранее.

type Wire = ReturnType<typeof openBotWire>;
type Direct = ReturnType<typeof openDirectClients>;

type Member = {
  role: Role;
  telegramUserId: bigint;
  username?: string;
  person: Person;
};

export type ChangedScreen = ScreenView & {
  change: "new" | "edit";
  /** Сходка из «Ссылки для чата» на экране: её подставляют в `link`. */
  meetupId?: string;
};

export type Reply =
  | { ok: true; kind: "help"; commands: string[] }
  | { ok: true; kind: "quit" }
  | { ok: true; kind: "restart" }
  | {
      ok: true;
      kind: "people";
      people: { who: string; role: Role; username?: string }[];
    }
  | { ok: true; kind: "new"; who: string; role: Role; username?: string }
  | {
      ok: true;
      kind: "screen";
      who: string;
      /** Экраны, которые действие отправило или правило, по порядку. */
      changed: ChangedScreen[];
      /** Последний изменённый экран чата — то, что человек видит внизу. */
      last: ScreenView | null;
      /** Подписи, которые сейчас можно нажать на любом экране чата. */
      pressable: string[];
      /** Предупреждения и ошибки бота за это действие. */
      log: Pick<LogRecord, "level" | "message" | "fields">[];
    }
  | {
      ok: true;
      kind: "look";
      who: string;
      /** Все экраны чата по порядку последнего изменения. */
      screens: ScreenView[];
      pressable: string[];
    }
  | { ok: false; error: string };

export function openConsoleSession(wire: Wire, direct: Direct) {
  const people = new Map<string, Member>();
  let firstAdminId: string | undefined;

  function member(who: string): Member {
    const found = people.get(who);
    if (found === undefined) {
      throw new CommandError(
        `«${who}» не заведён: new ${who} admin|member|guest`,
      );
    }
    return found;
  }

  async function create(who: string, role: Role): Promise<Reply> {
    if (people.has(who)) {
      throw new CommandError(`«${who}» уже заведён`);
    }
    const telegramUserId = freshTelegramUserId();
    let username: string | undefined;
    if (role === "admin") {
      const identityId = await direct.grantAdmin(telegramUserId);
      firstAdminId ??= identityId;
    } else {
      username = usernameFor(telegramUserId);
      if (role === "member") {
        // Роль member человек получает на первом `/start`, как в продукте:
        // его ник заранее внесён администратором в whitelist.
        if (firstAdminId === undefined) {
          throw new CommandError(
            "member вносится в whitelist администратором: сначала new <имя> admin",
          );
        }
        await direct.allowUsername(firstAdminId, username);
      }
    }
    const person = startConversation(
      wire.bot,
      wire.calls,
      telegramUserId,
      username === undefined ? {} : { username },
    );
    people.set(who, {
      role,
      telegramUserId,
      person,
      ...(username === undefined ? {} : { username }),
    });
    return {
      ok: true,
      kind: "new",
      who,
      role,
      ...(username === undefined ? {} : { username }),
    };
  }

  async function act(
    who: string,
    action: (person: Person) => Promise<void>,
  ): Promise<Reply> {
    const { person } = member(who);
    const before = new Map(
      person.history().map((screen) => [screen.message, screen]),
    );
    const records = wire.records;
    const recordsBefore = records.length;
    try {
      await action(person);
    } catch (error) {
      // Кнопки нет или вопроса нет — ошибка человека за пультом, а не бота:
      // сообщение testkit называет последний экран, и этого достаточно.
      if (error instanceof Error && !(error instanceof CommandError)) {
        throw new CommandError(error.message);
      }
      throw error;
    }
    const history = person.history();
    const changed = history
      .filter((screen) => !sameScreen(before.get(screen.message), screen))
      .map((screen) => describeChange(screen, before.has(screen.message)));
    return {
      ok: true,
      kind: "screen",
      who,
      changed,
      last: history.at(-1) ?? null,
      pressable: person.pressable(),
      log: records
        .slice(recordsBefore)
        .filter((record) => record.level === "warn" || record.level === "error")
        .map(({ level, message, fields }) => ({ level, message, fields })),
    };
  }

  async function run(command: Command): Promise<Reply> {
    switch (command.kind) {
      case "help":
        return { ok: true, kind: "help", commands: help };
      case "quit":
        return { ok: true, kind: "quit" };
      case "restart":
        wire.restart();
        return { ok: true, kind: "restart" };
      case "people":
        return {
          ok: true,
          kind: "people",
          people: [...people].map(([who, { role, username }]) => ({
            who,
            role,
            ...(username === undefined ? {} : { username }),
          })),
        };
      case "new":
        return create(command.who, command.role);
      case "say":
        return act(command.who, (person) => person.says(command.text));
      case "answer":
        return act(command.who, (person) =>
          person.answers(command.number, command.text),
        );
      case "press":
        return act(command.who, (person) => person.presses(command.label));
      case "link":
        return act(command.who, (person) => person.opensLink(command.meetupId));
      case "look": {
        const { person } = member(command.who);
        return {
          ok: true,
          kind: "look",
          who: command.who,
          screens: person.history(),
          pressable: person.pressable(),
        };
      }
    }
  }

  // Команды исполняются по одной: два запроса пульта вперемешку дали бы
  // экраны, где «что изменило действие» уже не вычисляется.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    execute(command: Command): Promise<Reply> {
      const next = queue.then(() => run(command));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

function sameScreen(left: ScreenView | undefined, right: ScreenView): boolean {
  return (
    left !== undefined &&
    left.text === right.text &&
    left.awaitsReply === right.awaitsReply &&
    left.buttons.join("\u0000") === right.buttons.join("\u0000")
  );
}

function describeChange(screen: ScreenView, existed: boolean): ChangedScreen {
  let meetupId: string | undefined;
  try {
    meetupId = meetupIdFromStartLink(screen.text);
  } catch {
    meetupId = undefined;
  }
  return {
    ...screen,
    change: existed ? "edit" : "new",
    ...(meetupId === undefined ? {} : { meetupId }),
  };
}
