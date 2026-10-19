import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../../../core/logging.js";
import {
  createChatCommandsSync,
  registerChatCommands,
  registerCommands,
} from "../../../core/menu-commands.js";
import { botCommands, managerCommands } from "./commands.js";

type LogRecord = { level: keyof Logger; message: string; fields: LogFields };

function capturingLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const push =
    (level: keyof Logger): Logger[keyof Logger] =>
    (message, fields) => {
      records.push({ level, message, fields: fields ?? {} });
    };
  return {
    records,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

describe("bot command menu", () => {
  it("registers the section commands for private chats", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>().mockResolvedValue(true);
    const { logger, records } = capturingLogger();
    await registerCommands({ setMyCommands }, botCommands, logger);
    expect(setMyCommands).toHaveBeenCalledWith(
      [
        { command: "menu", description: "Меню" },
        { command: "meetups", description: "Сходки" },
        { command: "next", description: "Ближайшая сходка" },
        { command: "events", description: "События" },
        { command: "settings", description: "Настройки" },
        { command: "help", description: "Помощь" },
      ],
      { scope: { type: "all_private_chats" } },
    );
    expect(records).toEqual([
      { level: "info", message: "bot commands registered", fields: {} },
    ]);
  });

  it("logs a Telegram refusal and resolves instead of throwing", async () => {
    const setMyCommands = vi
      .fn<Api["setMyCommands"]>()
      .mockRejectedValue(new Error("Too Many Requests"));
    const { logger, records } = capturingLogger();
    await expect(
      registerCommands({ setMyCommands }, botCommands, logger),
    ).resolves.toBeUndefined();
    expect(records).toEqual([
      {
        level: "warn",
        message: "bot commands not registered",
        fields: {
          error_category: "dependency_unavailable",
          error: "Too Many Requests",
        },
      },
    ]);
  });

  // `/menu` — корневое меню первым пунктом, затем разделы (PER-592).
  it("puts /manage before /help only in the manager list", () => {
    expect(botCommands.map((entry) => entry.command)).toEqual([
      "menu",
      "meetups",
      "next",
      "events",
      "settings",
      "help",
    ]);
    expect(managerCommands.map((entry) => entry.command)).toEqual([
      "menu",
      "meetups",
      "next",
      "events",
      "settings",
      "manage",
      "help",
    ]);
  });

  it("sets and removes the list of one chat", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>().mockResolvedValue(true);
    const deleteMyCommands = vi
      .fn<Api["deleteMyCommands"]>()
      .mockResolvedValue(true);
    await registerChatCommands(
      { setMyCommands, deleteMyCommands },
      42,
      managerCommands,
    );
    expect(setMyCommands).toHaveBeenCalledWith(managerCommands, {
      scope: { type: "chat", chat_id: 42 },
    });
    await registerChatCommands(
      { setMyCommands, deleteMyCommands },
      42,
      undefined,
    );
    expect(deleteMyCommands).toHaveBeenCalledWith({
      scope: { type: "chat", chat_id: 42 },
    });
  });

  it("logs a refusal of the chat list and resolves", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>();
    const deleteMyCommands = vi
      .fn<Api["deleteMyCommands"]>()
      .mockRejectedValue(new Error("Bad Request"));
    const { logger, records } = capturingLogger();
    await expect(
      registerChatCommands(
        { setMyCommands, deleteMyCommands },
        42,
        undefined,
        logger,
      ),
    ).resolves.toBe(false);
    expect(records.map((record) => record.message)).toEqual([
      "chat bot commands not registered",
    ]);
  });
});

// Сверка списка команд чата на каждом действии (PER-592): Telegram получает
// вызов только при расхождении с тем, что процесс уже записал.
describe("chat commands sync", () => {
  function fakeApi() {
    const setMyCommands = vi.fn<Api["setMyCommands"]>().mockResolvedValue(true);
    const deleteMyCommands = vi
      .fn<Api["deleteMyCommands"]>()
      .mockResolvedValue(true);
    return { setMyCommands, deleteMyCommands };
  }

  it("writes the list once and again only when the rights change", async () => {
    const api = fakeApi();
    const sync = createChatCommandsSync();
    await sync(api, 42, managerCommands);
    await sync(api, 42, managerCommands);
    expect(api.setMyCommands).toHaveBeenCalledTimes(1);
    await sync(api, 42, undefined);
    await sync(api, 42, undefined);
    expect(api.deleteMyCommands).toHaveBeenCalledTimes(1);
    await sync(api, 42, managerCommands);
    expect(api.setMyCommands).toHaveBeenCalledTimes(2);
  });

  // После рестарта память пуста: держателю права список пишется на первом
  // же действии, а чат без своего списка не трогается.
  it("leaves an unseen chat without a list alone", async () => {
    const api = fakeApi();
    const sync = createChatCommandsSync();
    await sync(api, 7, undefined);
    expect(api.deleteMyCommands).not.toHaveBeenCalled();
    await sync(api, 8, managerCommands);
    expect(api.setMyCommands).toHaveBeenCalledWith(managerCommands, {
      scope: { type: "chat", chat_id: 8 },
    });
  });

  it("retries a write Telegram refused on the next action", async () => {
    const api = fakeApi();
    api.setMyCommands.mockRejectedValueOnce(new Error("Too Many Requests"));
    const sync = createChatCommandsSync();
    await sync(api, 42, managerCommands);
    await sync(api, 42, managerCommands);
    expect(api.setMyCommands).toHaveBeenCalledTimes(2);
  });

  it("forgets the oldest chat beyond the limit and writes it again", async () => {
    const api = fakeApi();
    const sync = createChatCommandsSync(undefined, 1);
    await sync(api, 1, managerCommands);
    await sync(api, 2, managerCommands);
    await sync(api, 1, managerCommands);
    expect(api.setMyCommands).toHaveBeenCalledTimes(3);
  });
});
