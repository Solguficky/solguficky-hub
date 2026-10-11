// Каталог экранов бота — данные дизайн-кода (docs/design/bot/design-code.md).
// Каждый вызов Bot API, который несёт клавиатуру, называет свою запись, и по
// ней линтер test kit проверяет экран. Правила живут здесь, а не в ревью.
//
// Форма записи и сам линтер — линтер test kit `testkit/lint/`.
// Сборка бота его не видит, поэтому `satisfies` здесь нет: форму каталога
// проверяет test kit, когда отдаёт его линтеру (`testkit/screen-lint.ts`).

export const meetupListParent = "meetup-list";

/**
 * Родитель ленты лотов: сходка, у которой идёт аукцион. После рестарта бот её
 * может не знать — тогда лента возвращает в «Сходки» (ADR-030, дополнение
 * 2026-10-04; PER-307).
 */
export const auctionFeedParent = "auction-feed-parent";

/**
 * Родители пунктов «Управления»: группа пункта, а у человека с одной группой —
 * само «Управление», которое сразу показывает её пункты (решение владельца
 * 10 октября 2026 года).
 */
export const manageMeetupsParent = "manage-meetups-parent";
export const manageApplicationsParent = "manage-applications-parent";
export const manageMembersParent = "manage-members-parent";

