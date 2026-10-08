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
  bid: { class: "screen", nav: "confirm", title: "Ставка", money: true },
  open: { class: "screen", nav: "confirm", title: "Неделя" },
  decline: {
    class: "screen",
    nav: "confirm",
    title: "Отказать?",
    decision: true,
  },
} as const satisfies Catalog;

const config: LintConfig = {
  tag,
  catalog,
  parentGroups: { list: ["upcoming", "archive"] },
  namedPairs: new Set(["Изменить|Статус", "Материалы (#)|Лоты"]),
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

  it("reads # in a named pair as any number in the label", () => {
    const rows = (pair: Key[]) => [pair, [key("‹ Меню")]];
    for (const count of ["0", "7", "12"]) {
      expect(
        rulesOf(
          "editMessageText",
          call(
            "edit",
            "<b>Изменить</b>",
            rows([key(`Материалы (${count})`), key("Лоты")]),
          ),
        ),
      ).toEqual([]);
    }
    expect(
      rulesOf(
        "editMessageText",
        call(
          "edit",
          "<b>Изменить</b>",
          rows([key("Материалы (два)"), key("Лоты")]),
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

  // PER-473: цвет читается из каталога, а не из подписи.
  it("paints only the money confirmation, and paints it always", () => {
    const confirm = (id: string, title: string, yes: Key) =>
      rulesOf(
        "sendMessage",
        call(id, `<b>${title}</b>`, [[yes], [key("Нет")]]),
      );
    expect(
      confirm(
        "bid",
        "Ставка",
        key("Да, поставить 1 300 ₽", { style: "danger" }),
      ),
    ).toEqual([]);
    expect(confirm("bid", "Ставка", key("Да, поставить 1 300 ₽"))).toEqual([
      "style",
    ]);
    expect(
      confirm("open", "Неделя", key("Да, открыть неделю", { style: "danger" })),
    ).toEqual(["style"]);
    expect(confirm("open", "Неделя", key("Да, открыть неделю"))).toEqual([]);
  });

  // PER-534: экран решения по заявке красит отказ красным, допуск зелёным, и
  // только он.
  it("paints the application decision, and paints it always", () => {
    const decline = (id: string, title: string, yes: Key) =>
      rulesOf(
        "sendMessage",
        call(id, `<b>${title}</b>`, [[yes], [key("Нет")]]),
      );
    expect(
      decline("decline", "Отказать?", key("Да, отказать", { style: "danger" })),
    ).toEqual([]);
    expect(decline("decline", "Отказать?", key("Да, отказать"))).toEqual([
      "style",
    ]);
    expect(
      decline(
        "decline",
        "Отказать?",
        key("Да, отказать", { style: "success" }),
      ),
    ).toEqual(["style", "style"]);
    expect(
      decline("open", "Неделя", key("Да, отказать", { style: "danger" })),
    ).toEqual(["style"]);
  });

  // PER-472: тело экрана — пустая строка после заголовка, а над ним ничего:
  // исход действия — свой экран, а не заметка над карточкой.
  it("requires a blank line after the title and nothing above it", () => {
    const titled = (text: string) =>
      rulesOf("sendMessage", call("edit", text, [[key("‹ Меню")]]));
    expect(titled("<b>Изменить</b>")).toEqual([]);
    expect(titled("<b>Изменить</b>\n\nНазвание: Сходка")).toEqual([]);
    expect(titled("Сохранено.\n\n<b>Изменить</b>\n\nНазвание: Сходка")).toEqual(
      ["body"],
    );
    expect(titled("<b>Изменить</b>\nНазвание: Сходка")).toEqual(["body"]);
    expect(titled("Сохранено.\n<b>Изменить</b>")).toEqual(["body"]);
    expect(titled("Сохранено.\n\nЕщё раз.\n\n<b>Изменить</b>")).toEqual([
      "body",
    ]);
    // Кадр отказа держит жирное предложение и остальное в одной строке;
    // заголовок без знака конца предложения текста рядом не терпит.
    expect(titled("<b>Изменить нельзя.</b> Сходка отменена.")).toEqual([]);
    expect(titled("<b>Изменить</b>Название: Сходка")).toEqual(["body"]);
    expect(titled("<b>Изменить</b> Название: Сходка")).toEqual(["body"]);
  });

  it("lets nothing stand before the rich title", () => {
    const rich = (html: string) =>
      rulesOf("sendRichMessage", {
        chat_id: 42,
        rich_message: { html },
        reply_markup: { inline_keyboard: [[key("‹ Меню")]] },
        [tag]: "edit",
      });
    expect(rich("<h1>Изменить</h1><p>Тело</p>")).toEqual([]);
    expect(rich("<p>Сохранено.</p><h1>Изменить</h1><p>Тело</p>")).toEqual([
      "body",
    ]);
    expect(rich("<p>Раз.</p><p>Два.</p><h1>Изменить</h1>")).toEqual(["body"]);
    expect(rich("Сохранено.<h1>Изменить</h1>")).toEqual(["body"]);
    expect(rich("<h1>Изменить</h1>Название: Сходка")).toEqual(["body"]);
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
