import {
  freshTelegramUserId,
  type LogRecord,
  meetupIdFromStartLink,
  type openAuctionBotWire,
  type openBotWire,
  type openDirectClients,
  type Person,
  type ScreenView,
  type ScreenViolation,
  startConversation,
  takeViolations,
  usernameFor,
} from "../../../../apps/hub-bot/testkit/index.js";
import {
  type BotName,
  type Command,
  CommandError,
  help,
  type Role,
  type SlowService,
} from "./commands.js";

// Исполнение команд пульта поверх двух проводов. Человек здесь тот же `Person`,
// что в сценариях L2, — по одному на чат с каждым ботом: пульт — это сценарий,
// который пишут по шагу, глядя на ответ, а не заранее.

type HubWire = ReturnType<typeof openBotWire>;
type AuctionWire = ReturnType<typeof openAuctionBotWire>;
type Direct = ReturnType<typeof openDirectClients>;
export type Wires = { hub: HubWire; auction: AuctionWire };
type Outage = {
  slow(service: SlowService, delayMs: number): void;
  down(service: SlowService): void;
  up(service: SlowService): void;
};

type Member = {
  role: Role;
  telegramUserId: bigint;
  username: string;
  persons: Record<BotName, Person>;
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
  | { ok: true; kind: "restart"; bot: BotName }
  | { ok: true; kind: "slow"; service: SlowService; delayMs: number }
  | { ok: true; kind: "down"; service: SlowService }
  | { ok: true; kind: "up"; service: SlowService }
  | {
      ok: true;
      kind: "people";
      people: { who: string; role: Role; username: string }[];
    }
  | { ok: true; kind: "new"; who: string; role: Role; username: string }
  | {
      ok: true;
      kind: "screen";
      who: string;
      /** Бот, с которым говорил человек: экраны и лог — его. */
      bot: BotName;
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
      bot: BotName;
      /** Все экраны чата по порядку последнего изменения. */
      screens: ScreenView[];
      pressable: string[];
    }
  | { ok: false; error: string };

export function openConsoleSession(
  wires: Wires,
  direct: Direct,
  outage: Outage,
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
    // Ник есть у всех. Администратор получает роль одним GrantAdminRole, как
    // в продукте: круг у человека один, и Identity выводит из admin права хаба
    // и аукциона, а в global_roles отдаёт admin, member и guest (PER-526), —
    // поэтому белый список ему не нужен, чтобы открыть ленту лотов и форму лота.
    const username = usernameFor(telegramUserId);
    if (role === "admin") {
      const identityId = await direct.grantAdmin(telegramUserId);
      firstAdminId ??= identityId;
    } else if (role === "member") {
      // Роль member человек получает на первом `/start`, как в продукте:
      // его ник заранее внесён администратором в whitelist.
      if (firstAdminId === undefined) {
        throw new CommandError(
          "member вносится в whitelist администратором: сначала new <имя> admin",
        );
      }
      await direct.allowUsername(firstAdminId, username);
    }
    // Один человек — один Telegram id и ник в обоих чатах: Identity видит его
    // одной личностью, как и в жизни.
    const conversation = (wire: HubWire | AuctionWire) =>
      startConversation(wire.bot, wire.calls, telegramUserId, { username });
    people.set(who, {
      role,
      telegramUserId,
      username,
      persons: {
        hub: conversation(wires.hub),
        auction: conversation(wires.auction),
      },
    });
    return { ok: true, kind: "new", who, role, username };
  }

  async function act(
    who: string,
    bot: BotName,
    action: (person: Person) => Promise<void>,
    pressed = false,
  ): Promise<Reply> {
    const { persons, telegramUserId } = member(who);
    const person = persons[bot];
    const wire = wires[bot];
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
    // Линтер и его накопитель у двух ботов одни (`testkit/screen-lint.ts`), и
    // найденное за действие принадлежит боту, который отвечал.
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
      bot,
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
        wires[command.bot].restart();
        return { ok: true, kind: "restart", bot: command.bot };
      case "slow":
        outage.slow(command.service, command.delayMs);
        return {
          ok: true,
          kind: "slow",
          service: command.service,
          delayMs: command.delayMs,
        };
      case "down":
        outage.down(command.service);
        return { ok: true, kind: "down", service: command.service };
      case "up":
        outage.up(command.service);
        return { ok: true, kind: "up", service: command.service };
      case "people":
        return {
          ok: true,
          kind: "people",
          people: [...people].map(([who, { role, username }]) => ({
            who,
            role,
            username,
          })),
        };
      case "new":
        return create(command.who, command.role);
      case "say":
        return act(command.who, command.bot, (person) =>
          person.says(command.text),
        );
      case "answer":
        return act(command.who, command.bot, (person) =>
          person.answers(command.number, command.text),
        );
      case "press":
        return act(
          command.who,
          command.bot,
          (person) => person.presses(exactLabel(person, command.label)),
          true,
        );
      case "pick":
        return act(
          command.who,
          command.bot,
          (person) =>
            person.presses(
              exactLabel(person, command.label),
              command.occurrence,
            ),
          true,
        );
      case "old":
        return act(
          command.who,
          command.bot,
          (person) =>
            person.pressesFromOlderRelease(exactLabel(person, command.label)),
          true,
        );
      case "raw":
        return act(
          command.who,
          command.bot,
          (person) => person.pressesRaw(command.data),
          true,
        );
      case "link":
        return act(command.who, command.bot, (person) =>
          person.opensLink(command.meetupId),
        );
      case "forward":
        return act(command.who, command.bot, (person) =>
          person.forwardsChannelPost(command.channel, command.postId),
        );
      case "document":
        return act(command.who, command.bot, (person) =>
          person.sendsDocument(command.fileName),
        );
      case "photo":
        return act(command.who, command.bot, (person) =>
          person.sendsPhoto(command.photo),
        );
      case "look": {
        const { persons } = member(command.who);
        const person = persons[command.bot];
        return {
          ok: true,
          kind: "look",
          who: command.who,
          bot: command.bot,
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

/**
 * Подпись с пульта сравнивается с кнопками без различия пробелов: суммы в
 * подписях бот разделяет неразрывным пробелом, а человек за пультом набирает
 * обычный. Точного совпадения нет — подпись уходит в kit как есть, и его отказ
 * перечисляет, что нажать можно.
 */
function exactLabel(person: Person, label: string): string {
  const wanted = collapseSpaces(label);
  return (
    person
      .pressable()
      .find((candidate) => collapseSpaces(candidate) === wanted) ?? label
  );
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Ряды сравниваются целиком: правка, которая меняет только раскладку или цвет
// кнопки, — тоже изменение экрана.
function sameScreen(left: ScreenView | undefined, right: ScreenView): boolean {
  return (
    left !== undefined &&
    left.text === right.text &&
    left.awaitsReply === right.awaitsReply &&
    left.format === right.format &&
    left.posters === right.posters &&
    JSON.stringify(left.rows) === JSON.stringify(right.rows)
  );
}

type Call = HubWire["calls"][number] | AuctionWire["calls"][number];

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
