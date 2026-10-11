import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../../../core/logging.js";
import {
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
        { command: "meetups", description: "Сходки" },
        { command: "next", description: "Ближайшая сходка" },
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

  // Решение владельца 10 октября 2026 года: корневого «Меню» нет, разделы
  // открываются командами; `/menu` в списке больше нет.
  it("puts /manage before /help only in the manager list", () => {
    expect(botCommands.map((entry) => entry.command)).toEqual([
      "meetups",
      "next",
      "settings",
      "help",
    ]);
    expect(managerCommands.map((entry) => entry.command)).toEqual([
      "meetups",
      "next",
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
    ).resolves.toBeUndefined();
    expect(records.map((record) => record.message)).toEqual([
      "chat bot commands not registered",
    ]);
  });
});
