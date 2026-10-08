// Каталог экранов бота аукциона — данные дизайн-кода
// (docs/design/bot/design-code.md, «Дерево бота аукциона»). Каждая отправка
// экрана называет свою запись меткой, и по ней линтер test kit сверяет экран
// с правилами. Форма записи и линтер — линтер test kit `testkit/lint/`;
// сборка бота его не видит, поэтому форму каталога проверяет test kit.
//
// Исключений `waive` в каталоге нет: экраны переверстаны (PER-463). Механизм
// остаётся для экрана, который вводится раньше своих правил, и тест каталога
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

/** Родитель ленты: список аукционов, в котором аукцион стоит сейчас. */
export const auctionListParent = "auction-list";
export const auctionLists = ["auctions", "past"] as const;

export const screenCatalog = {
  menu: {
    class: "screen",
    nav: "root",
    title: "Меню",
    backName: "Меню",
  },
  // Отметку ознакомления ставит возврат «‹ Меню» под самим FAQ.
  faq: {
    class: "screen",
    nav: "tree",
    title: "Правила и FAQ",
    parent: "menu",
    backName: "FAQ",
  },
  // Состояния FAQ, а не узлы: ссылка на правила и адрес для вопросов не
  // указаны. Возврат из них ведёт в FAQ.
  details: {
    class: "screen",
    nav: "tree",
    title: "Правила и FAQ",
    parent: "faq",
  },
  question: {
    class: "screen",
    nav: "tree",
    title: "Правила и FAQ",
    parent: "faq",
  },
  auctions: {
    class: "screen",
    nav: "tree",
    title: "Аукционы",
    parent: "menu",
    backName: "Аукционы",
  },
  past: {
    class: "screen",
    nav: "tree",
    title: "Прошедшие аукционы",
    parent: "menu",
    backName: "Прошедшие",
  },
  // Лента возвращает в тот список, где аукцион стоит сейчас.
  feed: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: auctionListParent,
    backName: "Лоты",
  },
  // «Обновить» разрешено, пока у лота нет итога (PER-462). Состояния лота
  // каталог не знает: кнопку по состоянию ставит аукционное дерево, и держат это
  // его contract cases.
  // Предел рядов под карточкой назвал лист ставки (PER-317): ставка по шагу,
  // своя сумма, автоставка, «Обновить», «Ставки» и навигация — с рядом
  // «Изменить лот» в хабе семь.
  lot: {
    class: "screen",
    nav: "tree",
    parent: "feed",
    backName: "Лот",
    refresh: true,
    maxRows: 7,
  },
  history: {
    class: "screen",
    nav: "tree",
    title: "Ставки",
    parent: "lot",
  },
  // Лист ставки (PER-317): подтверждение без ряда навигации, вопросы с
  // `force_reply` и «Отменой», выбор имени под лотом. Ставка и автоставка —
  // траты денег: их «Да» красное (PER-473). Принятая команда — кадр исхода с
  // «К лоту» и «Меню». Заголовок подтверждения — вопрос с суммой (PER-472), и
  // линтер сверяет его по началу: «Поставить 1 300 ₽?».
  "bid-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Поставить",
    money: true,
  },
  "proxy-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Включить автоставку",
    money: true,
  },
  "bid-accepted": { class: "screen", nav: "exit", title: "Ставка" },
  "proxy-accepted": { class: "screen", nav: "exit", title: "Автоставка" },
  // Отказ команды и непринятый ответ — тоже кадры исхода (PER-472): исход в
  // заголовке, название лота в кавычках, «К лоту» и «Меню», у непринятого
  // ответа над ними «Ввести заново». Заголовок — сам исход, поэтому в записи
  // его нет.
  "command-result": { class: "screen", nav: "exit" },
  "answer-refused": { class: "screen", nav: "exit" },
  "bid-question": { class: "question", nav: "question" },
  "proxy-question": { class: "question", nav: "question" },
  "alias-question": { class: "question", nav: "question" },
  "name-choice": {
    class: "screen",
    nav: "tree",
    title: "Имя в аукционе",
    parent: "lot",
  },
  // Кадры ожидания допуска и блокировки: в дерево не входят, клавиатуры нет.
  denied: { class: "screen", nav: "none" },
  // Переход участника сообщества в бот хаба (ADR-064, пункт 2): торгов здесь
  // у него нет, ссылки на экране тоже.
  "in-community": { class: "screen", nav: "none" },
  // Кадры отказа несут выход: «Меню» у устаревшего экрана, «Повторить» и
  // «Меню» у недоступного сервиса.
  outdated: { class: "screen", nav: "exit" },
  unavailable: { class: "screen", nav: "exit" },
  // Уведомление из шины — след: клавиатура принадлежит самому сообщению, а
  // метку несёт отправитель доставки (`delivery/message.ts`), не адаптер.
  notification: { class: "trace", nav: "free" },
} as const;

export type ScreenId = keyof typeof screenCatalog;
