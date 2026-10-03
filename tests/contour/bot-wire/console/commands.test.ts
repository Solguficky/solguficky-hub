import {
  describe,
  expect,
  it,
} from "../../../../apps/hub-bot/testkit/index.js";
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

  it("разбирает пересылку поста, файл и задержку сервиса", () => {
    expect(parseCommand("alice forward solguficky_contour 77")).toEqual({
      kind: "forward",
      who: "alice",
      channel: "solguficky_contour",
      postId: 77,
    });
    expect(parseCommand("alice document Программа вечера.pdf")).toEqual({
      kind: "document",
      who: "alice",
      fileName: "Программа вечера.pdf",
    });
    expect(parseCommand("alice photo")).toEqual({
      kind: "photo",
      who: "alice",
    });
    expect(parseCommand("slow meetups 2500")).toEqual({
      kind: "slow",
      service: "meetups",
      delayMs: 2500,
    });
    expect(parseCommand("slow identity 0")).toEqual({
      kind: "slow",
      service: "identity",
      delayMs: 0,
    });
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
    ["new slow admin", "имя"],
    ["alice forward @канал 77", "ник канала"],
    ["alice forward solguficky 0", "номер поста"],
    ["alice forward solguficky 9007199254740993", "номер поста"],
    ["alice document", "имя файла"],
    ["alice photo лишнее", "аргумент"],
    ["slow notifications 100", "сервис"],
    ["slow meetups быстро", "задержка"],
    ["slow meetups 60001", "задержка"],
  ])("отвергает «%s» с причиной про %s", (line, reason) => {
    expect(() => parseCommand(line)).toThrow(CommandError);
    expect(() => parseCommand(line)).toThrow(new RegExp(reason, "i"));
  });
});
