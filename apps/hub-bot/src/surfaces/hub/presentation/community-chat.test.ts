import type { Chat, Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createCapturingLogger,
  createHarness,
  type HarnessOptions,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type { AccessRight } from "../../../auction-ui/index.js";
import { createDispatcher } from "../application/dispatcher.js";
import type { IdentityResolver } from "../identity/port.js";
import { communityChatCommands } from "./commands.js";
import { createCommunityChat } from "./community-chat.js";

// Допуск групп (ADR-078, п. 2; PER-682): бот хаба работает в личке и в чате
// сообщества, из чужой группы выходит на первом update, а миграция чата
// сообщества в супергруппу выхода не вызывает и называет новый id в логе.

const community = -4012345678;
const migrated = -1004012345678;
const foreign = -4099999999;
const person = { id: 42, is_bot: false, first_name: "tester" } as const;

function group(id: number): Chat.GroupChat {
  return { id, type: "group", title: "чат" };
}

function message(chat: Chat, text: string, extra: object = {}): Update {
  return {
    update_id: 1,
    message: { message_id: 1, date: 0, chat, from: person, text, ...extra },
  } as Update;
}

function botMembership(chat: Chat, status: "member" | "left"): Update {
  const bot = { id: 999, is_bot: true, first_name: "hub" };
  return {
    update_id: 1,
    my_chat_member: {
      chat,
      from: person,
      date: 0,
      old_chat_member: { status: "left", user: bot },
      new_chat_member: { status, user: bot },
    },
  } as Update;
}

// Счётчик разрешений личности: update, который не дошёл до юзкейсов, Identity
// не спрашивает.
function countingIdentity(
  rights: readonly AccessRight[],
): IdentityResolver & { resolved: number } {
  const identity = {
    resolved: 0,
    resolve: async () => {
      identity.resolved += 1;
      return {
        kind: "resolved" as const,
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        rights,
        blocked: false,
      };
    },
  };
  return identity;
}

function harness(
  options: {
    communityChat?: boolean;
    respond?: HarnessOptions["respond"];
    rights?: readonly AccessRight[];
  } = {},
) {
  const { logger, records } = createCapturingLogger();
  const identity = countingIdentity(options.rights ?? ["access-hub"]);
  const communityChat =
    options.communityChat === false
      ? undefined
      : createCommunityChat({
          chatId: community,
          commands: communityChatCommands({ auction: true }),
          logger,
        });
  const harnessed = createHarness(
    identity,
    createDispatcher(),
    [],
    undefined,
    undefined,
    undefined,
    {
      ...(communityChat === undefined ? {} : { communityChat }),
      ...(options.respond === undefined ? {} : { respond: options.respond }),
    },
  );
  return { ...harnessed, identity, gateRecords: records, communityChat };
}

function methods(calls: readonly RecordedCall[]): string[] {
  return calls.map((call) => call.method);
}

describe("community chat admission", () => {
  it("leaves a foreign group on its first update and handles nothing there", async () => {
    const { bot, calls, commands, identity, gateRecords } = harness();
    await bot.init();
    await bot.handleUpdate(message(group(foreign), "/meetups"));
    expect(calls).toEqual([
      { method: "leaveChat", payload: { chat_id: foreign } },
    ]);
    expect(commands).toEqual([]);
    expect(identity.resolved).toBe(0);
    expect(gateRecords).toEqual([
      expect.objectContaining({
        level: "info",
        message: "foreign group left",
        fields: expect.objectContaining({ operation: "message", result: "ok" }),
      }),
    ]);
    expect(JSON.stringify(gateRecords)).not.toContain(String(foreign));
  });

  it("leaves a foreign group it has just been added to", async () => {
    const supergroup: Chat = {
      id: -1009999999,
      type: "supergroup",
      title: "x",
    };
    const { bot, calls } = harness();
    await bot.init();
    await bot.handleUpdate(botMembership(supergroup, "member"));
    expect(calls).toEqual([
      { method: "leaveChat", payload: { chat_id: -1009999999 } },
    ]);
  });

  // Выход сам приходит update `my_chat_member` со статусом `left`: второй
  // выход из группы, где бота уже нет, Telegram бы отверг.
  it("does not leave again a group the bot is already out of", async () => {
    const { bot, calls, gateRecords } = harness();
    await bot.init();
    await bot.handleUpdate(botMembership(group(foreign), "left"));
    expect(calls).toEqual([]);
    expect(gateRecords.map((record) => record.message)).toEqual([
      "foreign group update ignored",
    ]);
  });

  it("keeps the update out of the use cases when leaving fails", async () => {
    const { bot, calls, identity, gateRecords } = harness({
      respond: (method) =>
        method === "leaveChat"
          ? { ok: false, error_code: 400, description: "Bad Request" }
          : true,
    });
    await bot.init();
    await bot.handleUpdate(message(group(foreign), "/meetups"));
    expect(methods(calls)).toEqual(["leaveChat"]);
    expect(identity.resolved).toBe(0);
    expect(gateRecords).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "foreign group not left",
        fields: expect.objectContaining({
          result: "error",
          error_category: "dependency_unavailable",
        }),
      }),
    ]);
  });

  it("stays in the supergroup the community chat migrated to and logs its id", async () => {
    const supergroup: Chat = { id: migrated, type: "supergroup", title: "чат" };
    const { bot, calls, identity, gateRecords } = harness();
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: supergroup,
        from: person,
        migrate_from_chat_id: community,
      },
    } as Update);
    expect(calls).toEqual([]);
    expect(identity.resolved).toBe(0);
    expect(gateRecords).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "community chat migrated",
        fields: expect.objectContaining({ community_chat_id: migrated }),
      }),
    ]);
  });

  // Новый id процесс помнит до рестарта (ADR-078, дополнение 2026-11-13):
  // служебное событие и команда новой супергруппы выхода не вызывают и до
  // юзкейсов не доходят, а лог называет id один раз.
  it("remembers the supergroup the community chat migrated to until restart", async () => {
    const supergroup: Chat = { id: migrated, type: "supergroup", title: "чат" };
    const migration = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: supergroup,
        from: person,
        migrate_from_chat_id: community,
      },
    } as Update;
    const { bot, calls, commands, identity, gateRecords } = harness();
    await bot.init();
    await bot.handleUpdate(migration);
    await bot.handleUpdate(
      message(supergroup, "", {
        new_chat_members: [{ id: 7, is_bot: false, first_name: "new" }],
      }),
    );
    await bot.handleUpdate(message(supergroup, "/meetups"));
    expect(calls).toEqual([]);
    expect(commands).toEqual([]);
    expect(identity.resolved).toBe(0);
    expect(gateRecords.map((record) => record.message)).toEqual([
      "community chat migrated",
      "migrated community chat update ignored",
      "migrated community chat update ignored",
    ]);
    // Рестарт без обновлённой настройки: память пуста, и супергруппа для
    // бота — чужая группа.
    const restarted = harness();
    await restarted.bot.init();
    await restarted.bot.handleUpdate(message(supergroup, "/meetups"));
    expect(restarted.calls).toEqual([
      { method: "leaveChat", payload: { chat_id: migrated } },
    ]);
  });

  // Старая группа сообщает о миграции полем `migrate_to_chat_id`: оно приходит
  // и раньше сообщения новой супергруппы.
  it("learns the new id from the migration message of the old group", async () => {
    const supergroup: Chat = { id: migrated, type: "supergroup", title: "чат" };
    const { bot, calls, gateRecords } = harness();
    await bot.init();
    await bot.handleUpdate(
      message(group(community), "", { migrate_to_chat_id: migrated }),
    );
    await bot.handleUpdate(message(supergroup, "/meetups"));
    expect(methods(calls)).not.toContain("leaveChat");
    expect(gateRecords).toContainEqual(
      expect.objectContaining({
        message: "community chat migrated",
        fields: expect.objectContaining({ community_chat_id: migrated }),
      }),
    );
  });

  // Связь — только из служебного поля: другое значение `migrate_to_chat_id` в
  // чужой группе ничего не открывает.
  it("still leaves a foreign group after a migration", async () => {
    const { bot, calls } = harness();
    await bot.init();
    await bot.handleUpdate(
      message(group(community), "", { migrate_to_chat_id: migrated }),
    );
    await bot.handleUpdate(
      message(group(foreign), "", { migrate_to_chat_id: migrated }),
    );
    await bot.handleUpdate(message(group(foreign), "/meetups"));
    expect(calls).toEqual([
      { method: "leaveChat", payload: { chat_id: foreign } },
      { method: "leaveChat", payload: { chat_id: foreign } },
    ]);
  });

  it("stays in the community chat and writes its invisible commands", async () => {
    const { bot, calls, commands } = harness();
    await bot.init();
    await bot.handleUpdate(message(group(community), "/meetups"));
    await bot.handleUpdate(message(group(community), "/lot"));
    // Ответы на команды — соседние листья (PER-683, PER-685): здесь только
    // допуск, поэтому в чате бот пока молчит.
    expect(calls).toEqual([]);
    expect(commands).toEqual([
      {
        method: "setMyCommands",
        payload: {
          commands: [
            { command: "meetups", description: "Сходки", is_ephemeral: true },
            { command: "lot", description: "Лот финала", is_ephemeral: true },
          ],
          scope: { type: "chat", chat_id: community },
        },
      },
    ]);
  });

  // Нажатие из чата сообщества доходит до юзкейсов и разрешает личность, но
  // список команд по правам человека пишется только в его личный чат: в чате
  // сообщества он заменил бы невидимые команды.
  it("keeps the person's command list out of the community chat", async () => {
    const { bot, commands } = harness({
      rights: ["access-hub", "manage-members", "manage-meetups"],
    });
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "callback-1",
        chat_instance: "chat-1",
        from: person,
        data: "v1:nav:hub",
        message: { message_id: 9, date: 0, chat: group(community) },
      },
    } as Update);
    expect(commands).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          scope: { type: "chat", chat_id: community },
          commands: communityChatCommands({ auction: true }),
        }),
      }),
    ]);
  });

  // Канал медиа ботов — не группа: бот хаба в нём администратор (ADR-057).
  it("does not leave a channel", async () => {
    const { bot, calls } = harness();
    await bot.init();
    await bot.handleUpdate({
      update_id: 1,
      channel_post: {
        message_id: 1,
        date: 0,
        chat: { id: -1001234567890, type: "channel", title: "медиа" },
        text: "пост",
      },
    } as Update);
    expect(methods(calls)).not.toContain("leaveChat");
  });

  it("ignores groups and leaves none without the community chat", async () => {
    const { bot, calls, commands, identity } = harness({
      communityChat: false,
    });
    await bot.init();
    await bot.handleUpdate(message(group(foreign), "/meetups"));
    await bot.handleUpdate(botMembership(group(foreign), "member"));
    expect(calls).toEqual([]);
    expect(commands).toEqual([]);
    expect(identity.resolved).toBe(0);
  });

  // Личка с чатом сообщества и без него отвечает одинаково, а список команд
  // по правам в чат сообщества не пишется.
  it("leaves the private chat as it was", async () => {
    const start = message(
      { id: 42, type: "private", first_name: "tester" },
      "/start",
    );
    const without = harness({ communityChat: false });
    await without.bot.init();
    await without.bot.handleUpdate(start);
    const withChat = harness();
    await withChat.bot.init();
    await withChat.bot.handleUpdate(start);
    expect(withChat.calls).toEqual(without.calls);
    expect(withChat.commands).toEqual(without.commands);
    expect(methods(withChat.calls)).toContain("sendMessage");
  });
});

describe("community chat commands", () => {
  it("names the final lot only with Auction", () => {
    expect(communityChatCommands({ auction: false })).toEqual([
      { command: "meetups", description: "Сходки", is_ephemeral: true },
    ]);
    expect(
      communityChatCommands({ auction: true }).map((entry) => entry.command),
    ).toEqual(["meetups", "lot"]);
  });

  // Запись на старте; отказ Telegram в память не попадает, и следующий
  // update из чата сообщества пишет меню снова — сверка как у лички.
  it("writes the menu on start once and retries it after a refusal", async () => {
    const written: string[] = [];
    let refuse = true;
    const api = {
      setMyCommands: async () => {
        written.push("set");
        if (refuse) throw new Error("Too Many Requests");
        return true as const;
      },
      deleteMyCommands: async () => true as const,
    };
    const { logger, records } = createCapturingLogger();
    const chat = createCommunityChat({
      chatId: community,
      commands: communityChatCommands({ auction: false }),
      logger,
    });
    await chat.registerCommands(api);
    expect(records.map((record) => record.message)).toEqual([
      "chat bot commands not registered",
    ]);
    refuse = false;
    await chat.registerCommands(api);
    await chat.registerCommands(api);
    expect(written).toEqual(["set", "set"]);
  });
});
