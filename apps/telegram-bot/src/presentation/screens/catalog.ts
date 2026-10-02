// Каталог экранов бота — данные дизайн-кода (docs/design/bot/design-code.md).
// Каждый вызов Bot API, который несёт клавиатуру, называет свою запись, и по
// ней линтер test kit проверяет экран. Правила живут здесь, а не в ревью.

/** Класс сообщения: от него зависит, что делает нажатие под ним. */
export type MessageClass = "screen" | "question" | "trace";

/**
 * Что обязано стоять в конце клавиатуры:
 * - `root` — меню, ряда возврата нет;
 * - `tree` — `[‹ Родитель] [Меню]`, у детей меню — `[‹ Меню]`;
 * - `confirm` — `[Да, …]` и `[Нет]` двумя рядами;
 * - `question` — режим ответа и `[Отмена]`;
 * - `exit` — кадр отказа: «Повторить», возврат или «Меню»;
 * - `free` — след: клавиатура принадлежит самому сообщению;
 * - `none` — клавиатуры нет вовсе.
 */
export type NavRule =
  | "root"
  | "tree"
  | "confirm"
  | "question"
  | "exit"
  | "free"
  | "none";

export type ScreenEntry = {
  class: MessageClass;
  nav: NavRule;
  /** Заголовок первой строкой; нет — заголовок даёт содержимое (сходка). */
  title?: string;
  /** Родитель в дереве. `meetup-list` — список, в котором сходка стоит. */
  parent?: string;
  /** Короткое имя для возврата с дочерних экранов: «‹ Имя». */
  backName?: string;
  /** «Обновить» разрешено: содержимое меняется без участия человека. */
  refresh?: true;
  /** Потолок рядов клавиатуры, если он строже общего. */
  maxRows?: number;
  /**
   * Экран ещё не переведён на дизайн-код. Линтер его правилами не проверяет,
   * но падает, когда такой экран уже проходит все правила: пометка не
   * переживает свою причину.
   */
  legacy?: true;
};

export const meetupListParent = "meetup-list";

export const screenCatalog = {
  menu: {
    class: "screen",
    nav: "root",
    title: "Меню",
    backName: "Меню",
    legacy: true,
  },
  upcoming: {
    class: "screen",
    nav: "tree",
    title: "Ближайшие сходки",
    parent: "menu",
    backName: "Ближайшие",
    legacy: true,
  },
  archive: {
    class: "screen",
    nav: "tree",
    title: "Архив",
    parent: "menu",
    backName: "Архив",
    legacy: true,
  },
  "notify-global": {
    class: "screen",
    nav: "tree",
    title: "Уведомления",
    parent: "menu",
    legacy: true,
  },
  manage: {
    class: "screen",
    nav: "tree",
    title: "Управление",
    parent: "menu",
    backName: "Управление",
    legacy: true,
  },
  hidden: {
    class: "screen",
    nav: "tree",
    title: "Скрытые сходки",
    parent: "manage",
    backName: "Скрытые",
    legacy: true,
  },
  community: {
    class: "screen",
    nav: "tree",
    title: "Состав сообщества",
    parent: "manage",
    backName: "Состав",
    refresh: true,
    legacy: true,
  },
  card: {
    class: "screen",
    nav: "tree",
    parent: meetupListParent,
    backName: "Сходка",
    maxRows: 5,
    legacy: true,
  },
  edit: {
    class: "screen",
    nav: "tree",
    title: "Изменить сходку",
    parent: "card",
    legacy: true,
  },
  status: {
    class: "screen",
    nav: "tree",
    title: "Статус",
    parent: "card",
    legacy: true,
  },
  materials: {
    class: "screen",
    nav: "tree",
    title: "Материалы",
    parent: "card",
    backName: "Материалы",
    legacy: true,
  },
  "notify-meetup": {
    class: "screen",
    nav: "tree",
    title: "Уведомления сходки",
    parent: "card",
    legacy: true,
  },
  "form-preview": {
    class: "screen",
    nav: "tree",
    parent: "manage",
    legacy: true,
  },
  "form-published": {
    class: "screen",
    nav: "tree",
    parent: "manage",
    legacy: true,
  },
  "state-confirm": { class: "screen", nav: "confirm", legacy: true },
  "past-date-confirm": { class: "screen", nav: "confirm", legacy: true },
  "publish-confirm": { class: "screen", nav: "confirm", legacy: true },
  "material-confirm": { class: "screen", nav: "confirm", legacy: true },
  "material-remove-confirm": { class: "screen", nav: "confirm", legacy: true },
  "broadcast-confirm": { class: "screen", nav: "confirm", legacy: true },
  "broadcast-result": { class: "screen", nav: "exit", legacy: true },
  question: { class: "question", nav: "question", legacy: true },
  refusal: { class: "screen", nav: "exit", legacy: true },
  "no-access": { class: "screen", nav: "none", legacy: true },
  notification: { class: "trace", nav: "free" },
  "access-opened": { class: "trace", nav: "free" },
} as const satisfies Record<string, ScreenEntry>;

export type ScreenId = keyof typeof screenCatalog;

/** Списки, в которых может стоять сходка: родитель карточки — один из них. */
export const meetupLists = ["upcoming", "archive", "hidden"] as const;
