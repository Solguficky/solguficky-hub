import { describe, expect, expectTypeOf, it } from "vitest";
import type { Catalog, UnknownEntryKeys } from "./catalog.js";
import { inspectCall, type LintConfig } from "./inspect.js";

// L0 настройки линтера: то, что бот задаёт своими данными, — группы родителей,
// именованные пары и исключения. Сами правила дизайн-кода гоняет набор бота
// хаба (apps/hub-bot/testkit/screen-lint.test.ts) на его настройке.

const tag = Symbol("screen");

const catalog = {
  meetups: {
    class: "screen",
    nav: "root",
    title: "Сходки",
    backName: "Сходки",
  },
  hidden: {
    class: "screen",
    nav: "tree",
    title: "Скрытые",
    parent: "meetups",
    backName: "Скрытые",
  },
  archive: {
    class: "screen",
    nav: "tree",
    title: "Архив",
    parent: "meetups",
    backName: "Архив",
  },
  card: { class: "screen", nav: "tree", parent: "list" },
  edit: { class: "screen", nav: "tree", title: "Изменить", parent: "meetups" },
  status: {
    class: "screen",
    nav: "tree",
    title: "Статус",
    subject: true,
    parent: "meetups",
  },
  plain: {
    class: "screen",
    nav: "tree",
    parent: "meetups",
    waive: { title: "PER-1: заголовка нет до перевёрстки" },
  },
  painted: {
    class: "screen",
    nav: "tree",
    title: "Крашеный",
    parent: "meetups",
    waive: { nav: "PER-2: возврат подписан по-старому" },
  },
  bid: { class: "screen", nav: "confirm", title: "Ставка", irreversible: true },
  hide: { class: "screen", nav: "confirm", title: "Скрыть" },
} as const satisfies Catalog;

