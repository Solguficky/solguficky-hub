import { describe, expect, expectTypeOf, it } from "vitest";
import type { Catalog, UnknownEntryKeys } from "./catalog.js";
import { inspectCall, type LintConfig } from "./inspect.js";

// L0 настройки линтера: то, что бот задаёт своими данными, — группы родителей,
// именованные пары и исключения. Сами правила дизайн-кода гоняет набор бота
// хаба (apps/hub-bot/testkit/screen-lint.test.ts) на его настройке.

const tag = Symbol("screen");

const catalog = {
  menu: { class: "screen", nav: "root", title: "Меню", backName: "Меню" },
  upcoming: {
    class: "screen",
    nav: "tree",
    title: "Ближайшие",
    parent: "menu",
    backName: "Ближайшие",
  },
  archive: {
    class: "screen",
    nav: "tree",
    title: "Архив",
    parent: "menu",
    backName: "Архив",
  },
  card: { class: "screen", nav: "tree", parent: "list" },
  edit: { class: "screen", nav: "tree", title: "Изменить", parent: "menu" },
  plain: {
    class: "screen",
    nav: "tree",
    parent: "menu",
    waive: { title: "PER-1: заголовка нет до перевёрстки" },
  },
  painted: {
    class: "screen",
    nav: "tree",
    title: "Крашеный",
    parent: "menu",
    waive: { nav: "PER-2: возврат подписан по-старому" },
  },
} as const satisfies Catalog;

const config: LintConfig = {
  tag,
  catalog,
  parentGroups: { list: ["upcoming", "archive"] },
  namedPairs: new Set(["Изменить|Статус"]),
};

type Key = { text: string; callback_data?: string; style?: string };

const key = (text: string, extra: Partial<Key> = {}): Key => ({
  text,
  callback_data: "v1:x",
  ...extra,
});

function call(id: string, text: string, rows: Key[][]) {
  return {
    chat_id: 42,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
    [tag]: id,
  };
}

const rulesOf = (method: string, payload: unknown) =>
  inspectCall(config, method, payload).map(({ rule }) => rule);

describe("inspectCall configuration", () => {
  it("reads the mark under the symbol the bot passes", () => {
    const foreign = Symbol("screen");
    expect(
      rulesOf("sendMessage", {
        text: "<b>Меню</b>",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[key("Ближайшие")]] },
        [foreign]: "menu",
      }),
    ).toEqual(["untagged"]);
  });

  it("accepts a return to any screen of a parent group", () => {
    for (const back of ["‹ Ближайшие", "‹ Архив"]) {
      expect(
        rulesOf(
          "editMessageText",
          call("card", "<b>Сходка</b>", [[key(back), key("Меню")]]),
        ),
      ).toEqual([]);
    }
    expect(
      rulesOf(
        "editMessageText",
        call("card", "<b>Сходка</b>", [[key("‹ Меню"), key("Меню")]]),
      ),
    ).toEqual(["nav"]);
  });

  it("allows a pair only when the bot names it", () => {
    const rows = (pair: Key[]) => [pair, [key("‹ Меню")]];
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>", rows([key("Изменить"), key("Статус")])),
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        "editMessageText",
        call(
          "edit",
          "<b>Изменить</b>",
          rows([key("Изменить"), key("Удалить сходку")]),
        ),
      ),
    ).toEqual(["rows"]);
  });

  it("drops only the waived rule of an entry", () => {
    expect(
      rulesOf("editMessageText", {
        ...call("plain", "Без заголовка", [[key("‹ Меню")]]),
        parse_mode: undefined,
      }),
    ).toEqual([]);
    // Исключение снимает своё правило, а не все: цвет и предел данных
    // проверяются и под ним.
    expect(
      rulesOf(
        "editMessageText",
        call("painted", "<b>Крашеный</b>", [
          [key("Купить", { style: "danger" })],
          [key("К меню", { callback_data: "x".repeat(65) })],
        ]),
      ),
    ).toEqual(["style", "callback-data"]);
  });

  it("finds the caption of an edited photo inside its media", () => {
    expect(
      rulesOf("editMessageMedia", {
        media: {
          type: "photo",
          media: "file",
          caption: "Лот",
          parse_mode: "HTML",
        },
        reply_markup: { inline_keyboard: [[key("‹ Меню")]] },
        [tag]: "edit",
      }),
    ).toEqual(["title"]);
    expect(
      rulesOf("editMessageMedia", {
        media: {
          type: "photo",
          media: "file",
          caption: "<b>Изменить</b>",
          parse_mode: "HTML",
        },
        reply_markup: { inline_keyboard: [[key("‹ Меню")]] },
        [tag]: "edit",
      }),
    ).toEqual([]);
  });

  it("names unknown entry keys of a catalog by type", () => {
    const typo = {
      menu: { class: "screen", nav: "root", refesh: true },
    } as const;
    expectTypeOf<UnknownEntryKeys<typeof typo>>().toEqualTypeOf<"refesh">();
    expectTypeOf<UnknownEntryKeys<typeof catalog>>().toBeNever();
  });
});
