import { describe, expect, it } from "vitest";
import {
  addVersion,
  ConflictError,
  createDocument,
  emptyState,
  MAX_VERSIONS,
  type NotesState,
  parseDocument,
  parseState,
  restoreVersion,
  ValidationError,
  writeState,
} from "./document.js";

const at = (minute: number): string =>
  `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const state = (answer: string): NotesState => ({
  slots: { "feature-x": { importance: "Высокая" } },
  answers: { "note-1": answer },
  priorities: ["Первый пункт"],
});

const document = () => createDocument("doc-1", state("черновик"), at(0));

describe("состояние", () => {
  it("отбрасывает неизвестные поля, а не падает на них", () => {
    const parsed = parseState({ answers: { a: "текст" }, somethingNew: 42 });
    expect(parsed).toEqual({
      slots: {},
      answers: { a: "текст" },
      priorities: [],
    });
  });

  it("отвергает состояние неподходящей формы", () => {
    expect(() => parseState({ priorities: "не массив" })).toThrow(
      ValidationError,
    );
    expect(() => parseState({ answers: { a: 5 } })).toThrow(ValidationError);
    expect(() => parseState("строка")).toThrow(ValidationError);
  });

  it("отвергает ответ длиннее предела", () => {
    expect(() => parseState({ answers: { a: "я".repeat(4001) } })).toThrow(
      ValidationError,
    );
  });
});

describe("запись состояния", () => {
  it("поднимает ревизию и не трогает историю", () => {
    const written = writeState(document(), state("правка"), 1, at(1));
    expect(written.revision).toBe(2);
    expect(written.state.answers["note-1"]).toBe("правка");
    expect(written.versions).toHaveLength(1);
  });

  it("отказывает записи поверх чужой и отдаёт актуальный документ", () => {
    const ahead = writeState(document(), state("чужая правка"), 1, at(1));
    try {
      writeState(ahead, state("моя правка"), 1, at(2));
      expect.unreachable("запись должна была упереться в конфликт");
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).current.state.answers["note-1"]).toBe(
        "чужая правка",
      );
    }
  });
});

describe("версии", () => {
  it("фиксирует состояние сервера, а не присланное клиентом", () => {
    const written = writeState(document(), state("правка"), 1, at(1));
    const versioned = addVersion(written, "Перед обсуждением", 2, at(2));
    const last = versioned.versions.at(-1);
    expect(last?.label).toBe("Перед обсуждением");
    expect(last?.state.answers["note-1"]).toBe("правка");
  });

  it("вытесняет старые версии, сохраняя предел", () => {
    let current = document();
    for (let index = 0; index < MAX_VERSIONS + 5; index += 1) {
      current = addVersion(
        current,
        `Версия ${index}`,
        current.revision,
        at(index + 1),
      );
    }
    expect(current.versions).toHaveLength(MAX_VERSIONS);
    expect(current.versions.at(-1)?.number).toBe(MAX_VERSIONS + 6);
    expect(current.versions[0]?.number).toBe(7);
  });
});

describe("откат", () => {
  it("возвращает содержимое версии новой версией, ничего не удаляя", () => {
    const written = writeState(document(), state("ошибочная правка"), 1, at(1));
    const restored = restoreVersion(written, 1, 2, at(2));
    expect(restored.state.answers["note-1"]).toBe("черновик");
    expect(restored.versions).toHaveLength(2);
    expect(restored.versions.at(-1)).toMatchObject({
      number: 2,
      restoredFrom: 1,
      label: "Откат к версии 1",
    });
  });

  it("позволяет откатить сам откат", () => {
    const written = writeState(document(), state("нужная правка"), 1, at(1));
    const versioned = addVersion(written, "Нужное", 2, at(2));
    const rolledBack = restoreVersion(versioned, 1, 3, at(3));
    const undone = restoreVersion(rolledBack, 2, 4, at(4));
    expect(undone.state.answers["note-1"]).toBe("нужная правка");
  });

  it("отвергает номер несуществующей версии", () => {
    expect(() => restoreVersion(document(), 99, 1, at(1))).toThrow(
      ValidationError,
    );
  });
});

describe("разбор документа из хранилища", () => {
  it("переживает документ без истории", () => {
    const parsed = parseDocument({
      docId: "doc-1",
      revision: 3,
      state: emptyState(),
    });
    expect(parsed.versions).toEqual([]);
    expect(parsed.revision).toBe(3);
  });

  it("отвергает блоб не той формы", () => {
    expect(() => parseDocument("мусор")).toThrow(ValidationError);
    expect(() => parseDocument({ state: { answers: [] } })).toThrow(
      ValidationError,
    );
  });
});
