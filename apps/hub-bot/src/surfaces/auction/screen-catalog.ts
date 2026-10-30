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

/** Разворачивается в параметры вызова: `{ ...screenMark("faq"), reply_markup }`. */
export function screenMark(id: ScreenId): { [screenTag]: ScreenId } {
  return { [screenTag]: id };
}

/** Родитель корня аукциона: список аукционов, в котором аукцион стоит сейчас. */
export const auctionListParent = "auction-list";
export const auctionLists = ["auctions", "past"] as const;

// Корень один — «Меню», общий родитель разделов «Аукционы», FAQ и
// «Настроек»: команды открывают раздел сразу, а «‹ Меню» с раздела ведёт в
// корень. «Прошедшие» — внутри «Аукционов» (PER-592;
// пересматривает решение владельца 10 октября 2026 года). Что цепочка
// родителей каждого экрана доходит до корня, держит проверка графа
// `inspectCatalog` test kit.
export const screenCatalog = {
  "my-achievements": {
    class: "screen",
    nav: "tree",
    title: "Ачивки",
    parent: "menu",
    backName: "Ачивки",
  },
  "my-achievement": {
    class: "screen",
    nav: "tree",
    title: "Ачивка",
    parent: "my-achievements",
  },
  "auction-achievements": {
    class: "screen",
    nav: "tree",
    title: "Ачивки",
    parent: "root",
    backName: "Ачивки",
  },
  "auction-achievement": {
    class: "screen",
    nav: "tree",
    title: "Ачивка",
    parent: "auction-achievements",
  },
  "achievements-unavailable": {
    class: "screen",
    nav: "exit",
    title: "Ачивки недоступны",
  },

  menu: {
    class: "screen",
    nav: "root",
    title: "Меню",
    backName: "Меню",
  },
  // Отметку ознакомления ставит кнопка «Аукционы» под самим FAQ.
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
    parent: "auctions",
    backName: "Прошедшие",
  },
  // Частота «перебили» (PER-515): раздел команды `/notifications`, пять
  // режимов по одному в ряд. Отказ Notifications — общий кадр `unavailable`.
  notify: {
    class: "screen",
    nav: "tree",
    title: "Уведомления",
    parent: "settings",
    backName: "Уведомления",
  },
  // Те же настройки, открытые кнопкой «Частота уведомлений» под вестью (№73
  // прогона 14 октября 2026 года): человек пришёл из вести, а не из
  // «Настроек», и возврата в дерево у экрана нет — клавиатура только из
  // кнопок настроек, весть с «К лоту» остаётся выше в чате.
  "notify-notice": {
    class: "screen",
    nav: "free",
    title: "Уведомления",
  },
  // «Настройки» (PER-595): уведомления и имя в идущем аукционе.
  settings: {
    class: "screen",
    nav: "tree",
    title: "Настройки",
    parent: "menu",
    backName: "Настройки",
  },
  // Имя в аукционе из «Настроек» (PER-595): тело дерева, общее с хабом;
  // возврат ставит оболочка. Вопрос псевдонима и непринятый ответ — общие
  // записи `alias-question` и `answer-refused`.
  "name-settings": {
    class: "screen",
    nav: "tree",
    title: "Имя в аукционе",
    parent: "settings",
    backName: "Имя в аукционе",
  },
  // Избранное (PER-495): свои отмеченные лоты, у закрытых — итог. Список
  // аукционного дерева; вход — только из корня аукциона, туда и возврат
  // (PER-644).
  favorites: {
    class: "screen",
    nav: "tree",
    title: "Избранное",
    parent: "root",
    backName: "Избранное",
  },
  // Корень аукциона (PER-605): тело дерева, общее с хабом. Список аукционов
  // открывает его, как в хабе (PER-644), а возвращает он в тот список, где
  // аукцион стоит сейчас.
  root: {
    class: "screen",
    nav: "tree",
    title: "Аукцион",
    parent: auctionListParent,
    backName: "Аукцион",
  },
  // Лента — под корнем аукциона (PER-644).
  feed: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: "root",
    backName: "Лоты",
  },
  // Раздел ленты (PER-719): лоты раздела в порядке администратора, возврат —
  // к списку разделов.
  "feed-section": {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: "feed",
    backName: "Лоты",
  },
  // Прогнозы участника — тело общего аукционного дерева (ADR-067), вход из
  // корня аукциона и возврат туда же (PER-644).
  "prediction-results": {
    class: "screen",
    nav: "tree",
    title: "Итоги прогнозов",
    parent: "root",
    backName: "Итоги",
  },
  // Хроники дня (PER-725) — тело общего аукционного дерева: вход из корня
  // аукциона во время онлайн-недели и возврат туда же.
  "day-chronicle": {
    class: "screen",
    nav: "tree",
    title: "Хроники дня",
    parent: "root",
    backName: "Хроники дня",
  },
  // Статистика аукциона (PER-770) — тело общего аукционного дерева. Входа в
  // этом боте нет (PER-800): шлюз пускает её только ведущему в хабе, а запись
  // остаётся, потому что тело у двух оболочек общее.
  "auction-chronicle": {
    class: "screen",
    nav: "tree",
    title: "Статистика аукциона",
    parent: "root",
    backName: "Статистика",
  },
  predictions: {
    class: "screen",
    nav: "tree",
    title: "Прогнозы аукциона",
    parent: "root",
    backName: "Прогнозы",
  },
  "prediction-lots": {
    class: "screen",
    nav: "tree",
    title: "Выбрать лот",
    parent: "predictions",
  },
  "prediction-name-choice": {
    class: "screen",
    nav: "tree",
    title: "Имя в аукционе",
    parent: "predictions",
  },
  "prediction-number-question": { class: "question", nav: "question" },
  "prediction-alias-question": { class: "question", nav: "question" },
  "prediction-answer-refused": { class: "screen", nav: "exit" },
  // «Обновить» разрешено, пока у лота нет итога (PER-462). Состояния лота
  // каталог не знает: кнопку по состоянию ставит аукционное дерево, и держат это
  // его contract cases.
  // Ряды под карточкой складываются по смыслу (PER-594, PER-644, PER-669):
  // ставка по шагу, своя сумма с автоставкой, «Ставки» с избранным (PER-495),
  // «Лоты сета» (ADR-073, п. 7), листание `[◀️][🔄 Обновить][▶️]` и навигация —
  // шесть; в хабе к ним добавляется «🛠 Изменить лот».
  lot: {
    class: "screen",
    nav: "tree",
    parent: "feed",
    backName: "Лот",
    refresh: true,
    maxRows: 6,
  },
  // Сет лотов (ADR-073, п. 7): экран-раздел карточки лота — лоты сета и,
  // после итога, кто его собрал. Открывается с карточки лота сета.
  set: {
    class: "screen",
    nav: "tree",
    title: "Лоты сета",
    subject: true,
    parent: "lot",
  },
  history: {
    class: "screen",
    nav: "tree",
    title: "Ставки",
    subject: true,
    parent: "lot",
  },
  // Лист ставки (PER-317): подтверждение без ряда навигации, вопросы с
  // `force_reply` и «Отменой», выбор имени под лотом. Ставка и автоставка —
  // траты денег: их «Да» красное (PER-473). Принятая команда — кадр исхода с
  // «‹ Лот» и «‹ Лоты» (PER-595). Заголовок подтверждения — вопрос с суммой (PER-472), и
  // линтер сверяет его по началу: «Поставить 1 300 ₽?».
  "bid-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Поставить",
    irreversible: true,
  },
  "proxy-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Включить автоставку",
    irreversible: true,
  },
  "bid-accepted": { class: "screen", nav: "exit", title: "Ставка" },
  "proxy-accepted": { class: "screen", nav: "exit", title: "Автоставка" },
  // Отказ команды и непринятый ответ — тоже кадры исхода (PER-472): исход в
  // заголовке, название лота жирным, «‹ Лот», у непринятого ответа над
  // ним «Ввести заново». Заголовок — сам исход, поэтому в записи
  // его нет.
  "command-result": { class: "screen", nav: "exit" },
  // Notifications ещё не знает лот — тоже кадр исхода с «‹ Лот».
  "follow-refused": {
    class: "screen",
    nav: "exit",
    title: "Лот пока нельзя добавить в избранное",
  },
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
  // Розыгрыш среди участников (ADR-066): вход — «Розыгрыш» в корне аукциона,
  // возврат — туда же (PER-644). Кнопка регистрации стоит только в окне регистрации.
  // Выбор имени перед регистрацией — тот же экран, что перед ставкой, с
  // возвратом в розыгрыш; вопрос псевдонима и непринятый ответ — общие
  // записи `alias-question` и `answer-refused`.
  raffle: {
    class: "screen",
    nav: "tree",
    title: "Розыгрыш среди участников",
    parent: "root",
    backName: "Розыгрыш",
  },
  "raffle-name-choice": {
    class: "screen",
    nav: "tree",
    title: "Имя в аукционе",
    parent: "raffle",
  },
  // Регистрация принята (прогон 14.10, №69): кадр исхода с отменой и
  // возвратами в розыгрыш и в корень аукциона.
  "raffle-registered": {
    class: "screen",
    nav: "exit",
    title: "Ты в розыгрыше",
  },
  // Как проверить честность (PER-618): техника розыгрыша за кнопкой с его
  // экрана, возврат — «‹ Розыгрыш».
  "raffle-proof": {
    class: "screen",
    nav: "tree",
    title: "Как проверить честность",
    parent: "raffle",
  },
  // Счета победителя (PER-322): вход — «Мои счета» в корне аукциона, пока у
  // смотрящего есть счета, возврат — туда же. Счёт — лист списка с выбором
  // способа получения; заголовок называет лот, линтер сверяет его по началу.
  invoices: {
    class: "screen",
    nav: "tree",
    title: "Мои счета",
    parent: "root",
    backName: "Счета",
  },
  invoice: {
    class: "screen",
    nav: "tree",
    title: "Счёт",
    parent: "invoices",
  },
  // Счёта по кнопке нет: кадр исхода с «‹ Счета» или «Повторить».
  "invoice-missing": {
    class: "screen",
    nav: "exit",
    title: "Счёт не найден",
  },
  // Кадры ожидания допуска и блокировки: в дерево не входят, клавиатуры нет.
  denied: { class: "screen", nav: "none" },
  // Кадр ожидания допуска, когда адрес бота поддержки задан (PER-625,
  // ADR-068): одна кнопка-ссылка «Написать в поддержку ↗», навигации нет.
  "denied-support": { class: "screen", nav: "links" },
  // Приветствие человека без права (PER-592, дополнение ADR-060): заявку
  // ставит только его кнопка «Подать заявку».
  welcome: { class: "screen", nav: "apply" },
  // Подсказка на сообщение вне вопроса (PER-592): кадр исхода с «‹ Меню».
  hint: { class: "screen", nav: "exit" },
  // Переход участника сообщества в бот хаба (ADR-064, пункт 2): торгов здесь
  // у него нет, ссылки на экране тоже.
  "in-community": { class: "screen", nav: "none" },
  // Кадры отказа несут выход: «‹ Аукционы» у устаревшего экрана, «Повторить»
  // и «‹ Аукционы» у недоступного сервиса.
  outdated: { class: "screen", nav: "exit" },
  unavailable: { class: "screen", nav: "exit" },
  // Уведомление из шины — след: клавиатура принадлежит самому сообщению, а
  // метку несёт отправитель доставки (`delivery/message.ts`), не адаптер.
  notification: { class: "trace", nav: "free" },
  // Трансляция хода торгов живого финала (PER-826): одно сообщение подписчика,
  // которое бот правит на каждую ставку; одна кнопка «Не следить».
  "bid-watch": { class: "trace", nav: "free" },
  // Промо-видео под «🎬 Промо» (PER-774): копия поста чата медиа ботов с
  // подписью и одной кнопкой «‹ Аукцион».
  promo: { class: "trace", nav: "tree", parent: "root" },
} as const;

export type ScreenId = keyof typeof screenCatalog;
