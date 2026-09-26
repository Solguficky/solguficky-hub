import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../logging.js";
import { botCommands, registerCommands, screenCommands } from "./commands.js";

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
  it("registers every menu command with its caption for private chats", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>().mockResolvedValue(true);
    const { logger, records } = capturingLogger();
    await registerCommands({ setMyCommands }, logger);
    expect(setMyCommands).toHaveBeenCalledWith(
      [
        { command: "start", description: "Главное меню" },
        { command: "meetups", description: "Ближайшие сходки" },
        { command: "archive", description: "Архив сходок" },
        { command: "notifications", description: "Настройки уведомлений" },
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
      registerCommands({ setMyCommands }, logger),
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

  it("routes every menu command except start to the screen of its caption", () => {
    expect(botCommands.map((entry) => entry.command)).toEqual([
      "start",
      ...screenCommands.keys(),
    ]);
    expect(Object.fromEntries(screenCommands)).toEqual({
      meetups: "hub",
      archive: "archive",
      notifications: "notify-global",
    });
  });
});
