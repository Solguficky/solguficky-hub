import {
  freshTelegramUserId,
  type LogRecord,
  meetupIdFromStartLink,
  type openBotWire,
  type openDirectClients,
  type Person,
  type ScreenView,
  type ScreenViolation,
  startConversation,
  takeViolations,
  usernameFor,
} from "../../../../apps/telegram-bot/testkit/index.js";
import {
  type Command,
  CommandError,
  help,
  type Role,
  type SlowService,
} from "./commands.js";

// Исполнение команд пульта поверх провода бота. Человек здесь тот же `Person`,
// что в сценариях L2: пульт — это сценарий, который пишут по шагу, глядя на
// ответ, а не заранее.

type Wire = ReturnType<typeof openBotWire>;
type Direct = ReturnType<typeof openDirectClients>;
type Slowdown = { slow(service: SlowService, delayMs: number): void };

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

/**
 * Ответ бота на нажатие: всплывающий текст, если он был. `null` — бот на
 * нажатие не ответил, и индикатор на кнопке у человека остался бы крутиться.
 */
export type Ack = { text?: string; alert?: boolean } | null;

export type Reply =
  | { ok: true; kind: "help"; commands: string[] }
  | { ok: true; kind: "quit" }
  | { ok: true; kind: "restart" }
  | { ok: true; kind: "slow"; service: SlowService; delayMs: number }
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
      /**
       * Методы Bot API, которые бот вызвал за действие, по порядку: по ним
       * видно, ушёл ли ответ на нажатие раньше правки экрана и был ли индикатор
       * ожидания. Сообщение не этому человеку помечено «→ другому».
       */
      api: string[];
      /** Ответ на нажатие; у действия без нажатия поля нет. */
      ack?: Ack;
      /** Сколько бот обрабатывал действие, мс. */
      tookMs: number;
      /** Нарушения дизайн-кода в экранах этого действия; пусто — поля нет. */
      lint?: ScreenViolation[];
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

export function openConsoleSession(
  wire: Wire,
  direct: Direct,
  slowdown: Slowdown,
) {
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
    pressed = false,
  ): Promise<Reply> {
    const { person, telegramUserId } = member(who);
    const before = new Map(
      person.history().map((screen) => [screen.message, screen]),
    );
    const records = wire.records;
    const recordsBefore = records.length;
    const callsBefore = wire.calls.length;
    const startedAt = performance.now();
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
    const tookMs = Math.round(performance.now() - startedAt);
    const lint = takeViolations();
    const calls = wire.calls.slice(callsBefore);
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
      api: calls.map((call) => describeCall(call, Number(telegramUserId))),
      ...(pressed ? { ack: readAck(calls) } : {}),
      tookMs,
      ...(lint.length === 0 ? {} : { lint }),
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
      case "slow":
        slowdown.slow(command.service, command.delayMs);
        return {
          ok: true,
          kind: "slow",
          service: command.service,
          delayMs: command.delayMs,
        };
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
        return act(
          command.who,
          (person) => person.presses(command.label),
          true,
        );
      case "link":
        return act(command.who, (person) => person.opensLink(command.meetupId));
      case "forward":
        return act(command.who, (person) =>
          person.forwardsChannelPost(command.channel, command.postId),
        );
      case "document":
        return act(command.who, (person) =>
          person.sendsDocument(command.fileName),
        );
      case "photo":
        return act(command.who, (person) => person.sendsPhoto());
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

// Ряды сравниваются целиком: правка, которая меняет только раскладку или цвет
// кнопки, — тоже изменение экрана.
function sameScreen(left: ScreenView | undefined, right: ScreenView): boolean {
  return (
    left !== undefined &&
    left.text === right.text &&
    left.awaitsReply === right.awaitsReply &&
    left.format === right.format &&
    JSON.stringify(left.rows) === JSON.stringify(right.rows)
  );
}

type Call = Wire["calls"][number];

function describeCall(call: Call, chatId: number): string {
  const target = (call.payload as { chat_id?: unknown }).chat_id;
  return target === undefined || target === chatId
    ? call.method
    : `${call.method} → другому`;
}

function readAck(calls: readonly Call[]): Ack {
  const answer = calls.find((call) => call.method === "answerCallbackQuery");
  if (answer === undefined) return null;
  const payload = answer.payload as { text?: unknown; show_alert?: unknown };
  return {
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(payload.show_alert === true ? { alert: true } : {}),
  };
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
