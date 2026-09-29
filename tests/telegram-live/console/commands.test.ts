import {
  describe,
  expect,
  it,
} from "../../../apps/telegram-bot/testkit/index.js";
import { CommandError, parseCommand, startPayloadIn } from "./commands.js";

// L0: разбор языка живого пульта. Входит в `vitest.config.ts` бота вместе с
// остальными L0-тестами `tests/telegram-live`; Telegram ему не нужен.

const payload = "m_AZLzpFtsfY6fASNFZ4mrzQ";

describe("язык живого пульта", () => {
  it("берёт хвост текста и подписи как есть", () => {
    expect(parseCommand("press  Ближайшие сходки ")).toEqual({
      kind: "press",
      label: "Ближайшие сходки",
    });
    expect(parseCommand("say 12.06.2027 19:00, «Циферблат»\n")).toEqual({
      kind: "say",
      text: "12.06.2027 19:00, «Циферблат»",
    });
    expect(parseCommand("reply 4312 Новое место")).toEqual({
      kind: "reply",
      message: 4312,
      text: "Новое место",
    });
  });

  it("достаёт payload из ссылки для чата и принимает его голым", () => {
    expect(parseCommand(`link https://t.me/some_bot?start=${payload}`)).toEqual(
      { kind: "link", payload },
    );
    expect(parseCommand(`link ${payload}`)).toEqual({ kind: "link", payload });
    expect(
      startPayloadIn(`Ссылка для чата: https://t.me/b?start=${payload}`),
    ).toBe(payload);
    expect(startPayloadIn("Сходка создана")).toBeUndefined();
  });

  it.each([
    ["", "пустая"],
    ["dance", "действие"],
    ["say", "текст"],
    ["reply x да", "номер"],
    ["reply 5", "текст"],
    ["link https://t.me/some_bot", "ссылка"],
    ["look now", "аргумент"],
  ])("отвергает «%s» с причиной про %s", (line, reason) => {
    expect(() => parseCommand(line)).toThrow(CommandError);
    expect(() => parseCommand(line)).toThrow(new RegExp(reason, "i"));
  });
});
