import { InlineKeyboard } from "grammy";
import { describe, expect, it } from "vitest";
import type { IdentityResolver } from "../src/surfaces/hub/identity/port.js";
import {
  screenMark,
  screenTag,
} from "../src/surfaces/hub/presentation/screens/show.js";
import { createHarness } from "./harness.js";
import {
  inspectCall,
  type ScreenEntry,
  takeViolations,
} from "./screen-lint.js";

// L0: правила дизайн-кода на записи одного вызова Bot API. Каталог здесь свой,
// маленький: правило проверяется само по себе, а не состоянием перевёрстки.

const catalog: Record<string, ScreenEntry> = {
  menu: { class: "screen", nav: "root", title: "Меню", backName: "Меню" },
  upcoming: {
    class: "screen",
    nav: "tree",
    title: "Ближайшие сходки",
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
  hidden: {
    class: "screen",
    nav: "tree",
    title: "Скрытые сходки",
    parent: "menu",
    backName: "Скрытые",
  },
  card: {
    class: "screen",
    nav: "tree",
    parent: "meetup-list",
    backName: "Сходка",
    maxRows: 5,
  },
  status: { class: "screen", nav: "tree", title: "Статус", parent: "card" },
  community: {
    class: "screen",
    nav: "tree",
    title: "Состав сообщества",
    parent: "menu",
    refresh: true,
  },
  confirm: { class: "screen", nav: "confirm" },
  bid: { class: "screen", nav: "confirm", title: "Ставка", money: true },
  question: { class: "question", nav: "question" },
  "date-presets": { class: "screen", nav: "choice" },
  refusal: { class: "screen", nav: "exit" },
  "no-access": { class: "screen", nav: "none" },
  "no-access-link": { class: "screen", nav: "links" },
  notification: { class: "trace", nav: "free" },
  old: {
    class: "screen",
    nav: "tree",
    title: "Архив",
    parent: "menu",
    legacy: true,
  },
};

type Key = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: string;
};

function screen(
  id: string,
  text: string,
  rows: Key[][],
  extra: Record<string, unknown> = {},
) {
  return {
    chat_id: 42,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
    [screenTag]: id,
    ...extra,
  };
}

const key = (text: string, style?: string): Key => ({
  text,
  callback_data: `v1:${text.length}`,
  ...(style === undefined ? {} : { style }),
});

function rulesOf(method: string, payload: unknown): string[] {
  return inspectCall("hub", method, payload, catalog).map(({ rule }) => rule);
}

