import {
  describe,
  expect,
  it,
} from "../../../../apps/telegram-bot/testkit/index.js";
import { CommandError, parseCommand } from "./commands.js";

// L0: разбор языка пульта. Входит в `vitest.config.ts` бота, а не в контур:
// ни сервисов, ни Docker ему не нужно.

describe("язык пульта", () => {
  it("берёт хвост подписи и текста как есть, с пробелами и знаками", () => {
    expect(parseCommand("alice press  Ближайшие сходки ")).toEqual({
      kind: "press",
      who: "alice",
      label: "Ближайшие сходки",
    });
    expect(parseCommand("bob say 12.06.2027 19:00, «Циферблат»\n")).toEqual({
      kind: "say",
      who: "bob",
      text: "12.06.2027 19:00, «Циферблат»",
    });
  });

  it("разбирает заведение человека, ответ на вопрос и ссылку", () => {
    expect(parseCommand("new alice admin")).toEqual({
      kind: "new",
      who: "alice",
      role: "admin",
    });
    expect(parseCommand("alice answer 2 Новое место")).toEqual({
      kind: "answer",
      who: "alice",
      number: 2,
      text: "Новое место",
    });
    expect(
      parseCommand("bob link 0192F3A4-5B6C-7D8E-9F01-23456789ABCD"),
    ).toEqual({
      kind: "link",
      who: "bob",
      meetupId: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
    });
    expect(parseCommand("people")).toEqual({ kind: "people" });
  });

  it.each([
    ["", "пустая"],
    ["new alice owner", "роль"],
    ["new people admin", "имя"],
    ["Alice say hi", "имя"],
    ["alice dance", "действие"],
    ["alice say", "текст"],
    ["alice answer 0 да", "номер"],
    ["alice link m_abc", "UUID"],
    ["restart now", "аргумент"],
  ])("отвергает «%s» с причиной про %s", (line, reason) => {
    expect(() => parseCommand(line)).toThrow(CommandError);
    expect(() => parseCommand(line)).toThrow(new RegExp(reason, "i"));
  });
});
