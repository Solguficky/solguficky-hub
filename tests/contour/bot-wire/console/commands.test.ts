import { describe, expect, it } from "vitest";
import { photoVariants } from "../../../../apps/hub-bot/testkit/index.js";
import { CommandError, parseCommand, photoKinds } from "./commands.js";

// L0: разбор языка пульта. Входит в `vitest.config.ts` пульта, а не в контур:
// ни сервисов, ни Docker ему не нужно.

describe("console command language", () => {
  it("takes the label and text tail verbatim, with spaces and punctuation", () => {
    expect(parseCommand("alice@hub press  Ближайшие сходки ")).toEqual({
      kind: "press",
      who: "alice",
      bot: "hub",
      label: "Ближайшие сходки",
    });
    expect(
      parseCommand("bob@auction say 12.06.2027 19:00, «Циферблат»\n"),
    ).toEqual({
      kind: "say",
      who: "bob",
      bot: "auction",
      text: "12.06.2027 19:00, «Циферблат»",
    });
  });

  it("parses creating a person, answering a question, links and bot restart", () => {
    expect(parseCommand("new alice admin")).toEqual({
      kind: "new",
      who: "alice",
      role: "admin",
    });
    expect(parseCommand("alice@hub answer 2 Новое место")).toEqual({
      kind: "answer",
      who: "alice",
      bot: "hub",
      number: 2,
      text: "Новое место",
    });
    expect(
      parseCommand("bob@hub link 0192F3A4-5B6C-7D8E-9F01-23456789ABCD"),
    ).toEqual({
      kind: "link",
      who: "bob",
      bot: "hub",
      meetupId: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
    });
    expect(parseCommand("bob@auction pick 2 6 октября, вт · 1 лот")).toEqual({
      kind: "pick",
      who: "bob",
      bot: "auction",
      label: "6 октября, вт · 1 лот",
      occurrence: 2,
    });
    expect(parseCommand("bob@hub old Настолки у Алисы")).toEqual({
      kind: "old",
      who: "bob",
      bot: "hub",
      label: "Настолки у Алисы",
    });
    expect(parseCommand("bob@auction raw v1:lot:new:abc")).toEqual({
      kind: "raw",
      who: "bob",
      bot: "auction",
      data: "v1:lot:new:abc",
    });
    expect(parseCommand("people")).toEqual({ kind: "people" });
    expect(parseCommand("restart auction")).toEqual({
      kind: "restart",
      bot: "auction",
    });
  });

  it("parses forwarding, files, photo kinds and service commands", () => {
    expect(parseCommand("alice@hub forward solguficky_contour 77")).toEqual({
      kind: "forward",
      who: "alice",
      bot: "hub",
      channel: "solguficky_contour",
      postId: 77,
    });
    expect(parseCommand("alice@hub document Программа вечера.pdf")).toEqual({
      kind: "document",
      who: "alice",
      bot: "hub",
      fileName: "Программа вечера.pdf",
    });
    expect(parseCommand("alice@hub photo")).toEqual({
      kind: "photo",
      who: "alice",
      bot: "hub",
      photo: "jpeg",
    });
    expect(parseCommand("alice@hub photo big")).toEqual({
      kind: "photo",
      who: "alice",
      bot: "hub",
      photo: "big",
    });
    expect(parseCommand("slow meetups 2500")).toEqual({
      kind: "slow",
      service: "meetups",
      delayMs: 2500,
    });
    expect(parseCommand("slow auction 0")).toEqual({
      kind: "slow",
      service: "auction",
      delayMs: 0,
    });
    expect(parseCommand("down auction")).toEqual({
      kind: "down",
      service: "auction",
    });
    expect(parseCommand("up identity")).toEqual({
      kind: "up",
      service: "identity",
    });
  });

  it("knows the same photo kinds as the hub test kit", () => {
    expect([...photoKinds]).toEqual([...photoVariants]);
  });

  it.each([
    ["", "пустая"],
    ["new alice owner", "роль"],
    ["new people admin", "имя"],
    ["Alice@hub say hi", "имя"],
    ["alice say hi", "не назван бот"],
    ["alice@mail say hi", "бот"],
    ["alice@hub dance", "действие"],
    ["alice@hub say", "текст"],
    ["alice@hub answer 0 да", "номер"],
    ["alice@hub pick 0 Меню", "номер"],
    ["alice@hub pick 2", "подпись"],
    ["alice@hub old", "подпись"],
    ["alice@hub raw", "callback_data"],
    ["alice@hub raw ооооооооооооооооооооооооооооооооо", "64 байт"],
    ["alice@hub link m_abc", "UUID"],
    ["restart", "бот"],
    ["restart hub now", "имя бота"],
    ["new slow admin", "имя"],
    ["alice@hub forward @канал 77", "ник канала"],
    ["alice@hub forward solguficky 0", "номер поста"],
    ["alice@hub forward solguficky 9007199254740993", "номер поста"],
    ["alice@hub document", "имя файла"],
    ["alice@hub photo gif", "вид фото"],
    ["alice@hub photo big лишнее", "вид фото"],
    ["slow notifications 100", "сервис"],
    ["slow meetups быстро", "задержка"],
    ["slow meetups 60001", "задержка"],
    ["down notifications", "сервис"],
    ["up auction now", "имя сервиса"],
  ])("rejects «%s» naming %s", (line, reason) => {
    expect(() => parseCommand(line)).toThrow(CommandError);
    expect(() => parseCommand(line)).toThrow(new RegExp(reason, "i"));
  });
});
