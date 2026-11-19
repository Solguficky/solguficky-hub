import type { Chat, Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  botInfo,
  createCapturingLogger,
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import { createBotShell } from "../../../core/bot/shell.js";
import { defaultTelegramEnvironment } from "../../../core/config.js";
import { noopTracing } from "../../../core/tracing.js";
import {
  createDispatcher,
  type Dispatcher,
} from "../application/dispatcher.js";
import type {
  IdentityResolver,
  ResolveIdentityResult,
} from "../identity/port.js";
import type {
  MeetupSnapshot,
  MeetupSummary,
  Meetups,
} from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import { communityChatCommands } from "./commands.js";
import { createCommunityChat } from "./community-chat.js";
import {
  createCommunityWhisper,
  parseInvisibleCommand,
  parseWhisperPress,
  type WhisperCommand,
} from "./community-whisper.js";
import { meetupDeepLinkPayload, uuidToToken } from "./meetup-deep-link.js";

// Шёпот в чате сообщества (ADR-078, пп. 3–5; PER-683): невидимая `/meetups`
// получает ответ, который видит только её автор, по праву хаба человека.

const community = -4012345678;
const person = { id: 42, is_bot: false, first_name: "tester" } as const;
const hubBot = { id: 999, is_bot: true, first_name: "hub" } as const;
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const today = { year: 2026, month: 11, day: 14 } as const;

function group(id: number): Chat.GroupChat {
  return { id, type: "group", title: "чат" };
}

// Невидимая команда: `message_id = 0`, адрес — `ephemeral_message_id`, а
// получатель — сам бот (docs/learning/telegram-bot-api/ephemeral-messages.md).
// `date` — секунды по часам Telegram; по умолчанию команда пришла только что.
function invisible(
  text: string,
  chat: Chat = group(community),
  date: number = Math.floor(Date.now() / 1_000),
): Update {
  return {
    update_id: 1,
    message: {
      message_id: 0,
      ephemeral_message_id: 7,
      date,
      chat,
      from: person,
      receiver_user: hubBot,
      text,
    },
  } as Update;
}

function visibleCommand(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 5,
      date: 0,
      chat: group(community),
      from: person,
      text,
    },
  } as Update;
}

function meetup(
  id: string,
  title: string,
  options: {
    day?: number;
    month?: number;
    visibility?: "visible" | "hidden";
  } = {},
): MeetupSummary {
  return {
    id,
    title,
    visibility: options.visibility ?? "visible",
    ...(options.day === undefined
      ? {}
      : {
          schedule: {
            year: 2026,
            month: options.month ?? 11,
            day: options.day,
          },
        }),
  };
}

const later = meetup("11111111-1111-4111-8111-111111111111", "Прогулка", {
  day: 22,
});
const sooner = meetup("22222222-2222-4222-8222-222222222222", "Настолки", {
  day: 15,
});
const hidden = meetup("33333333-3333-4333-8333-333333333333", "Черновик", {
  day: 16,
  visibility: "hidden",
});
const past = meetup("44444444-4444-4444-8444-444444444444", "Прошлая", {
  day: 1,
});
const undated = meetup("55555555-5555-4555-8555-555555555555", "Когда-нибудь");

type Fakes = {
  resolve?: ResolveIdentityResult;
  rights?: readonly AccessRight[];
  blocked?: boolean;
  meetups?: readonly MeetupSummary[];
  execute?: Dispatcher["execute"];
  respond?: (method: string, payload: unknown) => unknown;
};

function harness(fakes: Fakes = {}) {
  const resolve = vi.fn<IdentityResolver["resolve"]>(
    async () =>
      fakes.resolve ?? {
        kind: "resolved",
        identityId,
        rights: fakes.rights ?? ["access-hub"],
        blocked: fakes.blocked ?? false,
      },
  );
  const requestAccess = vi.fn(async () => {
    throw new Error("RequestAccess из чата не зовётся");
  });
  const execute = vi.fn(
    fakes.execute ??
      (async () => ({
        kind: "meetup-list" as const,
        meetups: fakes.meetups ?? [],
      })),
  );
  const { logger } = createCapturingLogger();
  const communityChat = createCommunityChat({
    chatId: community,
    commands: communityChatCommands({ auction: false }),
    logger,
  });
  const harnessed = createHarness(
    { resolve, requestAccess },
    { execute },
    [],
    undefined,
    undefined,
    () => today,
    {
      communityChat,
      ...(fakes.respond === undefined ? {} : { respond: fakes.respond }),
    },
  );
  return { ...harnessed, resolve, requestAccess, execute };
}