describe("inspectCall", () => {
  it("flags a keyboard sent without a screen mark", () => {
    const found = inspectCall(
      "hub",
      "sendMessage",
      {
        chat_id: 42,
        text: "Привет",
        reply_markup: { inline_keyboard: [[key("Меню")]] },
      },
      catalog,
    );

    expect(found).toMatchObject([{ screen: "—", rule: "untagged" }]);
  });

  it("flags an unmarked question", () => {
    expect(
      rulesOf("sendMessage", {
        chat_id: 42,
        text: "Где встречаемся?",
        reply_markup: { force_reply: true },
      }),
    ).toEqual(["untagged"]);
  });

  it("ignores a message without a keyboard and a method that carries none", () => {
    expect(
      rulesOf("sendMessage", { chat_id: 42, text: "Изменение сохранено." }),
    ).toEqual([]);
    expect(rulesOf("answerCallbackQuery", { callback_query_id: "1" })).toEqual(
      [],
    );
    expect(
      rulesOf("editMessageReplyMarkup", {
        chat_id: 42,
        message_id: 9,
        reply_markup: { inline_keyboard: [] },
      }),
    ).toEqual([]);
  });

  it("flags a mark the catalog does not know", () => {
    expect(
      rulesOf("sendMessage", screen("nowhere", "<b>Экран</b>", [])),
    ).toEqual(["unknown-screen"]);
  });

  it("accepts a first-level screen that returns to the menu", () => {
    expect(
      rulesOf(
        "editMessageText",
        screen("upcoming", "<b>Ближайшие сходки</b>\n\nПока пусто.", [
          [key("12 июня · Настолки")],
          [key("‹ Меню")],
        ]),
      ),
    ).toEqual([]);
  });

  it("requires the parent's name and the menu button on a deeper screen", () => {
    const nav = (row: Key[]) =>
      rulesOf("editMessageText", screen("status", "<b>Статус</b>", [row]));

    expect(nav([key("‹ Сходка"), key("Меню")])).toEqual([]);
    expect(nav([key("‹ Сходка")])).toEqual(["nav"]);
    expect(nav([key("‹ Архив"), key("Меню")])).toEqual(["nav"]);
    expect(nav([key("Назад")])).toEqual(["nav", "vocabulary"]);
  });

  it("lets a meetup card return to any list a meetup can stand in", () => {
    const card = (back: string) =>
      rulesOf("editMessageText", {
        chat_id: 42,
        message_id: 9,
        rich_message: { html: "<h1>Настолки</h1><p>Когда: завтра</p>" },
        reply_markup: { inline_keyboard: [[key(back), key("Меню")]] },
        [screenTag]: "card",
      });

    expect(card("‹ Ближайшие")).toEqual([]);
    expect(card("‹ Архив")).toEqual([]);
    expect(card("‹ Скрытые")).toEqual([]);
    expect(card("‹ Меню")).toEqual(["nav"]);
  });

  // Над заголовком ничего: исход действия — свой экран (PER-472).
  it("requires a bold title first, with nothing above it", () => {
    const titled = (text: string, extra?: Record<string, unknown>) =>
      rulesOf(
        "sendMessage",
        screen("upcoming", text, [[key("‹ Меню")]], extra),
      );

    expect(titled("Изменение сохранено.\n\n<b>Ближайшие сходки</b>")).toEqual([
      "body",
    ]);
    expect(titled("Ближайшие сходки")).toEqual(["title"]);
    expect(titled("<b>Архив</b>")).toEqual(["title"]);
    expect(
      titled("<b>Ближайшие сходки</b>", { parse_mode: undefined }),
    ).toEqual(["title"]);
  });

  it("holds a confirmation to a verb answer and a plain no", () => {
    const confirm = (rows: Key[][]) =>
      rulesOf(
        "editMessageText",
        screen("confirm", "<b>Отменить сходку?</b>", rows),
      );

    expect(confirm([[key("Да, отменить сходку")], [key("Нет")]])).toEqual([]);
    expect(
      confirm([
        [{ text: "Открыть источник ↗", url: "https://t.me/c/1/2" }],
        [key("Да, прикрепить")],
        [key("Нет")],
      ]),
    ).toEqual([]);
    expect(confirm([[key("Да, продолжить")], [key("Нет")]])).toEqual([
      "vocabulary",
    ]);
    expect(confirm([[key("Отправить"), key("Не отправлять")]])).toEqual([
      "nav",
    ]);
  });

  // PER-473: красное — только «Да» подтверждения траты денег, и там оно
  // обязательно; необратимость остальных называет текст.
  it("colours only the money confirmation, and only its answer as danger", () => {
    const styled = (rows: Key[][]) =>
      rulesOf(
        "editMessageText",
        screen("confirm", "<b>Отменить сходку?</b>", rows),
      );
    const paid = (rows: Key[][]) =>
      rulesOf("editMessageText", screen("bid", "<b>Ставка</b>", rows));

    expect(
      styled([[key("Да, отменить сходку", "danger")], [key("Нет")]]),
    ).toEqual(["style"]);
    expect(
      styled([[key("Да, отменить сходку", "primary")], [key("Нет")]]),
    ).toEqual(["style"]);
    expect(
      paid([[key("Да, поставить 1 300 ₽", "danger")], [key("Нет")]]),
    ).toEqual([]);
    expect(paid([[key("Да, поставить 1 300 ₽")], [key("Нет")]])).toEqual([
      "style",
    ]);
    expect(
      paid([[key("Да, поставить 1 300 ₽", "danger")], [key("Нет", "danger")]]),
    ).toEqual(["style"]);
  });

  it("allows two buttons in a row only for the pairs the design code names", () => {
    const tree = (rows: unknown[][]) =>
      rulesOf("sendMessage", {
        text: "<b>Архив</b>",
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [...rows, [key("‹ Меню")]],
        },
        [screenTag]: "archive",
      });

    expect(tree([[key("Место"), key("Описание")]])).toEqual(["rows"]);
    expect(tree([[key("Изменить"), key("Статус")]])).toEqual([]);
    expect(tree([[key("Программа вечера"), key("Убрать")]])).toEqual([]);
    expect(tree([[key("←"), key("→")]])).toEqual([]);
  });

  it("holds a question to the reply mode and a cancel button", () => {
    const question = (markup: Record<string, unknown>) =>
      rulesOf("sendMessage", {
        chat_id: 42,
        text: "Где встречаемся?",
        reply_markup: markup,
        [screenTag]: "question",
      });

    expect(
      question({ force_reply: true, inline_keyboard: [[key("Отмена")]] }),
    ).toEqual([]);
    expect(question({ force_reply: true })).toEqual(["nav"]);
    expect(question({ inline_keyboard: [[key("Отмена")]] })).toEqual(["nav"]);
    // Правка вопроса на месте режима ответа не несёт: его поставила отправка.
    expect(
      rulesOf("editMessageText", {
        text: "Где встречаемся?",
        reply_markup: { inline_keyboard: [[key("Отмена")]] },
        [screenTag]: "question",
      }),
    ).toEqual([]);
  });

  it("holds the date choice to a cancel row and no reply mode", () => {
    const choice = (markup: Record<string, unknown>) =>
      rulesOf("editMessageText", {
        text: "<b>Дата и время</b>\n\nКогда встречаемся? Выбери день.",
        parse_mode: "HTML",
        reply_markup: markup,
        [screenTag]: "date-presets",
      });
    const rows = [
      [key("чт 1"), key("пт 2"), key("сб 3"), key("вс 4")],
      [key("Другая дата")],
    ];

    expect(choice({ inline_keyboard: [...rows, [key("Отмена")]] })).toEqual([]);
    // Режим ответа остался бы висеть в клиенте после выбора кнопкой.
    expect(
      choice({
        force_reply: true,
        inline_keyboard: [...rows, [key("Отмена")]],
      }),
    ).toEqual(["nav"]);
    expect(choice({ inline_keyboard: rows })).toEqual(["nav"]);
  });

  it("keeps the cancel and refresh words where they belong", () => {
    expect(
      rulesOf(
        "editMessageText",
        screen("upcoming", "<b>Ближайшие сходки</b>", [
          [key("Обновить")],
          [key("‹ Меню")],
        ]),
      ),
    ).toEqual(["vocabulary"]);
    expect(
      rulesOf(
        "editMessageText",
        screen("community", "<b>Состав сообщества</b>", [
          [key("Обновить")],
          [key("‹ Меню")],
        ]),
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        "editMessageText",
        screen("upcoming", "<b>Ближайшие сходки</b>", [
          [key("Отмена")],
          [key("‹ Меню")],
        ]),
      ),
    ).toEqual(["vocabulary"]);
    expect(
      rulesOf(
        "editMessageText",
        screen("upcoming", "<b>Ближайшие сходки</b>", [
          [key("[x] Новые сходки")],
          [key("‹ Меню")],
        ]),
      ),
    ).toEqual(["vocabulary"]);
  });

  it("requires a way out of a refusal and none under a no-access frame", () => {
    const refusal = (rows: Key[][]) =>
      rulesOf(
        "editMessageText",
        screen("refusal", "<b>Не получилось</b>", rows),
      );

    expect(refusal([[key("Повторить")], [key("Меню")]])).toEqual([]);
    expect(refusal([[key("‹ Сходка")]])).toEqual([]);
    expect(refusal([])).toEqual(["nav"]);
    expect(
      rulesOf(
        "sendMessage",
        screen("no-access", "<b>Заявка ждёт проверки</b>", [[key("Меню")]]),
      ),
    ).toEqual(["nav"]);
  });

  it("requires links marked with ↗ and only them under a no-access frame with a way out", () => {
    const link = (text: string): Key => ({ text, url: "https://t.me/x_bot" });
    const linked = (rows: Key[][]) =>
      rulesOf(
        "sendMessage",
        screen("no-access-link", "<b>Заявка ждёт проверки</b>", rows),
      );

    expect(linked([[link("Бот аукциона ↗")]])).toEqual([]);
    // Кадр со ссылкой, потерявший её, не проходит за кадр без выхода.
    expect(linked([])).toEqual(["nav"]);
    expect(linked([[link("Бот аукциона")]])).toEqual(["nav"]);
    expect(linked([[link("Бот аукциона ↗")], [key("Меню")]])).toEqual(["nav"]);
    // Под кадром без выхода ссылка по-прежнему нарушение.
    expect(
      rulesOf(
        "sendMessage",
        screen("no-access", "<b>Доступ закрыт</b>", [[link("Бот аукциона ↗")]]),
      ),
    ).toEqual(["nav"]);
  });

  it("caps rows and row width, sparing a row of short presets", () => {
    const rows = (keyboard: Key[][]) =>
      rulesOf("editMessageText", {
        chat_id: 42,
        message_id: 9,
        rich_message: { html: "<h1>Настолки</h1>" },
        reply_markup: {
          inline_keyboard: [...keyboard, [key("‹ Архив"), key("Меню")]],
        },
        [screenTag]: "card",
      });

    expect(rows([[key("Изменить"), key("Статус")]])).toEqual([]);
    expect(
      rows([[key("18:00"), key("19:00"), key("20:00"), key("21:00")]]),
    ).toEqual([]);
    expect(rows([[key("Изменить"), key("Статус"), key("Материалы")]])).toEqual([
      "rows",
    ]);
    expect(
      rows([[key("1")], [key("2")], [key("3")], [key("4")], [key("5")]]),
    ).toEqual(["rows"]);
  });

  it("flags callback data over the telegram limit", () => {
    expect(
      rulesOf(
        "editMessageText",
        screen("upcoming", "<b>Ближайшие сходки</b>", [
          [{ text: "Сходка", callback_data: "v".repeat(65) }],
          [key("‹ Меню")],
        ]),
      ),
    ).toEqual(["callback-data"]);
  });

  it("leaves a trace free to keep its own keyboard", () => {
    expect(
      rulesOf("sendMessage", {
        chat_id: 42,
        text: "Новая сходка: Настолки",
        reply_markup: {
          inline_keyboard: [
            [key("Открыть сходку")],
            [key("Не присылать новые сходки")],
          ],
        },
        [screenTag]: "notification",
      }),
    ).toEqual([]);
  });

  it("stays silent on a legacy screen until it passes the rules", () => {
    expect(
      rulesOf(
        "editMessageText",
        screen("old", "Архив сходок", [[key("Обновить")]], {
          parse_mode: undefined,
        }),
      ),
    ).toEqual([]);
    expect(
      rulesOf(
        "editMessageText",
        screen("old", "<b>Архив</b>", [[key("‹ Меню")]]),
      ),
    ).toEqual(["legacy-outlived"]);
  });
});

describe("harness recorder", () => {
  const identity: IdentityResolver = {
    resolve: async () => ({
      kind: "resolved",
      identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
      globalRoles: ["member"],
      rights: ["hub", "auction"],
      blocked: false,
    }),
  };

  it("reports a keyboard that bypassed the single sender", async () => {
    const { bot } = createHarness(identity);
    await bot.init();

    await bot.api.sendMessage(42, "Привет", {
      reply_markup: new InlineKeyboard().text("Меню", "v1:nav:start"),
    });

    expect(takeViolations()).toMatchObject([
      { rule: "untagged", method: "sendMessage" },
    ]);
  });

  it("reports nothing for a marked trace", async () => {
    const { bot } = createHarness(identity);
    await bot.init();

    await bot.api.sendMessage(42, "Доступ открыт.", {
      ...screenMark("access-opened"),
      reply_markup: new InlineKeyboard().text("Ближайшие сходки", "v1:nav:hub"),
    });

    expect(takeViolations()).toEqual([]);
  });
});
