import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkText,
  maxTextLength,
  noteCatalog,
  parseNote,
  readNoteFiles,
  readReleaseNotes,
  releaseNotesDirectory,
} from "./release-notes.js";

const note = (surfaces: string, text: string) => `${surfaces}\n\n${text}\n`;

function directoryWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "release-notes-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("release notes of the package", () => {
  // Линтер формы (ADR-069, п. 1): каждая запись каталога проходит тот же
  // разбор, что старт процесса.
  it("all pass the form check", () => {
    const loaded = readNoteFiles(releaseNotesDirectory());
    expect(loaded.ok ? [] : loaded.error).toEqual([]);
  });

  it("are found from the source tree at the package root", () => {
    expect(releaseNotesDirectory()).toBe(
      path.resolve(import.meta.dirname, "../../release-notes"),
    );
  });
});

describe("checkText", () => {
  it.each([
    // Образец дизайн-кода и раскадровки.
    "Под сводкой аукциона теперь кнопка на каждый лот.",
    "Закрытый лот больше нельзя добавить в избранное: следить уже не за чем.",
    "Ведущий объявляет состав финала прямо из перерыва.",
    "В «Правила и FAQ» появился раздел о розыгрыше.",
    "Оригинал в Telegram останется на месте.",
    "Меню теперь открывает /menu.",
    "Одна строка.\nВторая строка.\nТретья строка.",
    "Сводка длиннее десяти записей идёт постами (1/2) и (2/2).",
    "Бот отвечает 24/7.",
    "я".repeat(maxTextLength),
  ])("accepts %j", (text) => {
    expect(checkText(text)).toEqual([]);
  });

  it.each([
    ["longer than the limit", "я".repeat(maxTextLength + 1), "characters"],
    ["empty", "", "empty"],
    ["four lines", "а\nб\nв\nг", "lines"],
    ["a task code", "Починили сводку (PER-627).", "task code"],
    ["a path", "Поправили apps/hub-bot/src.", "path"],
    ["a Windows path", "Поправили src\\core.", "path"],
    ["snake_case", "Добавили BOT_SURFACE.", "Latin identifier"],
    ["camelCase", "Работает noteCatalog.", "Latin identifier"],
    ["a dotted name", "Обновили release-notes.ts целиком.", "Latin identifier"],
    ["a code span", "Кнопка `Меню` на месте.", "code span"],
    ["an empty line inside", "Первая.\n\nВторая.", "empty line"],
  ])("refuses text with %s", (_, text, rule) => {
    expect(checkText(text).join("; ")).toContain(rule);
  });

  it("counts characters in code points", () => {
    expect(checkText("💰".repeat(maxTextLength))).toEqual([]);
  });
});

describe("parseNote", () => {
  it("reads surfaces and text", () => {
    expect(parseNote("lot-buttons", note("hub auction", "Текст."))).toEqual({
      ok: true,
      config: {
        id: "lot-buttons",
        surfaces: ["hub", "auction"],
        text: "Текст.",
      },
    });
  });

  it("reads a file checked out with CRLF", () => {
    const parsed = parseNote("crlf", "hub\r\n\r\nПервая.\r\nВторая.\r\n");
    expect(parsed.ok && parsed.config.text).toBe("Первая.\nВторая.");
  });

  it.each([
    ["an upper-case name", "Lot-Buttons", note("hub", "Текст."), "name must"],
    ["an underscore name", "lot_buttons", note("hub", "Текст."), "name must"],
    ["a hidden name", ".lot", note("hub", "Текст."), "name must"],
    ["a name over 64", "a".repeat(65), note("hub", "Текст."), "name must"],
    ["the support surface", "lot", note("support", "Т."), "hub, auction"],
    ["a repeated surface", "lot", note("hub hub", "Т."), "hub, auction"],
    ["no gap after surfaces", "lot", "hub\nТекст.\n", "empty line"],
    ["a task code", "lot", note("hub", "Задача PER-1."), "task code"],
  ])("refuses %s", (_, id, content, error) => {
    const parsed = parseNote(id, content);
    expect(parsed.ok ? "" : parsed.error).toContain(error);
  });
});

describe("readReleaseNotes", () => {
  it("gives each surface its own notes", () => {
    const loaded = readReleaseNotes(
      directoryWith({
        "both.txt": note("hub auction", "Обоим."),
        "hub-only.txt": note("hub", "Хабу."),
        "auction-only.txt": note("auction", "Аукциону."),
        ".gitkeep": "",
      }),
    );
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.config.idsFor("hub")).toEqual(["both", "hub-only"]);
    expect(loaded.config.idsFor("auction")).toEqual(["auction-only", "both"]);
    expect(loaded.config.idsFor("support")).toEqual([]);
    expect(loaded.config.textOf("hub", "both")).toBe("Обоим.");
    expect(loaded.config.textOf("hub", "auction-only")).toBeUndefined();
  });

  it("gives an empty set for an empty directory", () => {
    const loaded = readReleaseNotes(directoryWith({}));
    expect(loaded.ok && loaded.config.idsFor("hub")).toEqual([]);
  });

  it("refuses a missing directory", () => {
    const loaded = readReleaseNotes(path.join(tmpdir(), "no-release-notes"));
    expect(loaded.ok ? "" : loaded.error).toContain("unreadable");
  });

  it("refuses a hidden note instead of skipping it", () => {
    const loaded = readReleaseNotes(
      directoryWith({ ".draft.txt": note("hub", "Черновик.") }),
    );
    expect(loaded.ok ? "" : loaded.error).toContain("release note .draft");
  });

  it("refuses an unreadable note by its name", () => {
    const dir = directoryWith({});
    mkdirSync(path.join(dir, "folder.txt"));
    const loaded = readReleaseNotes(dir);
    expect(loaded.ok ? "" : loaded.error).toBe(
      "release note folder.txt: is unreadable",
    );
  });

  it("refuses a file that is not a note", () => {
    const loaded = readReleaseNotes(directoryWith({ "README.md": "# Записи" }));
    expect(loaded.ok ? "" : loaded.error).toContain(".txt");
  });

  it("refuses the whole set on one broken note", () => {
    const loaded = readReleaseNotes(
      directoryWith({
        "good.txt": note("hub", "Годится."),
        "bad.txt": note("hub", "Поправили apps/hub-bot."),
      }),
    );
    expect(loaded.ok ? "" : loaded.error).toContain("release note bad");
  });
});

describe("releaseNotesDirectory", () => {
  // Сборка и образ кладут модуль глубже, чем исходник: каталог ищется у
  // ближайшего package.json, а не числом «..».
  it("finds the directory next to the nearest package.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "package-"));
    writeFileSync(path.join(root, "package.json"), "{}");
    const module = path.join(root, "dist", "src", "core");
    mkdirSync(module, { recursive: true });
    expect(releaseNotesDirectory(module)).toBe(
      path.join(root, "release-notes"),
    );
  });
});

describe("noteCatalog", () => {
  it("keeps the order it was given", () => {
    const notes = noteCatalog([
      { id: "b", surfaces: ["hub"], text: "Б." },
      { id: "a", surfaces: ["hub"], text: "А." },
    ]);
    expect(notes.idsFor("hub")).toEqual(["b", "a"]);
  });
});
