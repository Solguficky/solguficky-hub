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
import type { Dispatcher } from "../application/dispatcher.js";
import type {
  IdentityResolver,
  ResolveIdentityResult,
} from "../identity/port.js";
import type { MeetupSummary } from "../meetups/port.js";
import { communityChatCommands } from "./commands.js";
import { createCommunityChat } from "./community-chat.js";
import {
  createCommunityWhisper,
  parseInvisibleCommand,
  type WhisperCommand,
} from "./community-whisper.js";
import { meetupDeepLinkPayload } from "./meetup-deep-link.js";

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
function invisible(text: string, chat: Chat = group(community)): Update {
  return {
    update_id: 1,
    message: {
      message_id: 0,
      ephemeral_message_id: 7,
      date: 0,
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
      { text: "Открыть бота ↗", url: `https://t.me/${botInfo.username}` },
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
      { text: "Открыть бота ↗", url: `https://t.me/${botInfo.username}` },
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
        links: [],
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
      parseInvisibleCommand(invisible("/meetups extra"), "stub_bot"),
    ).toEqual({
      name: "meetups",
      chatId: community,
      ephemeralMessageId: 7,
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