const config: LintConfig = {
  tag,
  catalog,
  parentGroups: { list: ["hidden", "archive"] },
  namedPairs: new Set(["Правка|Итог", "Файлы (#)|Ставки"]),
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
        text: "<b>Сходки</b>",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[key("🗂 Архив")]] },
        [foreign]: "meetups",
      }),
    ).toEqual(["untagged"]);
  });

  it("accepts a return to any screen of a parent group", () => {
    for (const back of ["‹ Скрытые", "‹ Архив"]) {
      expect(
        rulesOf(
          "editMessageText",
          call("card", "<b>Сходка</b>", [[key(back)]]),
        ),
      ).toEqual([]);
    }
    expect(
      rulesOf(
        "editMessageText",
        call("card", "<b>Сходка</b>", [[key("‹ Сходки")]]),
      ),
    ).toEqual(["nav"]);
  });

  // Решение владельца 10 октября 2026 года: ряд навигации — одна кнопка
  // возврата, кнопки «Меню» нет нигде.
  it("keeps the navigation row to the return alone", () => {
    expect(
      rulesOf(
        "editMessageText",
        call("card", "<b>Сходка</b>", [[key("‹ Архив"), key("Меню")]]),
      ),
    ).toEqual(["nav", "vocabulary"]);
    expect(
      rulesOf(
        "editMessageText",
        call("meetups", "<b>Сходки</b>", [[key("🗂 Архив")], [key("‹ Сходки")]]),
      ),
    ).toEqual(["nav"]);
    expect(
      rulesOf(
        "editMessageText",
        call("meetups", "<b>Сходки</b>", [[key("🗂 Архив")]]),
      ),
    ).toEqual([]);
  });

  // Один знак на раздел во всех ботах, тот же, что в тексте (PER-644): вход
  // в раздел без знака — нарушение, возврат и заголовок знака не несут.
  it("requires the section sign on a section entry and its text line", () => {
    const back = [key("‹ Сходки")];
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>", [[key("Материалы (3)")], back]),
      ),
    ).toEqual(["emoji"]);
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>", [[key("📎 Материалы (3)")], back]),
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>\n\nАукцион: идут торги", [back]),
      ),
    ).toEqual(["emoji"]);
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>\n\n🔨 Аукцион: идут торги", [back]),
      ),
    ).toEqual([]);
    // Поле записи с отступом называет бота, а не раздел.
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>\n\n• Канал\n  Аукцион: ссылка", [back]),
      ),
    ).toEqual([]);
  });

  // Подменю сходки (PER-644): заголовок — имя подменю, под ним курсивом
  // название сходки, затем пустая строка.
  it("reads the meetup title under the submenu name", () => {
    const back = [[key("‹ Сходки")]];
    expect(
      rulesOf(
        "editMessageText",
        call("status", "<b>Статус</b>\n<i>Настолки</i>\n\nТекст", back),
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        "editMessageText",
        call("status", "<b>Статус</b>\n\nТекст", back),
      ),
    ).toEqual(["title"]);
    expect(
      rulesOf(
        "editMessageText",
        call("status", "<b>Статус</b>\n<i>Настолки</i>\nТекст", back),
      ),
    ).toEqual(["body"]);
  });

  it("allows a pair only when the bot names it", () => {
    const rows = (pair: Key[]) => [pair, [key("‹ Сходки")]];
    expect(
      rulesOf(
        "editMessageText",
        call("edit", "<b>Изменить</b>", rows([key("Правка"), key("Итог")])),
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        "editMessageText",
        call(
          "edit",
          "<b>Изменить</b>",
          rows([key("Правка"), key("Удалить сходку")]),
        ),
      ),
    ).toEqual(["rows"]);
  });

  it("reads # in a named pair as any number in the label", () => {
    const rows = (pair: Key[]) => [pair, [key("‹ Сходки")]];
    for (const count of ["0", "7", "12"]) {
      expect(
        rulesOf(
          "editMessageText",
          call(
            "edit",
            "<b>Изменить</b>",
            rows([key(`Файлы (${count})`), key("Ставки")]),
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
          rows([key("Файлы (два)"), key("Ставки")]),
        ),
      ),
    ).toEqual(["rows"]);
  });

  it("drops only the waived rule of an entry", () => {
    expect(
      rulesOf("editMessageText", {
        ...call("plain", "Без заголовка", [[key("‹ Сходки")]]),
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

  // Решение владельца 10 октября 2026 года: цвет читается из каталога, а не
  // из подписи; красное — только «Да» необратимого подтверждения.
  it("paints only the irreversible confirmation, and paints it always", () => {
    const confirm = (id: string, title: string, yes: Key) =>
      rulesOf(
        "sendMessage",
        call(id, `<b>${title}</b>`, [[yes, key("✖️ Нет")]]),
      );
    expect(
      confirm(
        "bid",
        "Ставка",
        key("✔️ Да, поставить 1 300 ₽", { style: "danger" }),
      ),
    ).toEqual([]);
    expect(confirm("bid", "Ставка", key("✔️ Да, поставить 1 300 ₽"))).toEqual([
      "style",
    ]);
    expect(
      confirm("bid", "Ставка", key("✔️ Да, поставить", { style: "success" })),
    ).toEqual(["style", "style"]);
    expect(
      confirm("hide", "Скрыть", key("✔️ Да, скрыть", { style: "danger" })),
    ).toEqual(["style"]);
    expect(confirm("hide", "Скрыть", key("✔️ Да, скрыть"))).toEqual([]);
  });

  it("keeps the confirmation answers in one row", () => {
    const rows = (keyboard: Key[][]) =>
      rulesOf("sendMessage", call("hide", "<b>Скрыть</b>", keyboard));
    expect(rows([[key("✔️ Да, скрыть"), key("✖️ Нет")]])).toEqual([]);
    expect(rows([[key("✔️ Да, скрыть")], [key("✖️ Нет")]])).toEqual(["nav"]);
    expect(rows([[key("Да, скрыть"), key("Нет")]])).toEqual(["nav"]);
  });

  it("keeps the admit choice in one row with its pair", () => {
    const rows = (keyboard: Key[][]) =>
      rulesOf("sendMessage", call("edit", "<b>Изменить</b>", keyboard));
    expect(
      rows([[key("✔️ Допустить")], [key("✖️ Отказать")], [key("‹ Сходки")]]),
    ).toEqual(["rows"]);
  });

  it("lets only dictionary emoji before their words", () => {
    const shown = (text: string, label: string) =>
      rulesOf(
        "sendMessage",
        call("edit", text, [[key(label)], [key("‹ Сходки")]]),
      );
    expect(
      shown(
        "<b>Изменить</b>\n\n📅 Когда: 12 июня\n📍 Где: бар",
        "🔔 Вкл · Новые",
      ),
    ).toEqual([]);
    expect(shown("<b>Изменить</b>\n\n🎉 Готово", "Раз")).toEqual(["emoji"]);
    expect(shown("<b>Изменить</b>", "🗑 Изменить")).toEqual(["emoji"]);
    // Текст организатора без пробела за знаком не проверяется: так эмодзи
    // бот не ставит.
    expect(shown("<b>Изменить</b>\n\n🦉🦉🦉", "🎲🎲🎲")).toEqual([]);
  });

  // PER-472: тело экрана — пустая строка после заголовка, а над ним ничего:
  // исход действия — свой экран, а не заметка над карточкой.
  it("requires a blank line after the title and nothing above it", () => {
    const titled = (text: string) =>
      rulesOf("sendMessage", call("edit", text, [[key("‹ Сходки")]]));
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
        reply_markup: { inline_keyboard: [[key("‹ Сходки")]] },
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

  // Решение владельца 10 октября 2026 года: фото карточки стоит над
  // заголовком — одно фото или карусель, и больше ничего.
  it("lets only the card photo stand before the rich title", () => {
    const rich = (html: string) =>
      rulesOf("sendRichMessage", {
        chat_id: 42,
        rich_message: { html },
        reply_markup: { inline_keyboard: [[key("‹ Сходки")]] },
        [tag]: "edit",
      });
    const photo = '<img src="tg://photo?id=p1"/>';
    expect(rich(`${photo}<h1>Изменить</h1><p>Тело</p>`)).toEqual([]);
    expect(
      rich(
        `<tg-slideshow>${photo}<img src="tg://photo?id=p2"/></tg-slideshow><h1>Изменить</h1>`,
      ),
    ).toEqual([]);
    expect(rich(`${photo}<p>Сохранено.</p><h1>Изменить</h1>`)).toEqual([
      "body",
    ]);
    expect(rich(`<p>Сохранено.</p>${photo}<h1>Изменить</h1>`)).toEqual([
      "body",
    ]);
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
        reply_markup: { inline_keyboard: [[key("‹ Сходки")]] },
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
        reply_markup: { inline_keyboard: [[key("‹ Сходки")]] },
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