// Корневого экрана «Меню» нет: корни разделов — «Сходки», «Настройки»,
// «Помощь» и «Управление», их открывают команды кнопки меню клиента, и ряда
// навигации у корня нет (решение владельца 10 октября 2026 года).
export const screenCatalog = {
  meetups: {
    class: "screen",
    nav: "root",
    title: "Сходки",
    backName: "Сходки",
  },
  archive: {
    class: "screen",
    nav: "tree",
    title: "Архив",
    parent: "meetups",
    backName: "Архив",
  },
  settings: {
    class: "screen",
    nav: "root",
    title: "Настройки",
    backName: "Настройки",
  },
  "notify-global": {
    class: "screen",
    nav: "tree",
    title: "Уведомления",
    parent: "settings",
  },
  help: {
    class: "screen",
    nav: "root",
    title: "Помощь",
  },
  manage: {
    class: "screen",
    nav: "root",
    title: "Управление",
    backName: "Управление",
  },
  "manage-meetups": {
    class: "screen",
    nav: "tree",
    title: "Сходки и объявления",
    parent: "manage",
    backName: "Сходки и объявления",
  },
  "manage-applications": {
    class: "screen",
    nav: "tree",
    title: "Заявки и отказы",
    parent: "manage",
    backName: "Заявки и отказы",
  },
  "manage-members": {
    class: "screen",
    nav: "tree",
    title: "Участники",
    parent: "manage",
    backName: "Участники",
  },
  hidden: {
    class: "screen",
    nav: "tree",
    title: "Скрытые сходки",
    parent: manageMeetupsParent,
    backName: "Скрытые",
  },
  community: {
    class: "screen",
    nav: "tree",
    title: "Состав сообщества",
    parent: manageMembersParent,
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
  "community-moderators": {
    class: "screen",
    nav: "tree",
    title: "Модераторы аукциона",
    parent: "community",
    backName: "Модераторы",
    refresh: true,
  },
  "community-moderator-candidates": {
    class: "screen",
    nav: "tree",
    title: "Выдать модерацию",
    parent: "community-moderators",
  },
  refused: {
    class: "screen",
    nav: "tree",
    title: "Отказанные",
    parent: manageApplicationsParent,
  },
  // Отказанные очереди аукциона (ADR-064, пункт 15) — свой список.
  "refused-auction": {
    class: "screen",
    nav: "tree",
    title: "Отказанные в аукцион",
    parent: manageApplicationsParent,
  },
  "source-channels": {
    class: "screen",
    nav: "tree",
    title: "Каналы прихода",
    parent: manageMembersParent,
    backName: "Каналы",
  },
  // Заголовок карточки — номер заявки и круг, поэтому его даёт содержимое.
  application: {
    class: "screen",
    nav: "tree",
    parent: manageApplicationsParent,
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
  // Аукцион сходки (PER-307): тело — аукционное дерево, оболочка — хаб.
  lots: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: auctionFeedParent,
    backName: "Лоты",
  },
  "auction-faq": {
    class: "screen",
    nav: "tree",
    title: "Правила и FAQ",
    parent: "lots",
    backName: "Лоты",
  },
  // Заголовок карточки лота — его название. «Обновить» тело ставит, пока у
  // лота нет итога: цена и лидер меняются без участия человека. Предел рядов
  // назвал лист ставки (PER-317): три ряда ставки, «Обновить», «Ставки»,
  // избранное (PER-495), «Изменить лот» администратора и навигация.
  lot: {
    class: "screen",
    nav: "tree",
    parent: "lots",
    backName: "Лот",
    refresh: true,
    maxRows: 8,
  },
  // Избранное (PER-495): тело — аукционное дерево, оболочка — хаб. Открывается
  // из корня ленты рядом с «Правила и FAQ» и возвращает в неё.
  favorites: {
    class: "screen",
    nav: "tree",
    title: "Избранное",
    parent: "lots",
  },
  // Notifications ещё не знает лот — кадр исхода с «К лоту» и «Меню».
  "follow-refused": {
    class: "screen",
    nav: "exit",
    title: "Лот пока нельзя добавить в избранное",
  },
  // Правка лота администратором (PER-319): экран хаба, а не тело пакета.
  // Открывается с карточки лота и после названия нового лота.
  "lot-form": {
    class: "screen",
    nav: "tree",
    title: "Изменить лот",
    parent: "lot",
  },
  // Пульт аукциона администратора (PER-320): экран хаба, а не тело пакета.
  // Открывается из ленты лотов рядом с «Добавить лот».
  "auction-console": {
    class: "screen",
    nav: "tree",
    title: "Пульт",
    parent: "lots",
  },
  // Открытие онлайн-недели: отменить его нельзя, поэтому — подтверждение с
  // красным «Да» (решение владельца 10 октября 2026 года).
  "week-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Онлайн-неделя",
    irreversible: true,
  },
  // Удаление аукциона до торгов: черновик и сроки пропадают безвозвратно,
  // поэтому — подтверждение с красным «Да».
  "discard-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Удалить аукцион?",
    irreversible: true,
  },
  // Хронология ставок лота (PER-309): тело — аукционное дерево, оболочка — хаб.
  bids: {
    class: "screen",
    nav: "tree",
    title: "Ставки",
    parent: "lot",
  },
  // Лист ставки (PER-317): тело — аукционное дерево, тексты — оболочка хаба.
  // Подтверждение — без ряда навигации, выбор имени — под карточкой лота.
  // Ставка и автоставка — траты денег: их «Да» красное (PER-473). Принятая
  // команда — кадр исхода с «К лоту». Заголовок
  // подтверждения — вопрос с суммой (PER-472), линтер сверяет его по началу.
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
  // Отказ команды и непринятый ответ — кадры исхода (PER-472): исход в
  // заголовке, поэтому в записи его нет.
  "command-result": { class: "screen", nav: "exit" },
  "answer-refused": { class: "screen", nav: "exit" },
  "name-choice": {
    class: "screen",
    nav: "tree",
    title: "Имя в аукционе",
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
  // Подтверждения (решение владельца 10 октября 2026 года): «Да» красное
  // только там, где после нажатия обратного действия нет или тратятся
  // деньги, — признак `irreversible`. Скрытие сходки, снятие отложенной
  // публикации, прошедшая дата, прикрепление материала и пересмотр отказа
  // обратимы и цвета не несут.
  "state-confirm": { class: "screen", nav: "confirm" },
  // Отмена сходки и отметка «состоялась»: в план сходка не возвращается.
  "state-final-confirm": {
    class: "screen",
    nav: "confirm",
    irreversible: true,
  },
  "past-date-confirm": { class: "screen", nav: "confirm" },
  // Подтверждение публикации и, у кнопки без версии, кадр её конфликта.
  "publish-confirm": { class: "screen", nav: "confirm" },
  "material-confirm": { class: "screen", nav: "confirm" },
  "material-remove-confirm": {
    class: "screen",
    nav: "confirm",
    irreversible: true,
  },
  "broadcast-confirm": { class: "screen", nav: "confirm", irreversible: true },
  "community-close-confirm": {
    class: "screen",
    nav: "confirm",
    irreversible: true,
  },
  "reconsider-confirm": { class: "screen", nav: "confirm" },
  "application-decline-confirm": {
    class: "screen",
    nav: "confirm",
    irreversible: true,
  },
  "broadcast-result": { class: "screen", nav: "exit" },
  question: { class: "question", nav: "question" },
  // Выбор даты кнопками: экран, а не вопрос. Режима ответа у него нет, поэтому
  // выбор кнопкой ничего за собой не оставляет, а сам экран правится на месте.
  "date-presets": { class: "screen", nav: "choice" },
  refusal: { class: "screen", nav: "exit" },
  // Исход действия — свой экран (PER-472): исход в заголовке, предмет в
  // кавычках, выход — возврат туда, где действие сделано; у
  // непринятого ответа над ними — «Ввести заново», у подписки на сходку —
  // «Настроить уведомления».
  outcome: { class: "screen", nav: "exit" },
  "no-access": { class: "screen", nav: "none" },
  notification: { class: "trace", nav: "free" },
  "access-opened": { class: "trace", nav: "free" },
} as const;

export type ScreenId = keyof typeof screenCatalog;

/** Списки, в которых может стоять сходка: родитель карточки — один из них. */
export const meetupLists = ["meetups", "archive", "hidden"] as const;

/** Куда возвращает лента лотов: к сходке либо, если она неизвестна, в «Сходки». */
export const auctionFeedParents = ["card", "meetups"] as const;

/** Родитель пункта управления: группа либо само «Управление». */
export const manageParents = {
  [manageMeetupsParent]: ["manage-meetups", "manage"],
  [manageApplicationsParent]: ["manage-applications", "manage"],
  [manageMembersParent]: ["manage-members", "manage"],
} as const;
