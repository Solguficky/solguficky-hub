// Каталог экранов бота — данные дизайн-кода (docs/design/bot/design-code.md).
// Каждый вызов Bot API, который несёт клавиатуру, называет свою запись, и по
// ней линтер test kit проверяет экран. Правила живут здесь, а не в ревью.
//
// Форма записи и сам линтер — общий пакет `shared/typescript/screen-lint`.
// Сборка бота его не видит, поэтому `satisfies` здесь нет: форму каталога
// проверяет test kit, когда отдаёт его линтеру (`testkit/screen-lint.ts`).

export const meetupListParent = "meetup-list";

/**
 * Родитель ленты лотов: сходка, у которой идёт аукцион. После рестарта бот её
 * может не знать — тогда лента возвращает в «Ближайшие» (ADR-030, дополнение
 * 2026-10-04; PER-307).
 */
export const auctionFeedParent = "auction-feed-parent";

export const screenCatalog = {
  menu: {
    class: "screen",
    nav: "root",
    title: "Меню",
    backName: "Меню",
  },
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
  "notify-global": {
    class: "screen",
    nav: "tree",
    title: "Уведомления",
    parent: "menu",
  },
  manage: {
    class: "screen",
    nav: "tree",
    title: "Управление",
    parent: "menu",
    backName: "Управление",
  },
  hidden: {
    class: "screen",
    nav: "tree",
    title: "Скрытые сходки",
    parent: "manage",
    backName: "Скрытые",
  },
  community: {
    class: "screen",
    nav: "tree",
    title: "Состав сообщества",
    parent: "manage",
    backName: "Состав",
    refresh: true,
  },
  "community-pending": {
    class: "screen",
    nav: "tree",
    title: "Ожидают допуска",
    parent: "community",
    refresh: true,
  },
  "community-admitted": {
    class: "screen",
    nav: "tree",
    title: "Допущенные",
    parent: "community",
    refresh: true,
  },
  "community-usernames": {
    class: "screen",
    nav: "tree",
    title: "Разрешённые ники",
    parent: "community",
    refresh: true,
  },
  refused: {
    class: "screen",
    nav: "tree",
    title: "Отказанные",
    parent: "manage",
  },
  "source-channels": {
    class: "screen",
    nav: "tree",
    title: "Каналы прихода",
    parent: "manage",
    backName: "Каналы",
  },
  // Заголовок карточки — номер заявки и круг, поэтому его даёт содержимое.
  application: {
    class: "screen",
    nav: "tree",
    parent: "manage",
  },
  card: {
    class: "screen",
    nav: "tree",
    parent: meetupListParent,
    backName: "Сходка",
    maxRows: 5,
  },
  edit: {
    class: "screen",
    nav: "tree",
    title: "Изменить сходку",
    parent: "card",
  },
  status: {
    class: "screen",
    nav: "tree",
    title: "Статус",
    parent: "card",
  },
  materials: {
    class: "screen",
    nav: "tree",
    title: "Материалы",
    parent: "card",
    backName: "Материалы",
  },
  // Аукцион сходки (PER-307): тело — общий пакет, оболочка — хаб.
  lots: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: auctionFeedParent,
    backName: "Лоты",
  },
  // Заголовок карточки лота — его название. «Обновить» тело ставит, пока у
  // лота нет итога: цена и лидер меняются без участия человека.
  lot: {
    class: "screen",
    nav: "tree",
    parent: "lots",
    backName: "Лот",
    refresh: true,
  },
  // Хронология ставок лота (PER-309): тело — общий пакет, оболочка — хаб.
  bids: {
    class: "screen",
    nav: "tree",
    title: "Ставки",
    parent: "lot",
  },
  "notify-meetup": {
    class: "screen",
    nav: "tree",
    title: "Уведомления сходки",
    parent: "card",
  },
  draft: {
    class: "screen",
    nav: "tree",
    parent: "hidden",
  },
  "state-confirm": { class: "screen", nav: "confirm" },
  "past-date-confirm": { class: "screen", nav: "confirm" },
  "publish-confirm": { class: "screen", nav: "confirm" },
  "material-confirm": { class: "screen", nav: "confirm" },
  "material-remove-confirm": { class: "screen", nav: "confirm" },
  "broadcast-confirm": { class: "screen", nav: "confirm" },
  "community-close-confirm": { class: "screen", nav: "confirm" },
  "reconsider-confirm": { class: "screen", nav: "confirm" },
  "application-decline-confirm": { class: "screen", nav: "confirm" },
  "broadcast-result": { class: "screen", nav: "exit" },
  question: { class: "question", nav: "question" },
  // Выбор даты кнопками: экран, а не вопрос. Режима ответа у него нет, поэтому
  // выбор кнопкой ничего за собой не оставляет, а сам экран правится на месте.
  "date-presets": { class: "screen", nav: "choice" },
  refusal: { class: "screen", nav: "exit" },
  "no-access": { class: "screen", nav: "none" },
  notification: { class: "trace", nav: "free" },
  "access-opened": { class: "trace", nav: "free" },
} as const;

export type ScreenId = keyof typeof screenCatalog;

/** Списки, в которых может стоять сходка: родитель карточки — один из них. */
export const meetupLists = ["upcoming", "archive", "hidden"] as const;

/** Куда возвращает лента лотов: к сходке либо, если она неизвестна, в «Ближайшие». */
export const auctionFeedParents = ["card", "upcoming"] as const;
