// Каталог экранов бота аукциона — данные дизайн-кода
// (docs/design/bot/design-code.md, «Дерево бота аукциона»). Каждая отправка
// экрана называет свою запись меткой, и по ней линтер test kit сверяет экран
// с правилами. Форма записи и линтер — общий пакет `shared/typescript/screen-lint`;
// сборка бота его не видит, поэтому форму каталога проверяет test kit.
//
// Экраны ещё не переверстаны: правило, которое экран нарушает сегодня, снято
// именованным исключением `waive` с задачей перевёрстки. Тест каталога
// (`screen-catalog.test.ts`) требует, чтобы исключения совпадали с тем, что
// экран нарушает на самом деле, — исключение не переживает свою причину.

// Метка едет вместе с вызовом Bot API: grammY переносит параметры разворотом
// объекта, а он копирует и свойства с ключом-символом. До Telegram метка не
// доходит — JSON символы не сериализует, — зато её видит трансформер test kit.
export const screenTag: unique symbol = Symbol("screen");

/** Разворачивается в параметры вызова: `{ ...screenMark("menu"), reply_markup }`. */
export function screenMark(id: ScreenId): { [screenTag]: ScreenId } {
  return { [screenTag]: id };
}

const shellTitle =
  "PER-463: оболочка шлёт текст без HTML и жирного заголовка (расхождения 12, 13)";

export const screenCatalog = {
  menu: {
    class: "screen",
    nav: "root",
    title: "Меню",
    backName: "Меню",
    waive: { title: shellTitle },
  },
  // Короткого имени для возврата у FAQ нет: подпись возврата из его состояний
  // выбирает перевёрстка. До неё `nav` у `details` и `question` не проходит ни
  // при какой клавиатуре, и снимать его исключение можно только вместе с
  // `backName` здесь.
  faq: {
    class: "screen",
    nav: "tree",
    title: "Правила и FAQ",
    parent: "menu",
    waive: {
      title: shellTitle,
      nav: "PER-463: вход в меню — «В меню» первым рядом (расхождение 6)",
    },
  },
  // Состояния FAQ, а не узлы: ссылка на правила и адрес для вопросов не
  // указаны. Возврат из них ведёт в FAQ.
  details: {
    class: "screen",
    nav: "tree",
    parent: "faq",
    waive: {
      title: shellTitle,
      nav: "PER-463: вместо возврата в FAQ — «Правила и FAQ» и «В меню» (расхождения 6, 7)",
    },
  },
  question: {
    class: "screen",
    nav: "tree",
    parent: "faq",
    waive: {
      title: shellTitle,
      nav: "PER-463: вместо возврата в FAQ — «Правила и FAQ» и «В меню» (расхождения 6, 7)",
    },
  },
  // Узел «Лоты», пока аукцион не назван: кадр «каталог пока не открыт».
  auctions: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: "menu",
    waive: {
      title: shellTitle,
      nav: "PER-463: «Правила и FAQ» боковой ссылкой и «В меню» вместо «‹ Меню» (расхождения 6, 7)",
    },
  },
  feed: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: "menu",
    backName: "Лоты",
    waive: {
      title: shellTitle,
      nav: "PER-463: «Правила и FAQ» боковой ссылкой и «В меню» вместо «‹ Меню» (расхождения 6, 7)",
      rows: "PER-463: листание «‹ Предыдущие» и «Следующие ›» вместо «←» и «→» — пара не короткая (расхождение 10)",
    },
  },
  // «Обновить» разрешено, пока у лота нет итога (PER-462). Состояния лота
  // каталог не знает, поэтому кнопку под лотом с итогом (расхождение 8)
  // линтер не видит: её уводит из тела перевёрстка карточки (PER-465).
  lot: {
    class: "screen",
    nav: "tree",
    parent: "feed",
    refresh: true,
    waive: {
      title:
        "PER-465: карточка лота — подпись к фото без HTML и жирного названия (расхождения 4, 12, 13)",
      nav: "PER-463: возврат «К лотам», «Правила и FAQ» и «В меню» разными рядами (расхождения 5, 6, 7)",
      vocabulary:
        "PER-463: возврат подписан «К лотам», а не «‹ Лоты» (расхождение 5)",
    },
  },
  welcome: {
    class: "screen",
    nav: "none",
    waive: { title: shellTitle },
  },
  // Кадры ожидания допуска и блокировки: в дерево не входят, клавиатуры нет.
  denied: {
    class: "screen",
    nav: "none",
    waive: { title: shellTitle },
  },
  outdated: {
    class: "screen",
    nav: "exit",
    waive: {
      title: shellTitle,
      nav: "PER-463: кадр отказа без «Повторить», возврата и «Меню» (расхождение 9)",
    },
  },
  unavailable: {
    class: "screen",
    nav: "exit",
    waive: {
      title: shellTitle,
      nav: "PER-463: кадр отказа без «Повторить», возврата и «Меню» (расхождение 9)",
    },
  },
} as const;

export type ScreenId = keyof typeof screenCatalog;