type Sent = {
  chat_id: number;
  text: string;
  parse_mode?: string;
  reply_parameters?: unknown;
  ephemeral_message_parameters?: unknown;
  reply_markup?: { inline_keyboard: { text: string; url?: string }[][] };
};

function whispers(calls: readonly RecordedCall[]): Sent[] {
  return calls
    .filter((call) => call.method === "sendMessage")
    .map((call) => call.payload as unknown as Sent);
}

function onlyWhisper(calls: readonly RecordedCall[]): Sent {
  expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
  const [sent] = whispers(calls);
  if (sent === undefined) throw new Error("шёпота нет");
  return sent;
}

function buttons(sent: Sent): { text: string; url?: string }[] {
  return (sent.reply_markup?.inline_keyboard ?? []).flat();
}

function startLink(id: string): string {
  return `https://t.me/${botInfo.username}?start=${meetupDeepLinkPayload(id)}`;
}

describe("whisper to an invisible /meetups in the community chat", () => {
  it("answers the holder of access_hub with the nearest meetups visible to them", async () => {
    const { bot, calls, records } = harness({
      meetups: [later, hidden, past, undated, sooner],
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const sent = onlyWhisper(calls);
    // Шёпот — ответ на невидимую команду её автору (ADR-078, п. 3).
    expect(sent).toMatchObject({
      chat_id: community,
      parse_mode: "HTML",
      reply_parameters: { ephemeral_message_id: 7 },
      ephemeral_message_parameters: { receiver_user_id: person.id },
    });
    expect(sent.text).toBe("<b>Ближайшие сходки</b>");
    // По ссылке `m_…` на каждую видимую сходку, ближайшая первой; скрытая,
    // прошедшая и сходка без даты в шёпот не идут (ADR-078, п. 4).
    expect(buttons(sent)).toEqual([
      { text: "15 ноября · Настолки ↗", url: startLink(sooner.id) },
      { text: "22 ноября · Прогулка ↗", url: startLink(later.id) },
    ]);
    const shown = JSON.stringify(sent);
    for (const absent of [hidden, past, undated]) {
      expect(shown).not.toContain(absent.title);
      expect(shown).not.toContain(meetupDeepLinkPayload(absent.id));
    }
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "community whisper sent",
        fields: expect.objectContaining({
          identity_id: identityId,
          use_case: "find_meetup",
          screen: "whisper-meetups",
          result: "ok",
        }),
      }),
    );
  });

  // Видимость решает Meetups: автору и администратору он отдаёт и скрытую, а
  // шёпот её не несёт ни у кого.
  it("never whispers a hidden meetup, even to an administrator", async () => {
    const { bot, calls } = harness({
      rights: ["access-hub", "manage-members", "manage-meetups"],
      meetups: [hidden],
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const sent = onlyWhisper(calls);
    expect(sent.text).toBe("<b>Ближайшие сходки</b>\n\nБлижайших сходок нет.");
    expect(buttons(sent)).toEqual([
      {
        text: "Открыть бота ↗",
        url: `https://t.me/${botInfo.username}?start=meetups`,
      },
    ]);
  });

  it("names five meetups and leads to the rest in the bot", async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      meetup(
        `66666666-6666-4666-8666-66666666666${index}`,
        `Сходка ${index + 1}`,
        { day: 15 + index },
      ),
    );
    const { bot, calls } = harness({ meetups: many });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const labels = buttons(onlyWhisper(calls)).map((button) => button.text);
    expect(labels).toEqual([
      "15 ноября · Сходка 1 ↗",
      "16 ноября · Сходка 2 ↗",
      "17 ноября · Сходка 3 ↗",
      "18 ноября · Сходка 4 ↗",
      "19 ноября · Сходка 5 ↗",
      "Все сходки в боте ↗",
    ]);
    // Ряд ведёт в раздел «Сходки», а не в пустой чат с ботом (PER-683, Q-7).
    expect(buttons(onlyWhisper(calls)).at(-1)?.url).toBe(
      `https://t.me/${botInfo.username}?start=meetups`,
    );
  });

  // Заявка из чата не ставится (ADR-078, п. 3): её ставит кнопка кадра в
  // личке, куда ведёт «Открыть бота».
  it("whispers «invitation only» without meetups to a person without hub access", async () => {
    const { bot, calls, requestAccess, execute } = harness({
      rights: ["place-bids"],
      meetups: [sooner],
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const sent = onlyWhisper(calls);
    expect(sent.text).toContain(
      "<b>Бот сообщества — только по приглашению.</b>",
    );
    expect(sent.text).not.toContain("Настолки");
    expect(buttons(sent)).toEqual([
      {
        text: "Открыть бота ↗",
        url: `https://t.me/${botInfo.username}?start=meetups`,
      },
    ]);
    expect(requestAccess).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a blocked person with the private chat frame", async () => {
    const { bot, calls, execute, records } = harness({
      blocked: true,
      rights: [],
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const sent = onlyWhisper(calls);
    expect(sent.text).toBe(
      "<b>Доступ к Solguficky Hub закрыт.</b>\n\nЕсли считаешь, что это ошибка, обратись к администратору в общем чате сообщества.",
    );
    expect(sent.reply_markup).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        message: "hub access denied",
        fields: expect.objectContaining({
          error_category: "authorization",
          error: "hub_access_blocked",
        }),
      }),
    );
  });

  it("whispers unavailability when Identity fails", async () => {
    const { bot, calls, execute, records } = harness({
      resolve: {
        kind: "unavailable",
        cause: new Error("connect ECONNREFUSED"),
      },
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const sent = onlyWhisper(calls);
    expect(sent.text).toBe(
      "<b>Не получилось загрузить данные.</b> Это на моей стороне.\n\nПовтори команду через минуту.",
    );
    expect(sent.reply_markup).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "identity unavailable",
        fields: expect.objectContaining({
          error_category: "dependency_unavailable",
          screen: "whisper-unavailable",
        }),
      }),
    );
  });

  it("whispers unavailability when Meetups fails after Identity", async () => {
    const { bot, calls, records } = harness({
      execute: async () => ({
        kind: "dependency-rejected",
        reason: "unavailable",
      }),
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    expect(onlyWhisper(calls).text).toContain(
      "Не получилось загрузить данные.",
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "meetup list rejected",
        fields: expect.objectContaining({
          identity_id: identityId,
          error_category: "dependency_unavailable",
        }),
      }),
    );
  });

  // «Печатает…» в группе увидели бы все, поэтому шёпот идёт мимо ожидания
  // лички даже у медленного Identity.
  it("shows no typing in the chat while services answer slowly", async () => {
    vi.useFakeTimers();
    try {
      const { bot, calls, resolve } = harness({ meetups: [sooner] });
      resolve.mockImplementation(
        () =>
          new Promise((done) =>
            setTimeout(
              () =>
                done({
                  kind: "resolved",
                  identityId,
                  rights: ["access-hub"],
                  blocked: false,
                }),
              3_000,
            ),
          ),
      );
      await bot.init();
      const handled = bot.handleUpdate(invisible("/meetups"));
      await vi.advanceTimersByTimeAsync(3_000);
      await handled;
      expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Бюджет сервисов — тот же, что у действия в личке, и укладывается в окно
  // шёпота в 15 секунд (ADR-078).
  it("gives the services a deadline well inside the whisper window", async () => {
    const { bot, resolve } = harness({ meetups: [sooner] });
    await bot.init();
    const before = Date.now();
    await bot.handleUpdate(invisible("/meetups"));
    const deadlineAt = resolve.mock.calls[0]?.[1]?.deadlineAt;
    expect(deadlineAt).toBeDefined();
    expect((deadlineAt ?? 0) - before).toBeLessThanOrEqual(10_000);
  });

  // Окно идёт от команды, а не от начала обработки: команда, которая ждала в
  // очереди update'ов, получает остаток окна, а не полный бюджет.
  it("caps the services deadline by what is left of the window", async () => {
    const { bot, resolve } = harness({ meetups: [sooner] });
    await bot.init();
    const sent = Math.floor(Date.now() / 1_000) - 12;
    await bot.handleUpdate(invisible("/meetups", group(community), sent));
    const deadlineAt = resolve.mock.calls[0]?.[1]?.deadlineAt;
    expect(deadlineAt).toBe(sent * 1_000 + 14_000);
  });

  // Хвост очереди после рестарта: шёпот на такую команду сервер отвергнет,
  // поэтому ни Identity, ни Meetups её не видят.
  it("skips a command whose whisper window has passed", async () => {
    const { bot, calls, resolve, records } = harness({ meetups: [sooner] });
    await bot.init();
    const sent = Math.floor(Date.now() / 1_000) - 20;
    await bot.handleUpdate(invisible("/meetups", group(community), sent));
    expect(calls).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "community whisper window expired",
        fields: expect.objectContaining({ use_case: "find_meetup" }),
      }),
    );
  });

  it("answers a command addressed to this bot by name", async () => {
    const { bot, calls } = harness({ meetups: [sooner] });
    await bot.init();
    await bot.handleUpdate(invisible(`/meetups@${botInfo.username}`));
    expect(whispers(calls)).toHaveLength(1);
  });

  it("stays silent on a command to another bot", async () => {
    const { bot, calls, resolve } = harness({ meetups: [sooner] });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups@other_bot"));
    expect(calls).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  // Обычную команду и ответ на неё увидели бы все: бот на неё молчит.
  it("stays silent on a visible /meetups in the chat", async () => {
    const { bot, calls, resolve } = harness({ meetups: [sooner] });
    await bot.init();
    await bot.handleUpdate(visibleCommand("/meetups"));
    expect(calls).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  // Команда, которой нет в реестре, — например, `/lot` до PER-685, — без
  // ответа.
  it("stays silent on an invisible command outside the registry", async () => {
    const { bot, calls, resolve } = harness();
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    expect(calls).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  // Недоставку бот не наблюдает и не дублирует (ADR-078, п. 5): отказ
  // Telegram пишется в лог, повтора нет, а меню чата сверяется как прежде.
  it("writes a refused whisper to the log and does not repeat it", async () => {
    const { bot, calls, commands, records } = harness({
      meetups: [sooner],
      respond: (method) =>
        method === "sendMessage"
          ? {
              ok: false,
              error_code: 400,
              description: "Bad Request: BOT_NOT_ADMIN",
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    expect(whispers(calls)).toHaveLength(1);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "community whisper not sent",
        fields: expect.objectContaining({
          error_category: "dependency_unavailable",
          screen: "whisper-meetups",
        }),
      }),
    );
    expect(commands.map((call) => call.method)).toEqual(["setMyCommands"]);
  });

  // Запись границы называет человека `identity_id`, а не Telegram id.
  it("keeps the Telegram id out of the boundary record", async () => {
    const { bot, records } = harness({ meetups: [sooner] });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    const record = records.find(
      (entry) => entry.message === "community whisper sent",
    );
    expect(record).toBeDefined();
    expect(Object.values(record?.fields ?? {})).not.toContain(person.id);
    expect(JSON.stringify(record)).not.toContain(String(community));
  });
});

describe("community whisper registry", () => {
  // Команда — запись реестра со своим кадром: каркас её не знает, а
  // допуск по праву хаба и сам шёпот — его (PER-685 встаёт так же).
  it("routes an invisible command to its entry with an admitted person", async () => {
    const answer = vi.fn<WhisperCommand["answer"]>(async () => ({
      kind: "frame",
      frame: {
        id: "whisper-meetups",
        text: "<b>Ближайшие сходки</b>",
        buttons: [],
      },
    }));
    const identity: IdentityResolver = {
      resolve: async () => ({
        kind: "resolved",
        identityId,
        rights: ["access-hub"],
        blocked: false,
      }),
    };
    const { logger } = createCapturingLogger();
    const bot = createBotShell({
      token: "111:test-token",
      environment: defaultTelegramEnvironment,
      tracing: noopTracing(),
      botInfo,
    });
    bot.use(
      createCommunityWhisper({
        commands: { lot: { useCase: "view_auction", answer } },
        identity,
        logger,
        today: () => today,
      }),
    );
    const sent: string[] = [];
    bot.api.config.use((_prev, method) => {
      sent.push(method);
      return Promise.resolve({
        ok: true,
        result: { message_id: 0, date: 0, chat: group(community) } as never,
      });
    });
    await bot.handleUpdate(invisible("/lot"));
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({
        person: { identityId, rights: ["access-hub"] },
        botUsername: botInfo.username,
        today,
        meta: expect.objectContaining({ useCase: "view_auction" }),
      }),
    );
    expect(sent).toEqual(["sendMessage"]);
  });
});

describe("parseInvisibleCommand", () => {
  it("reads the command, its author and the ephemeral address", () => {
    expect(
      parseInvisibleCommand(
        invisible("/meetups extra", group(community), 1_794_660_000),
        "stub_bot",
      ),
    ).toEqual({
      name: "meetups",
      chatId: community,
      ephemeralMessageId: 7,
      sentAt: 1_794_660_000_000,
      telegramUserId: person.id,
    });
  });

  it("ignores a private chat, a plain text and a bot author", () => {
    expect(
      parseInvisibleCommand(
        invisible("/meetups", { id: 42, type: "private", first_name: "t" }),
        "stub_bot",
      ),
    ).toBeUndefined();
    expect(
      parseInvisibleCommand(invisible("привет"), "stub_bot"),
    ).toBeUndefined();
    const fromBot = invisible("/meetups") as { message: { from: unknown } };
    fromBot.message.from = hubBot;
    expect(parseInvisibleCommand(fromBot, "stub_bot")).toBeUndefined();
  });
});

// Подписка кнопкой на шёпоте (PER-686; ADR-078, п. 5): тот же
// `SetSubscription`, что у карточки в личке, через настоящий диспетчер над
// Meetups и Notifications в памяти — состояние после нажатия видно повтором
// команды и в карточке сходки.
describe("subscription toggle on the meetups whisper", () => {
  function snapshot(summary: MeetupSummary): MeetupSnapshot {
    return {
      id: summary.id,
      author: identityId,
      title: summary.title,
      description: "",
      venue: "",
      lifecycle: "planned",
      visibility: summary.visibility,
      version: 1,
      materials: [],
      organizers: [],
      ...(summary.schedule === undefined
        ? {}
        : { schedule: { ...summary.schedule, hours: 19, minutes: 0 } }),
    };
  }

  type Setup = {
    meetups?: readonly MeetupSummary[];
    rights?: readonly AccessRight[];
    resolve?: ResolveIdentityResult;
    // Сходка, чтение подписки которой отказывает.
    unreadable?: string;
    failWrite?: boolean;
    // Сходка, которую Meetups перестал отдавать карточкой: её скрыли между
    // списком и записью.
    vanished?: string;
  };

  function subscriptionHarness(setup: Setup = {}) {
    const listed = setup.meetups ?? [sooner, later];
    const subscribed = new Set<string>();
    const preferences = (meetupId: string) => ({
      kind: "ok" as const,
      preferences: {
        meetupId,
        subscribed: subscribed.has(meetupId),
        categories: [],
      },
    });
    const meetups = {
      listVisible: async () => ({ kind: "ok" as const, meetups: listed }),
      get: async (_person: unknown, id: string) => {
        const found = listed.find((entry) => entry.id === id);
        return found === undefined || id === setup.vanished
          ? { kind: "not-found" as const }
          : { kind: "ok" as const, meetup: snapshot(found) };
      },
    } as unknown as Meetups;
    const setSubscription = vi.fn(
      async (_identityId: string, meetupId: string, value: boolean) => {
        if (setup.failWrite === true) {
          return { kind: "unavailable" as const, cause: new Error("down") };
        }
        if (value) subscribed.add(meetupId);
        else subscribed.delete(meetupId);
        return preferences(meetupId);
      },
    );
    const notifications = {
      getMeetupPreferences: async (_identityId: string, meetupId: string) =>
        meetupId === setup.unreadable
          ? { kind: "unavailable" as const, cause: new Error("down") }
          : preferences(meetupId),
      setSubscription,
    } as unknown as Notifications;
    const resolve = vi.fn<IdentityResolver["resolve"]>(
      async () =>
        setup.resolve ?? {
          kind: "resolved",
          identityId,
          rights: setup.rights ?? ["access-hub"],
          blocked: false,
        },
    );
    const { logger } = createCapturingLogger();
    const communityChat = createCommunityChat({
      chatId: community,
      commands: communityChatCommands({ auction: false }),
      logger,
    });
    const harnessed = createHarness(
      { resolve },
      createDispatcher(meetups, notifications),
      [],
      undefined,
      undefined,
      () => today,
      { communityChat },
    );
    return { ...harnessed, resolve, setSubscription, subscribed };
  }

  type Key = { text: string; url?: string; callback_data?: string };
  type Edited = {
    chat_id: number;
    receiver_user_id: number;
    ephemeral_message_id: number;
    text: string;
    reply_markup?: { inline_keyboard: Key[][] };
  };

  function keys(sent: { reply_markup?: { inline_keyboard: Key[][] } }) {
    return (sent.reply_markup?.inline_keyboard ?? []).flat();
  }

  function edits(calls: readonly RecordedCall[]): Edited[] {
    return calls
      .filter((call) => call.method === "editEphemeralMessageText")
      .map((call) => call.payload as unknown as Edited);
  }

  function lastEdit(calls: readonly RecordedCall[]): Edited {
    const edited = edits(calls).at(-1);
    if (edited === undefined) throw new Error("шёпот не правился");
    return edited;
  }

  // Нажатие на шёпоте: адрес — `ephemeral_message_id` самого шёпота в чате
  // сообщества, `date` у нажатия нет.
  function whisperPress(data: string): Update {
    return {
      update_id: 2,
      callback_query: {
        id: "press-1",
        chat_instance: "chat-1",
        from: person,
        data,
        message: {
          message_id: 0,
          ephemeral_message_id: 8,
          date: 0,
          chat: group(community),
          from: hubBot,
          text: "Ближайшие сходки",
        },
      },
    } as unknown as Update;
  }

  function privatePress(data: string): Update {
    return {
      update_id: 3,
      callback_query: {
        id: "press-2",
        chat_instance: "chat-2",
        from: person,
        data,
        message: {
          message_id: 9,
          date: 0,
          chat: { id: person.id, type: "private", first_name: "tester" },
          text: "Сходки",
        },
      },
    } as unknown as Update;
  }

  const subscribe = (id: string) => `v1:w:sub:${uuidToToken(id)}:1`;
  const unsubscribe = (id: string) => `v1:w:sub:${uuidToToken(id)}:0`;

  it("puts a subscribe toggle under the link of every meetup", async () => {
    const { bot, calls } = subscriptionHarness();
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    expect(keys(onlyWhisper(calls) as never)).toEqual([
      { text: "15 ноября · Настолки ↗", url: startLink(sooner.id) },
      { text: "🔔 Подписаться на сходку", callback_data: subscribe(sooner.id) },
      { text: "22 ноября · Прогулка ↗", url: startLink(later.id) },
      { text: "🔔 Подписаться на сходку", callback_data: subscribe(later.id) },
    ]);
  });

  it("subscribes on a press, unsubscribes on the next and shows the state", async () => {
    const { bot, calls, setSubscription, subscribed, records } =
      subscriptionHarness();
    await bot.init();
    await bot.handleUpdate(whisperPress(subscribe(sooner.id)));
    expect(setSubscription).toHaveBeenLastCalledWith(
      identityId,
      sooner.id,
      true,
      expect.anything(),
    );
    expect(subscribed.has(sooner.id)).toBe(true);
    // Шёпот правится по трём адресным параметрам, а не `editMessageText`.
    const first = lastEdit(calls);
    expect(first).toMatchObject({
      chat_id: community,
      receiver_user_id: person.id,
      ephemeral_message_id: 8,
      text: "<b>Ближайшие сходки</b>",
    });
    expect(keys(first)[1]).toEqual({
      text: "🔕 Отписаться",
      callback_data: unsubscribe(sooner.id),
    });
    expect(keys(first)[3]?.text).toBe("🔔 Подписаться на сходку");
    expect(calls.map((call) => call.method)).toContain("answerCallbackQuery");
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "info",
        message: "community whisper sent",
        fields: expect.objectContaining({
          use_case: "manage_notifications",
          screen: "whisper-meetups",
          identity_id: identityId,
        }),
      }),
    );

    await bot.handleUpdate(whisperPress(unsubscribe(sooner.id)));
    expect(setSubscription).toHaveBeenLastCalledWith(
      identityId,
      sooner.id,
      false,
      expect.anything(),
    );
    expect(subscribed.has(sooner.id)).toBe(false);
    expect(keys(lastEdit(calls))[1]).toEqual({
      text: "🔔 Подписаться на сходку",
      callback_data: subscribe(sooner.id),
    });
  });

  it("shows the same state in a repeated command and in the card in the bot", async () => {
    const { bot, calls } = subscriptionHarness();
    await bot.init();
    await bot.handleUpdate(whisperPress(subscribe(later.id)));
    calls.length = 0;
    await bot.handleUpdate(invisible("/meetups"));
    expect(keys(onlyWhisper(calls) as never)[3]?.text).toBe("🔕 Отписаться");
    calls.length = 0;
    await bot.handleUpdate(privatePress(`v1:view:${uuidToToken(later.id)}`));
    const card = calls
      .filter((call) =>
        ["sendMessage", "editMessageText", "sendRichMessage"].includes(
          call.method,
        ),
      )
      .map(
        (call) =>
          call.payload as { reply_markup?: { inline_keyboard: Key[][] } },
      )
      .at(-1);
    expect(card).toBeDefined();
    const labels = keys(card ?? {}).map((key) => key.text);
    expect(labels).toContain("🔕 Отписаться");
    expect(labels).not.toContain("🔔 Подписаться на сходку");
  });

  // Подделанная кнопка: скрытая сходка, которую Meetups отдаёт автору и
  // администратору, прошедшая, невидимая человеку и мусор вместо токена.
  it("leaves the subscription alone on a forged press of a meetup the whisper could not show", async () => {
    const { bot, calls, setSubscription, records } = subscriptionHarness({
      rights: ["access-hub", "manage-members", "manage-meetups"],
      meetups: [sooner, hidden, past],
    });
    await bot.init();
    const foreign = "77777777-7777-4777-8777-777777777777";
    for (const data of [
      subscribe(hidden.id),
      subscribe(past.id),
      subscribe(foreign),
      "v1:w:sub:not-a-token:1",
      `v1:w:sub:${uuidToToken(sooner.id)}:2`,
    ]) {
      await bot.handleUpdate(whisperPress(data));
    }
    expect(setSubscription).not.toHaveBeenCalled();
    // Шёпот показывает текущий список — в нём только то, что можно шепнуть.
    const shown = JSON.stringify(lastEdit(calls));
    expect(shown).toContain("Настолки");
    expect(shown).not.toContain(hidden.title);
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "community whisper action refused",
        fields: expect.objectContaining({
          error_category: "visibility",
          error: "meetup is not whisperable",
        }),
      }),
    );
  });

  // Тот же порядок, что у карточки: состояние на кнопке — факт, и без ответа
  // Notifications переключателя нет, а список уходит.
  it("drops only the toggle of a meetup whose subscription did not read", async () => {
    const { bot, calls } = subscriptionHarness({ unreadable: later.id });
    await bot.init();
    await bot.handleUpdate(invisible("/meetups"));
    expect(keys(onlyWhisper(calls) as never).map((key) => key.text)).toEqual([
      "15 ноября · Настолки ↗",
      "🔔 Подписаться на сходку",
      "22 ноября · Прогулка ↗",
    ]);
  });

  it("turns the whisper into unavailability when the subscription is not written", async () => {
    const { bot, calls, records } = subscriptionHarness({ failWrite: true });
    await bot.init();
    await bot.handleUpdate(whisperPress(subscribe(sooner.id)));
    const edited = lastEdit(calls);
    expect(edited.text).toContain("Не получилось загрузить данные.");
    expect(edited.reply_markup).toBeUndefined();
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "meetup subscription rejected",
        fields: expect.objectContaining({
          screen: "whisper-unavailable",
          error_category: "dependency_unavailable",
        }),
      }),
    );
  });

  // Намерение лички пишет до чтения сходки: запись прошла, а сходку скрыли.
  // Исход известен Notifications, и шёпот показывает его, а не недоступность.
  it("shows the written state when the meetup vanished after the write", async () => {
    const { bot, calls, setSubscription, records } = subscriptionHarness({
      vanished: sooner.id,
    });
    await bot.init();
    await bot.handleUpdate(whisperPress(subscribe(sooner.id)));
    expect(setSubscription).toHaveBeenCalledTimes(1);
    const edited = lastEdit(calls);
    expect(edited.text).toBe("<b>Ближайшие сходки</b>");
    expect(keys(edited)[1]?.text).toBe("🔕 Отписаться");
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "community whisper action refused",
        fields: expect.objectContaining({ error_category: "visibility" }),
      }),
    );
  });

  it("answers a press of a person without hub access with «invitation only» and writes nothing", async () => {
    const { bot, calls, setSubscription } = subscriptionHarness({
      rights: ["place-bids"],
    });
    await bot.init();
    await bot.handleUpdate(whisperPress(subscribe(sooner.id)));
    expect(setSubscription).not.toHaveBeenCalled();
    expect(lastEdit(calls).text).toContain(
      "<b>Бот сообщества — только по приглашению.</b>",
    );
  });

  // Нажатие на шёпоте забирает каркас целиком: с данными не из домена шёпота
  // оно не доходит до обработчиков лички и шёпот не трогает.
  it("only answers a press with data outside the whisper actions", async () => {
    const { bot, calls, resolve } = subscriptionHarness();
    await bot.init();
    for (const data of [
      `v1:view:${uuidToToken(sooner.id)}`,
      "v1:w:lot:x",
      "v1:w:",
    ]) {
      await bot.handleUpdate(whisperPress(data));
    }
    expect(calls.map((call) => call.method)).toEqual([
      "answerCallbackQuery",
      "answerCallbackQuery",
      "answerCallbackQuery",
    ]);
    expect(resolve).not.toHaveBeenCalled();
  });

  // У нажатия нет `date`: окно идёт от приёма, и бюджет сервисов не выходит
  // за него.
  it("keeps the services deadline inside the window of the press", async () => {
    const { bot, resolve } = subscriptionHarness();
    await bot.init();
    const before = Date.now();
    await bot.handleUpdate(whisperPress(subscribe(sooner.id)));
    const deadlineAt = resolve.mock.calls[0]?.[1]?.deadlineAt ?? 0;
    expect(deadlineAt - before).toBeLessThanOrEqual(14_000);
    expect(deadlineAt).toBeGreaterThan(before);
  });
});

describe("parseWhisperPress", () => {
  const base = {
    id: "q",
    chat_instance: "c",
    from: person,
    message: {
      message_id: 0,
      ephemeral_message_id: 8,
      date: 0,
      chat: group(community),
    },
  };

  it("reads the action, its argument and the whisper address", () => {
    expect(
      parseWhisperPress({
        callback_query: { ...base, data: "v1:w:sub:abc:1" },
      }),
    ).toEqual({
      callbackQueryId: "q",
      action: { name: "sub", argument: "abc:1" },
      chatId: community,
      ephemeralMessageId: 8,
      telegramUserId: person.id,
    });
  });

  it("ignores a press under an ordinary message", () => {
    const { ephemeral_message_id: _, ...message } = base.message;
    expect(
      parseWhisperPress({
        callback_query: { ...base, message: { ...message, message_id: 5 } },
      }),
    ).toBeUndefined();
  });
});
