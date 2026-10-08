import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "../../../core/logging.js";
import { botCommands, registerCommands } from "./commands.js";

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
  it("registers only /menu with its caption for private chats", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>().mockResolvedValue(true);
    const { logger, records } = capturingLogger();
    await registerCommands({ setMyCommands }, logger);
    expect(setMyCommands).toHaveBeenCalledWith(
      [{ command: "menu", description: "Главное меню" }],
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

  // Разделы открываются кнопками стартового экрана; вторая дорога к ним в
  // меню клиента только удлиняла список.
  it("keeps the menu to a single command", () => {
    expect(botCommands.map((entry) => entry.command)).toEqual(["menu"]);
  });
});
