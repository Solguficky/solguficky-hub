// Каталог экранов бота — данные дизайн-кода (docs/design/bot/design-code.md).
// Каждый вызов Bot API, который несёт клавиатуру, называет свою запись, и по
// ней линтер test kit проверяет экран. Правила живут здесь, а не в ревью.
//
// Форма записи и сам линтер — линтер test kit `testkit/lint/`.
// Сборка бота его не видит, поэтому `satisfies` здесь нет: форму каталога
// проверяет test kit, когда отдаёт его линтеру (`testkit/screen-lint.ts`).

export const meetupListParent = "meetup-list";

/**
 * Родитель корня аукциона: меню «Расширения» сходки, у которой идёт аукцион.
 * После рестарта бот сходку может не знать — тогда корень возвращает в
 * «Сходки» (ADR-030, дополнение 2026-10-04; PER-605).
 */
export const auctionRootParent = "auction-root-parent";

/**
 * Родители пунктов «Управления»: группа пункта, а у человека с одной группой —
 * само «Управление», которое сразу показывает её пункты (решение владельца
 * 10 октября 2026 года).
 */
export const manageMeetupsParent = "manage-meetups-parent";
export const manageApplicationsParent = "manage-applications-parent";
export const manageMembersParent = "manage-members-parent";

// Корень один — «Меню», общий родитель разделов «Сходки», «Настройки»,
// «Помощь» и «Управление»: команды кнопки меню клиента открывают раздел сразу,
// а «‹ Меню» с раздела ведёт в корень (PER-592; пересматривает решение
// владельца 10 октября 2026 года). Что цепочка родителей каждого экрана
// доходит до корня, держит проверка графа `inspectCatalog` test kit.
export const screenCatalog = {
  menu: {
    class: "screen",
    nav: "root",
    title: "Меню",
    backName: "Меню",
  },
  meetups: {
    class: "screen",
    nav: "tree",
    title: "Сходки",
    parent: "menu",
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
    nav: "tree",
    title: "Настройки",
    parent: "menu",
    backName: "Настройки",
  },
  "notify-global": {
    class: "screen",
    nav: "tree",
    title: "Уведомления",
    parent: "settings",
    backName: "Уведомления",
  },
  // Расширения в «Настройках» (PER-605; ADR-064, дополнение 2026-10-12):
  // только список расширений, у каждого — свои настройки за его пунктом (№74).
  "settings-extensions": {
    class: "screen",
    nav: "tree",
    title: "Расширения",
    parent: "settings",
    backName: "Расширения",
  },
  // Настройки расширения «Аукцион» (№74): «Уведомления» и «Имя в аукционе».
  "settings-auction": {
    class: "screen",
    nav: "tree",
    title: "Аукцион",
    parent: "settings-extensions",
    backName: "Аукцион",
  },
  // Уведомления аукциона (PER-552, PER-645): по кнопке-переключателю на
  // настройку, как у бота аукциона, — под «Аукционом» «Расширений» настроек,
  // а не под «Уведомлениями».
  "notify-outbid": {
    class: "screen",
    nav: "tree",
    title: "Уведомления",
    parent: "settings-auction",
  },
  // Те же настройки, открытые «Частотой уведомлений» под вестью (№73 прогона
  // 14 октября 2026 года): человек пришёл из вести, а не из «Настроек», и
  // возврата в дерево у экрана нет — весть с «К лоту» остаётся выше в чате.
  "notify-outbid-notice": {
    class: "screen",
    nav: "free",
    title: "Уведомления",
  },
  // Имя в идущем аукционе (PER-595): тело аукционного дерева, общее с ботом
  // аукциона; вход и возврат — «Аукцион» «Расширений» настроек. Вопрос
  // псевдонима и непринятый ответ — общие записи `question` и `answer-refused`.
  "name-settings": {
    class: "screen",
    nav: "tree",
    title: "Имя в аукционе",
    parent: "settings-auction",
    backName: "Имя в аукционе",
  },
  help: {
    class: "screen",
    nav: "tree",
    title: "Помощь",
    parent: "menu",
    backName: "Помощь",
  },
  "whats-new": {
    class: "screen",
    nav: "tree",
    title: "Что нового",
    parent: "help",
    backName: "Что нового",
  },
  // «События» (PER-669): идущие события расширений сходок — сегодня аукцион
  // от онлайн-торгов до конца финала. Кнопка в меню — пока событие идёт,
  // команда `/events` — всегда; корень аукциона из него возвращает сюда.
  events: {
    class: "screen",
    nav: "tree",
    title: "События",
    parent: "menu",
    backName: "События",
  },
  manage: {
    class: "screen",
    nav: "tree",
    title: "Управление",
    parent: "menu",
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
  },
  // Держатели наборов admin и maintainer (PER-521): пункт группы «Участники»,
  // который видит держатель права назначать администраторов.
  administrators: {
    class: "screen",
    nav: "tree",
    title: "Администраторы",
    parent: manageMembersParent,
    backName: "Администраторы",
    refresh: true,
  },
  // Карточка человека состава (PER-547): круг, модерация и ведение аукциона
  // (PER-654), закрытие доступа.
  "community-member": {
    class: "screen",
    nav: "tree",
    title: "Карточка человека",
    parent: "community",
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
  // Подменю сходки (PER-644): заголовок — имя подменю, название сходки —
  // строкой ниже курсивом.
  edit: {
    class: "screen",
    nav: "tree",
    title: "Изменить",
    subject: true,
    parent: "card",
  },
  status: {
    class: "screen",
    nav: "tree",
    title: "Статус",
    subject: true,
    parent: "card",
  },
  materials: {
    class: "screen",
    nav: "tree",
    title: "Материалы",
    subject: true,
    parent: "card",
    backName: "Материалы",
  },
  // Меню «Расширения» сходки (PER-605): включённый аукцион открывает свой
  // корень, держателю права управлять сходкой у невключённого — «Включить
  // аукцион».
  extensions: {
    class: "screen",
    nav: "tree",
    title: "Расширения",
    subject: true,
    parent: "card",
    backName: "Расширения",
  },
  // Корень аукциона (PER-605): тело — аукционное дерево, оболочка — хаб.
  // Стадия и сроки, «Лоты», «Розыгрыш», «Избранное» и правила, «🛠 Пульт»
  // своим рядом (PER-669).
  "auction-root": {
    class: "screen",
    nav: "tree",
    title: "Аукцион",
    parent: auctionRootParent,
    backName: "Аукцион",
  },
  // Аукцион сходки (PER-307): лента — просто список лотов (PER-605).
  lots: {
    class: "screen",
    nav: "tree",
    title: "Лоты",
    parent: "auction-root",
    backName: "Лоты",
  },
  // Прогнозы участника — тело общего аукционного дерева (ADR-067), вход из
  // корня аукциона и возврат туда же (PER-644).
  "prediction-results": {
    class: "screen",
    nav: "tree",
    title: "Итоги прогнозов",
    parent: "auction-root",
    backName: "Итоги",
  },
  // Хроники дня (PER-725) — тело общего аукционного дерева: вход из корня
  // аукциона во время онлайн-недели и возврат туда же.
  "day-chronicle": {
    class: "screen",
    nav: "tree",
    title: "Хроники дня",
    parent: "auction-root",
    backName: "Хроники дня",
  },
  predictions: {
    class: "screen",
    nav: "tree",
    title: "Прогнозы аукциона",
    parent: "auction-root",
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
  "prediction-number-question": {
    class: "question",
    nav: "question",
  },
  "prediction-alias-question": {
    class: "question",
    nav: "question",
  },
  "prediction-answer-refused": {
    class: "screen",
    nav: "exit",
  },
  "auction-faq": {
    class: "screen",
    nav: "tree",
    title: "Правила и FAQ",
    parent: "auction-root",
  },
  // Заголовок карточки лота — его название. «🔄 Обновить» тело ставит, пока у
  // лота нет итога: цена и лидер меняются без участия человека. Ряды
  // складываются по смыслу (PER-594, PER-644, PER-669): ставка по шагу, своя
  // сумма с автоставкой, «Ставки» с избранным (PER-495), «Лоты сета»
  // (ADR-073, п. 7), «🛠 Изменить лот» администратора своим рядом, листание
  // `[◀️][🔄 Обновить][▶️]` и навигация — семь, у участника шесть.
  lot: {
    class: "screen",
    nav: "tree",
    parent: "lots",
    backName: "Лот",
    refresh: true,
    maxRows: 7,
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
  // Избранное (PER-495): тело — аукционное дерево, оболочка — хаб. Открывается
  // из корня аукциона рядом с «Правила и FAQ» и возвращает в него (PER-605).
  favorites: {
    class: "screen",
    nav: "tree",
    title: "Избранное",
    parent: "auction-root",
  },
  // Notifications ещё не знает лот — кадр исхода с «‹ Лот».
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
    backName: "Изменить лот",
  },
  // Выбор способа шага (PER-491): цена принята, спрашивается один шаг или
  // пороги. Родитель — форма лота, возврат в неё.
  "lot-step-mode": {
    class: "screen",
    nav: "tree",
    title: "Шаг ставки",
    parent: "lot-form",
    backName: "Шаг ставки",
  },
  // Фото лота (PER-721): список до десяти, «Добавить фото» и «Убрать фото N».
  // Родитель — форма лота, возврат в неё.
  "lot-photos": {
    class: "screen",
    nav: "tree",
    title: "Фото лота",
    parent: "lot-form",
    backName: "Фото лота",
    subject: true,
  },
  // Снятие фото лота (PER-715): фото бот вернуть не может, поэтому «Да»
  // красное, как у «Убрать материал».
  "lot-image-remove-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Убрать фото?",
    irreversible: true,
  },
  // Поле лота в сете (PER-716): только этот лот или все лоты сета. Пара
  // выбора одним рядом, возврат — в форму лота.
  "lot-scope": {
    class: "screen",
    nav: "tree",
    title: "Какие лоты изменить?",
    parent: "lot-form",
  },
  // Удаление лота (PER-716): вернуть лот бот не умеет, поэтому «Да» красное.
  "lot-remove-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Удалить лот?",
    irreversible: true,
  },
  // Лот глазами участника (PER-512): карточка лота той же вёрсткой, без кнопок
  // и с пометкой предпросмотра. Заголовок — название лота, как у карточки.
  "lot-preview": {
    class: "screen",
    nav: "tree",
    parent: "lot-form",
  },
  // Пульт аукциона администратора (PER-320): экран хаба, а не тело пакета.
  // Открывается из корня аукциона (PER-605). В финале он же —
  // пульт ведущего (PER-337): цену и ставки лота двигает зал, поэтому у
  // экрана «Обновить».
  "auction-console": {
    class: "screen",
    nav: "tree",
    title: "Пульт",
    parent: "auction-root",
    backName: "Пульт",
    refresh: true,
    // Пульт — экран администратора, и он набит: сроки, видимость, финал,
    // время финала, счастливые часы, розыгрыш, приз, снятия и открытие
    // недели. Общий потолок в двенадцать рядов ему тесен (PER-663), поэтому
    // у него свой — тринадцать.
    maxRows: 13,
  },
  // «Сводка дня торгов» (PER-492): текст за сутки со ссылками на лоты в боте
  // аукциона. Публикует его организатор — бот в группу не пишет.
  "day-summary": {
    class: "screen",
    nav: "tree",
    title: "Сводка дня",
    parent: "auction-console",
  },
  // Счета проданных лотов (PER-321): итог собранного и ожидаемого, строка на
  // счёт и кнопка на счёт. Открываются с пульта, как только лоты продаются.
  invoices: {
    class: "screen",
    nav: "tree",
    title: "Счета",
    parent: "auction-console",
    backName: "Счета",
  },
  // Счёт: предмет — название лота, одна кнопка следующей отметки.
  invoice: {
    class: "screen",
    nav: "tree",
    title: "Счёт",
    subject: true,
    parent: "invoices",
    backName: "Счёт",
  },
  // Отметку оплаты или выдачи снять нельзя: подтверждение с красным «Да».
  // Заголовок — вопрос «Отметить оплату?» или «Отметить выдачу?», линтер
  // сверяет его по началу.
  "invoice-mark-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Отметить",
    irreversible: true,
  },
  // Итог розыгрыша вручную (PER-727): список билетов для колеса на внешнем
  // сайте и «Ввести победителя». Открывается с пульта, пока пул ждёт итога.
  "raffle-winner": {
    class: "screen",
    nav: "tree",
    title: "Итог розыгрыша",
    parent: "auction-console",
  },
  // Итог не меняется, и участники сразу получают весть: «Да» красное.
  "raffle-winner-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Назначить победителя?",
    irreversible: true,
  },
  // Смена приза идущего розыгрыша (PER-737): «было → станет». Приз меняется
  // снова до итога, участникам вести нет — «Да» не красное.
  "raffle-prize-change-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Изменить приз?",
  },
  // «Счастливые часы» (PER-504): окна сниженного шага онлайн-недели.
  // Открываются с пульта, пока неделя не открыта, а после — только для
  // просмотра.
  "step-windows": {
    class: "screen",
    nav: "tree",
    title: "Счастливые часы",
    parent: "auction-console",
    backName: "Счастливые часы",
  },
  // Окно: сроки, шаг и лоты реестра переключателями. Заголовок — «Окно N»,
  // линтер сверяет его по началу.
  "step-window": {
    class: "screen",
    nav: "tree",
    title: "Окно",
    parent: "step-windows",
  },
  // Запуск окна по ходу торгов (PER-615): сроки и шаг запускаемого окна, лоты
  // реестра переключателями и ряд запуска.
  "step-window-launch": {
    class: "screen",
    nav: "tree",
    title: "Запуск окна",
    parent: "step-windows",
  },
  // Сеты лотов (ADR-073, PER-509): вход «🛠 Сеты» корня аукциона. Сеты
  // меняются, пока неделя не открыта, а после — только для просмотра.
  "lot-sets": {
    class: "screen",
    nav: "tree",
    title: "Сеты",
    parent: "auction-root",
    backName: "Сеты",
  },
  // Сет: число лотов и лоты реестра переключателями. Заголовок — «Сет
  // «Название»», линтер сверяет его по началу.
  "lot-set": {
    class: "screen",
    nav: "tree",
    title: "Сет",
    parent: "lot-sets",
  },
  // Удаление сета: сет задаётся заново, поэтому «Да» без красного.
  "lot-set-delete-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Удалить сет?",
  },
  // Открытие онлайн-недели: отменить его нельзя, поэтому — подтверждение с
  // красным «Да» (решение владельца 10 октября 2026 года).
  "week-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Онлайн-неделя",
    irreversible: true,
  },
  // «Ставки зала» помощника ведущего (PER-565, ADR-070 пп. 4–6): вход — из
  // корня аукциона рядом с «Пультом». Люди зала стоят по два в ряд — это
  // содержимое экрана, а не пара действий (дизайн-код, «Ставки зала»); цену
  // двигает зал, поэтому у экрана «Обновить». Найденные по имени — ответ на
  // «Другой человек…» с возвратом в экран.
  "floor-bids": {
    class: "screen",
    nav: "tree",
    title: "Ставки зала",
    parent: "auction-root",
    backName: "Ставки зала",
    refresh: true,
    pairedContent: true,
  },
  "floor-found": {
    class: "screen",
    nav: "tree",
    title: "Ставки зала",
    parent: "floor-bids",
    pairedContent: true,
  },
  // Ставка зала за другого человека необратима: подтверждение с красным
  // «Да». Заголовок — вопрос с именем и ценой, линтер сверяет его по началу.
  "floor-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Ставка зала",
    irreversible: true,
  },
  // Снятие участника с лота (PER-659, ADR-072): вход — ряд «Снять участника»
  // на «Ставках» лота у держателя права вести аукцион. Люди — по два в ряд,
  // это содержимое экрана, а не пара действий; предмет — название лота.
  "removal-people": {
    class: "screen",
    nav: "tree",
    title: "Снять участника",
    subject: true,
    parent: "bids",
    pairedContent: true,
  },
  // Снятие необратимо: подтверждение с красным «Да». Заголовок — вопрос с
  // именем, линтер сверяет его по началу.
  "removal-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Снять",
    irreversible: true,
  },
  // Закрытие лота финала ведущим (PER-337): продажа необратима, поэтому —
  // подтверждение с красным «Да». Заголовок — вопрос с названием лота,
  // линтер сверяет его по началу.
  "final-close-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Закрыть лот",
    irreversible: true,
  },
  // Выбор порядка состава финала в перерыве (PER-619): администратор
  // называет лоты по одному, выбранное едет в кнопках.
  "lineup-order": {
    class: "screen",
    nav: "tree",
    title: "Порядок финала",
    parent: "auction-console",
  },
  // Объявление состава финала: после него состав и порядок не меняются,
  // поэтому — подтверждение с красным «Да».
  "lineup-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Объявить состав финала?",
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
  // Отмена аукциона после старта торгов (ADR-047, дополнение 2026-10-12):
  // нового аукциона у сходки не будет, поэтому — красное «Да».
  "cancel-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Отменить аукцион?",
    irreversible: true,
  },
  // Хронология ставок лота (PER-309): тело — аукционное дерево, оболочка — хаб.
  bids: {
    class: "screen",
    nav: "tree",
    title: "Ставки",
    subject: true,
    parent: "lot",
    backName: "Ставки",
  },
  // Лист ставки (PER-317): тело — аукционное дерево, тексты — оболочка хаба.
  // Подтверждение — без ряда навигации, выбор имени — под карточкой лота.
  // Ставка и автоставка — траты денег: их «Да» красное (PER-473). Принятая
  // команда — кадр исхода с «‹ Лот» и «‹ Лоты» (PER-595). Заголовок
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
  // Розыгрыш среди участников (ADR-066): тело — аукционное дерево, вход —
  // «Розыгрыш» в корне аукциона, у администратора парой к «Пульту». Выбор имени
  // перед регистрацией возвращает в розыгрыш; вопрос псевдонима и непринятый
  // ответ — общие записи `question` и `answer-refused`.
  raffle: {
    class: "screen",
    nav: "tree",
    title: "Розыгрыш среди участников",
    parent: "auction-root",
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
  // Счета победителя (PER-322): тело аукционного дерева, общее с ботом
  // аукциона. Вход — «Мои счета» в корне аукциона, пока у смотрящего есть
  // счета; счёт — лист списка с выбором способа получения, заголовок называет
  // лот, и линтер сверяет его по началу.
  "my-invoices": {
    class: "screen",
    nav: "tree",
    title: "Мои счета",
    parent: "auction-root",
    backName: "Счета",
  },
  "my-invoice": {
    class: "screen",
    nav: "tree",
    title: "Счёт",
    parent: "my-invoices",
  },
  "my-invoice-missing": {
    class: "screen",
    nav: "exit",
    title: "Счёт не найден",
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
  // Понижение до гостя (PER-642): «✔️» цвета, потому что из карточки человека
  // участника не вернуть, а о смене круга уходит весть.
  "community-demote-confirm": {
    class: "screen",
    nav: "confirm",
    irreversible: true,
  },
  "reconsider-confirm": { class: "screen", nav: "confirm" },
  // Назначение уведомляет человека, снятие подтверждает задача (PER-521);
  // оба обратимы, поэтому «Да» цвета не несёт.
  "administrator-appoint-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Назначить администратором?",
  },
  "administrator-dismiss-confirm": {
    class: "screen",
    nav: "confirm",
    title: "Снять администратора?",
  },
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
  // Исход действия — свой экран (PER-472): исход в заголовке, предмет
  // жирным, выход — возврат туда, где действие сделано; у
  // непринятого ответа над ними — «Ввести заново», у подписки на сходку —
  // «Настроить уведомления».
  outcome: { class: "screen", nav: "exit" },
  "no-access": { class: "screen", nav: "none" },
  // Кадр ожидания допуска, когда адрес бота поддержки задан (PER-625,
  // ADR-068): одна кнопка-ссылка «Написать в поддержку ↗», навигации нет.
  "no-access-support": { class: "screen", nav: "links" },
  // Приветствие человека без права хаба (PER-592, дополнение ADR-060): заявку
  // ставит только его кнопка «Подать заявку». Заголовка нет — первое
  // предложение жирным, как у кадра отказа.
  welcome: { class: "screen", nav: "apply" },
  // Подсказка на сообщение вне вопроса (PER-592): кадр исхода с «‹ Меню».
  hint: { class: "screen", nav: "exit" },
  notification: { class: "trace", nav: "free" },
  // Файл материала (PER-644): подпись — название без разметки, под ним одна
  // кнопка «‹ Материалы».
  "material-file": { class: "trace", nav: "tree", parent: "materials" },
  "access-opened": { class: "trace", nav: "free" },
} as const;

export type ScreenId = keyof typeof screenCatalog;

/** Списки, в которых может стоять сходка: родитель карточки — один из них. */
export const meetupLists = ["meetups", "archive", "hidden"] as const;

/**
 * Куда возвращает корень аукциона: по входу (PER-669) — в «События», если
 * аукцион открыт оттуда, иначе в меню «Расширения» сходки, а если она
 * неизвестна, в «Сходки».
 */
export const auctionRootParents = ["extensions", "events", "meetups"] as const;

/** Родитель пункта управления: группа либо само «Управление». */
export const manageParents = {
  [manageMeetupsParent]: ["manage-meetups", "manage"],
  [manageApplicationsParent]: ["manage-applications", "manage"],
  [manageMembersParent]: ["manage-members", "manage"],
} as const;
