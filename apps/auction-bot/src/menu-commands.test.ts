import type { Api } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { LogFields, Logger } from "./logging.js";
import { registerCommands } from "./menu-commands.js";

function capturingLogger() {
  const records: { level: string; message: string; fields: LogFields }[] = [];
  const write = (level: string) => (message: string, fields?: LogFields) => {
    records.push({ level, message, fields: fields ?? {} });
  };
  const logger: Logger = {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
  };
  return { logger, records };
}

describe("bot command menu", () => {
  it("registers the menu and FAQ commands for private chats", async () => {
    const setMyCommands = vi.fn<Api["setMyCommands"]>().mockResolvedValue(true);
    const { logger, records } = capturingLogger();
    await registerCommands({ setMyCommands }, logger);
    expect(setMyCommands).toHaveBeenCalledWith(
      [
        { command: "start", description: "Меню аукциона" },
        { command: "faq", description: "Правила и FAQ" },
      ],
      { scope: { type: "all_private_chats" } },
    );
    expect(records.map((record) => record.level)).toEqual(["info"]);
  });

  // Меню — удобство: отказ Telegram не останавливает процесс до polling.
  it("logs a Telegram refusal instead of throwing", async () => {
    const setMyCommands = vi
      .fn<Api["setMyCommands"]>()
      .mockRejectedValue(new Error("telegram is down"));
    const { logger, records } = capturingLogger();
    await registerCommands({ setMyCommands }, logger);
    expect(records).toEqual([
      {
        level: "warn",
        message: "bot commands not registered",
        fields: {
          error_category: "dependency_unavailable",
          error: "telegram is down",
        },
      },
    ]);
  });
});
