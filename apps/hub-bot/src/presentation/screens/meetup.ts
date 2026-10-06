import { encodeAuctionCallback } from "@solguficky/auction-bot-ui";
import { InlineKeyboard } from "grammy";
import type {
  MeetupAuctionView,
  MeetupAuthor,
  MeetupStateAction,
} from "../../application/types.js";
import { type CommunityDay, isBeforeDay } from "../../community-time.js";
import type {
  ArchivedMeetupSummary,
  MeetupMaterial,
  MeetupSnapshot,
  MeetupSummary,
} from "../../meetups/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  buttonText,
  confirmKeyboard,
  dayLabel,
  escapeHtml,
  heading,
  nextRow,
  type Page,
  type Parent,
  pagedTitle,
  pageSize,
  paginate,
  readableDay,
  readableMoment,
  screenText,
  toArchive,
  toCard,
  toHidden,
  toManage,
  toMenu,
  toUpcoming,
  withNav,
  withPager,
} from "./kit.js";
import type { ScreenPhoto, ShownScreen } from "./show.js";

// Экраны сходки: списки, карточка и её подэкраны. Каждая функция — чистый
// сборщик: по данным возвращает экран, который отправит единый отправитель.

/** Сколько материалов карточка перечисляет сама; остальное — в «Материалах». */
const materialCardLimit = 20;
const materialDisplayTitleLimit = 80;

// Черновик получает название вторым шагом формы, и брошенный на первом вопросе
// остаётся с пустым: Telegram не принимает кнопку без текста, а строка списка
// и карточка без подписи не читаются.
export function meetupTitleLabel(title: string): string {
  return title.trim() === "" ? "Без названия" : title;
}

/**
 * Родитель карточки — список, в котором сходка стоит сейчас, а не путь, которым
 * человек пришёл. Отменённая, состоявшаяся и прошедшая — в архиве, и скрытость
 * здесь ничего не меняет; скрытая из остальных — в «Скрытых».
 */
export function meetupParent(
  meetup: Pick<MeetupSnapshot, "lifecycle" | "visibility" | "schedule">,
  today: CommunityDay,
): Parent {
  const past =
    meetup.schedule !== undefined && isBeforeDay(meetup.schedule, today);
  if (meetup.lifecycle !== "planned" || past) return toArchive;
  return meetup.visibility === "hidden" ? toHidden : toUpcoming;
}

function meetupButton(
  meetup: MeetupSummary,
  today: CommunityDay,
): [text: string, data: string] {
  const title = meetupTitleLabel(meetup.title);
  return [
    buttonText(
      meetup.schedule === undefined
        ? title
        : `${dayLabel(meetup.schedule, today)} · ${title}`,
    ),
    `v1:view:${uuidToToken(meetup.id)}`,
  ];
}

function listLine(
  meetup: MeetupSummary,
  today: CommunityDay,
  mark?: string,
): string {
  const title = escapeHtml(meetupTitleLabel(meetup.title));
  const tail = mark === undefined ? "" : ` (${mark})`;
  return meetup.schedule === undefined
    ? `• ${title}${tail}`
    : `• ${readableDay(meetup.schedule, today)} — ${title}${tail}`;
}

function listKeyboard(
  page: Page<MeetupSummary>,
  today: CommunityDay,
  pager: (page: number) => string,
  parent: Parent,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const meetup of page.items) {
    keyboard.text(...meetupButton(meetup, today)).row();
  }
  return withNav(withPager(keyboard, page, pager), parent);
}

export function upcomingScreen(
  meetups: readonly MeetupSummary[],
  requestedPage: number,
  today: CommunityDay,
): ShownScreen {
  const title = "Ближайшие сходки";
  // Сходки с датой идут первыми, и страница режется по этому порядку: секции
  // на странице называют только то, что на ней есть.
  const ordered = [
    ...meetups.filter((meetup) => meetup.schedule !== undefined),
    ...meetups.filter((meetup) => meetup.schedule === undefined),
  ];
  const page = paginate(ordered, requestedPage);
  // Скрытую сходку видят только автор и администратор (ADR-022); без пометки
  // она читалась бы в общем списке как опубликованная.
  const lines = (dated: boolean) =>
    page.items
      .filter((meetup) => (meetup.schedule !== undefined) === dated)
      .map((meetup) =>
        listLine(
          meetup,
          today,
          meetup.visibility === "hidden" ? "скрыта" : undefined,
        ),
      );
  const section = (name: string, rows: readonly string[]) =>
    rows.length === 0 ? undefined : `${name}\n${rows.join("\n")}`;
  return {
    id: "upcoming",
    text:
      meetups.length === 0
        ? screenText(
            title,
            "Пока ни одной запланированной сходки нет.",
            "Когда организатор создаст новую, она появится здесь.",
          )
        : screenText(
            pagedTitle(title, page),
            section("С датой", lines(true)),
            section("Без даты", lines(false)),
          ),
    keyboard: listKeyboard(page, today, (to) => `v1:nav:hub:${to}`, toMenu),
    format: "HTML",
  };
}

const archiveStatusLabels: Record<ArchivedMeetupSummary["status"], string> = {
  held: "состоялась",
  cancelled: "отменена",
  past: "прошла",
};

// Порядок задаёт Meetups (ListArchivedMeetups: новейшая дата первой, без даты —
// последними), поэтому архив не группируется и не пересортировывается.
export function archiveScreen(
  meetups: readonly ArchivedMeetupSummary[],
  requestedPage: number,
  today: CommunityDay,
): ShownScreen {
  const title = "Архив";
  const page = paginate(meetups, requestedPage);
  return {
    id: "archive",
    text:
      meetups.length === 0
        ? screenText(
            title,
            "Архив пока пуст.",
            "Сюда попадают отменённые, состоявшиеся и прошедшие сходки.",
          )
        : screenText(
            pagedTitle(title, page),
            page.items
              .map((meetup) =>
                listLine(meetup, today, archiveStatusLabels[meetup.status]),
              )
              .join("\n"),
          ),
    keyboard: listKeyboard(page, today, (to) => `v1:nav:archive:${to}`, toMenu),
    format: "HTML",
  };
}

// Незаконченный черновик и снятая с публикации сходка в контракте не
// различаются, поэтому раздел говорит о скрытых, а не о черновиках.
export function hiddenScreen(
  meetups: readonly MeetupSummary[],
  requestedPage: number,
  today: CommunityDay,
): ShownScreen {
  const title = "Скрытые сходки";
  const hidden = meetups.filter((meetup) => meetup.visibility === "hidden");
  const page = paginate(hidden, requestedPage);
  return {
    id: "hidden",
    text:
      hidden.length === 0
        ? screenText(
            title,
            "Скрытых сходок нет.",
            "Здесь появляются черновики и сходки, снятые с публикации.",
          )
        : screenText(
            pagedTitle(title, page),
            page.items.map((meetup) => listLine(meetup, today)).join("\n"),
          ),
    keyboard: listKeyboard(
      page,
      today,
      (to) => `v1:manage:hidden:${to}`,
      toManage,
    ),
    format: "HTML",
  };
}

export function materialTitle(material: MeetupMaterial, index: number): string {
  const title = material.title.trim();
  return title === "" ? `Материал ${index}` : title;
}

function displayMaterialTitle(material: MeetupMaterial, index: number): string {
  const title = materialTitle(material, index);
  return title.length <= materialDisplayTitleLimit
    ? title
    : `${title.slice(0, materialDisplayTitleLimit - 1)}…`;
}

/**
 * Строки карточки без заголовка и материалов: статус, автор, когда, где и
 * описание. Текст уже экранирован.
 */
function cardLines(
  meetup: MeetupSnapshot,
  author: MeetupAuthor | undefined,
  today: CommunityDay,
): string[] {
  const lifecycle =
    meetup.lifecycle === "cancelled"
      ? "отменена"
      : meetup.lifecycle === "held"
        ? "состоялась"
        : "запланирована";
  const visibility = meetup.visibility === "hidden" ? "скрыта" : "видна";
  return [
    `Статус: ${lifecycle}, ${visibility}`,
    // Назначенный момент стоит сразу под статусом: «скрыта» без него читается
    // как «черновик забыт», а с ним — как «ждёт публикации».
    ...(meetup.publishAt === undefined
      ? []
      : [`Публикация назначена на ${readableMoment(meetup.publishAt, today)}`]),
    // Автор стоит под статусом и только тогда, когда его есть чем назвать:
    // нет ника или Identity не ответил — строки нет, без заглушки (PER-404).
    ...(author === undefined
      ? []
      : [
          author.kind === "self"
            ? "Ты автор этой сходки"
            : `Автор: @${escapeHtml(author.telegramUsername)}`,
        ]),
    "",
    `Когда: ${meetup.schedule === undefined ? "дата не задана" : readableMoment(meetup.schedule, today)}`,
    `Где: ${meetup.venue === "" ? "не указано" : escapeHtml(meetup.venue)}`,
    "",
    meetup.description === ""
      ? "Описание пока не добавлено."
      : escapeHtml(meetup.description),
  ];
}

function materialLines(meetup: MeetupSnapshot): string[] {
  if (meetup.materials.length === 0) return [];
  const hidden = meetup.materials.length - materialCardLimit;
  return [
    "",
    "Материалы:",
    ...meetup.materials.slice(0, materialCardLimit).map((material, index) => {
      const label = escapeHtml(displayMaterialTitle(material, index + 1));
      return material.source.kind === "message-link"
        ? `${index + 1}. <a href="${escapeHtml(material.source.url)}">${label}</a>`
        : `${index + 1}. ${label} (файл)`;
    }),
    ...(hidden > 0 ? [`…и ещё ${hidden}. Открой раздел «Материалы».`] : []),
  ];
}

// Постеры карточки (дизайн-код, «Карточка сходки»): материалы-фото в порядке
// коллекции. Потолок держит карточку обозримой; остальные открываются из
// «Материалов».
const posterLimit = 10;

function posters(meetup: MeetupSnapshot): ScreenPhoto[] {
  return meetup.materials
    .flatMap((material) =>
      material.source.kind === "file" && material.source.fileKind === "photo"
        ? [material.source.fileId]
        : [],
    )
    .slice(0, posterLimit)
    .map((fileId, index) => ({ id: `p${index + 1}`, fileId }));
}

// Один постер стоит фотографией, несколько — каруселью: у карусели из одного
// кадра листать нечего.
function posterBlock(photos: readonly ScreenPhoto[]): string | undefined {
  const images = photos.map(
    (photo) => `<img src="tg://photo?id=${photo.id}"/>`,
  );
  if (images.length === 0) return undefined;
  return images.length === 1
    ? images[0]
    : `<tg-slideshow>${images.join("")}</tg-slideshow>`;
}

function auctionButton(
  auction: MeetupAuctionView | undefined,
  editable: boolean,
  token: string,
): { label: string; data: string } | undefined {
  if (auction?.kind === "open") {
    return {
      label: "Лоты",
      data: encodeAuctionCallback({
        kind: "feed",
        auctionId: auction.auctionId,
        page: 0,
      }),
    };
  }
  if (auction?.kind === "none" && editable) {
    return { label: "Включить аукцион", data: `v1:manage:auction:${token}` };
  }
  return undefined;
}

export type CardView = {
  meetup: MeetupSnapshot;
  author?: MeetupAuthor | undefined;
  /** Нет — Notifications не ответил, и состояние подписки не показывается. */
  subscribed?: boolean | undefined;
  /** Смотрящий управляет сходкой: видны правка, статус и рассылка. */
  manageable: boolean;
  /** Нет — Auction не ответил, и ряда аукциона на карточке нет. */
  auction?: MeetupAuctionView | undefined;
  /** Ответ на действие человека: стоит первой строкой, над заголовком. */
  note?: string | undefined;
  presentation: "rich" | "plain";
  today: CommunityDay;
  /**
   * `false` — карточка без постеров: так она приходит повторно, когда Telegram
   * не принял сообщение с фото, например файл больше недоступен.
   */
  posters?: boolean;
};

// Без подписки карточка объясняет, что она даёт: кнопка настроек сходки
// появляется только после подписки, и иначе связь между ними не видна.
const unsubscribedHint =
  "Подпишись, чтобы получать изменения, материалы и сообщения организатора этой сходки.";

/**
 * Карточка сходки. Под ней не больше пяти рядов: правка и статус, материалы,
 * рассылка, подписка с её настройками и возврат. Файлы открываются из
 * «Материалов», а «Отметить состоявшейся» живёт в «Статусе».
 */
export function cardScreen(view: CardView): ShownScreen {
  const { meetup, manageable, note, presentation, today } = view;
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard();
  const editable = manageable && meetup.lifecycle !== "cancelled";
  if (editable) {
    keyboard
      .text("Изменить", `v1:manage:edit:${token}`)
      .text("Статус", `v1:manage:status:${token}`)
      .row();
  }
  if (editable || meetup.materials.length > 0) {
    keyboard.text(
      `Материалы (${meetup.materials.length})`,
      `v1:mm:list:${token}`,
    );
  }
  // Аукцион сходки стоит в ряду материалов: оба — содержимое сходки, и
  // отдельным рядом он вывел бы карточку организатора за пять рядов. Вход —
  // всем, у кого аукцион есть; включение — организатору, пока аукциона нет и
  // сходка не отменена. Auction не ответил — ряда аукциона нет вовсе.
  const auction = auctionButton(view.auction, editable, token);
  if (auction !== undefined) {
    keyboard.text(auction.label, auction.data);
  }
  nextRow(keyboard);
  // Написать подписчикам можно и об отменённой сходке: сообщить им об отмене
  // — законный повод, и Notifications жизненный цикл при рассылке не фильтрует.
  if (manageable) {
    keyboard.text("Написать подписчикам", `v1:bc:m:${token}`).row();
  }
  // Кнопка подписки рисуется только тогда, когда Notifications ответил:
  // состояние на ней — факт, а не заглушка. Настройки сходки решают, что
  // присылать по подписке, поэтому без подписки их входа нет. Когда
  // Notifications не ответил, вход остаётся: иначе один моргнувший ответ
  // отрезает экран целиком.
  if (view.subscribed === false) {
    keyboard.text("Подписаться на сходку", `v1:notify:sub:${token}:1`).row();
  } else {
    if (view.subscribed === true) {
      keyboard.text("Отписаться", `v1:notify:sub:${token}:0`);
    }
    keyboard.text("Уведомления сходки", `v1:notify:settings:${token}`).row();
  }
  const title = escapeHtml(meetupTitleLabel(meetup.title));
  const body = [
    ...cardLines(meetup, view.author, today),
    ...materialLines(meetup),
  ];
  // Подсказка о подписке стоит под карточкой и уступает место заметке: вместе
  // они читались бы как два ответа на одно нажатие.
  const hint =
    note === undefined && view.subscribed === false
      ? unsubscribedHint
      : undefined;
  // Постеры — только в богатой карточке: обычное сообщение несёт либо текст,
  // либо файл, и с файлом оно перестало бы правиться на месте.
  const photos =
    presentation === "rich" && view.posters !== false ? posters(meetup) : [];
  return {
    id: "card",
    text: cardText({
      title,
      body,
      note,
      hint,
      presentation,
      posters: posterBlock(photos),
    }),
    keyboard: withNav(keyboard, meetupParent(meetup, today)),
    format: presentation === "rich" ? "rich" : "HTML",
    ...(photos.length === 0 ? {} : { media: photos }),
  };
}

// Текст карточки и черновика: заметка, заголовок с телом, подсказка. Заголовок
// и тело уже экранированы, заметка и подсказка — нет.
function cardText(parts: {
  title: string;
  body: readonly string[];
  note?: string | undefined;
  hint?: string | undefined;
  presentation: "rich" | "plain";
  /** Готовый блок постеров богатой карточки: стоит сразу под её телом. */
  posters?: string | undefined;
}): string {
  const { title, body, presentation } = parts;
  const paragraph = (text: string | undefined) =>
    text === undefined
      ? undefined
      : presentation === "rich"
        ? `<p>${escapeHtml(text)}</p>`
        : escapeHtml(text);
  const card =
    presentation === "rich"
      ? `<h1>${title}</h1><p>${body.join("<br>")}</p>${parts.posters ?? ""}`
      : `<b>${title}</b>\n${body.join("\n")}`;
  return [paragraph(parts.note), card, paragraph(parts.hint)]
    .filter((part) => part !== undefined)
    .join(presentation === "rich" ? "" : "\n\n");
}

/**
 * Черновик формы создания: та же карточка, а под ней — поля и публикация.
 * Заполненное видно всё время, порядок полей человек выбирает сам; выйти можно
 * в любой момент — черновик остаётся в «Скрытых».
 */
export function draftScreen(view: {
  meetup: MeetupSnapshot;
  presentation: "rich" | "plain";
  today: CommunityDay;
}): ShownScreen {
  const { meetup, presentation, today } = view;
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard()
    .text("Дата и время", `v1:manage:draft:${token}:schedule`)
    .row()
    .text("Место", `v1:manage:draft:${token}:venue`)
    .row()
    .text("Описание", `v1:manage:draft:${token}:description`)
    .row()
    .text("Опубликовать", `v1:manage:publish:${token}`)
    .row()
    .text(
      meetup.publishAt === undefined
        ? "Опубликовать позже"
        : "Перенести публикацию",
      // `d` — источник вопроса: «Отмена» под ним вернёт на черновик.
      `v1:manage:publish-later:${token}:d`,
    );
  return {
    id: "draft",
    text: cardText({
      title: escapeHtml(meetupTitleLabel(meetup.title)),
      body: cardLines(meetup, undefined, today),
      presentation,
    }),
    keyboard: withNav(keyboard, toHidden),
    format: presentation === "rich" ? "rich" : "HTML",
  };
}

export function editFieldsScreen(meetup: MeetupSnapshot): ShownScreen {
  const token = uuidToToken(meetup.id);
  return {
    id: "edit",
    text: screenText(
      "Изменить сходку",
      `«${escapeHtml(meetupTitleLabel(meetup.title))}» — что меняем?`,
    ),
    keyboard: withNav(
      new InlineKeyboard()
        .text("Название", `v1:manage:field:${token}:title`)
        .row()
        .text("Дата и время", `v1:manage:field:${token}:schedule`)
        .row()
        .text("Место", `v1:manage:field:${token}:venue`)
        .row()
        .text("Описание", `v1:manage:field:${token}:description`),
      toCard(token),
    ),
    format: "HTML",
  };
}

// Общая форма действий смены состояния: кадр подтверждения и повтор после
// конфликта версий говорят об одном и том же действии одними словами. Цвета у
// них нет: красным красится только трата денег, а необратимость конечной
// стадии называет строка `irreversible` (PER-473).
export const stateActionCopy: Record<
  MeetupStateAction,
  {
    question: string;
    label: string;
    yes: string;
    confirmAction: string;
    irreversible?: string;
  }
> = {
  unpublish: {
    question: "Скрыть сходку из общего списка?",
    label: "Скрыть из списка",
    yes: "Да, скрыть из списка",
    confirmAction: "confirm-unpublish",
  },
  cancel: {
    question: "Отменить сходку?",
    label: "Отменить сходку",
    yes: "Да, отменить сходку",
    confirmAction: "confirm-cancel",
    irreversible: "Отменить нельзя: отменённая сходка в план не возвращается.",
  },
  hold: {
    question: "Отметить сходку состоявшейся?",
    label: "Отметить состоявшейся",
    yes: "Да, отметить состоявшейся",
    confirmAction: "confirm-hold",
    irreversible:
      "Отменить нельзя: состоявшаяся сходка в план не возвращается.",
  },
  unschedule: {
    question: "Отменить отложенную публикацию?",
    label: "Отменить отложенную публикацию",
    yes: "Да, отменить публикацию",
    confirmAction: "confirm-unschedule",
  },
};

export function confirmStateCallback(
  action: MeetupStateAction,
  token: string,
): string {
  return `v1:manage:${stateActionCopy[action].confirmAction}:${token}`;
}

export function statusScreen(
  meetup: MeetupSnapshot,
  author: MeetupAuthor | undefined,
  today: CommunityDay,
): ShownScreen {
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard();
  if (meetup.visibility === "visible") {
    keyboard
      .text(stateActionCopy.unpublish.label, `v1:manage:unpublish:${token}`)
      .row();
  } else {
    keyboard.text("Опубликовать", `v1:manage:republish:${token}`).row();
    // Отложенность — выбор момента внутри публикации, а не отдельный сценарий
    // (ADR-024): кнопка стоит рядом с «Опубликовать», а назначенный момент
    // меняется тем же вопросом.
    keyboard
      .text(
        meetup.publishAt === undefined
          ? "Опубликовать позже"
          : "Перенести публикацию",
        `v1:manage:publish-later:${token}`,
      )
      .row();
    if (meetup.publishAt !== undefined) {
      keyboard
        .text(stateActionCopy.unschedule.label, `v1:manage:unschedule:${token}`)
        .row();
    }
  }
  if (meetup.lifecycle === "planned") {
    keyboard
      .text(stateActionCopy.hold.label, `v1:manage:hold:${token}`)
      .row()
      .text(stateActionCopy.cancel.label, `v1:manage:cancel:${token}`)
      .row();
  }
  return {
    id: "status",
    text: [
      heading("Статус"),
      "",
      escapeHtml(meetupTitleLabel(meetup.title)),
      ...cardLines(meetup, author, today),
    ].join("\n"),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}

/**
 * Подтверждение смены состояния. `note` — почему вопрос задан снова: сходка
 * изменилась, пока человек решал.
 */
export function stateConfirmScreen(confirm: {
  action: MeetupStateAction;
  meetup: Pick<MeetupSnapshot, "id" | "title">;
  /** Куда возвращает «Нет»: экран, с которого подтверждение открыто. */
  back: string;
  note?: string;
}): ShownScreen {
  const copy = stateActionCopy[confirm.action];
  const token = uuidToToken(confirm.meetup.id);
  return {
    id: "state-confirm",
    text: [
      ...(confirm.note === undefined ? [] : [escapeHtml(confirm.note), ""]),
      heading(copy.question),
      "",
      `«${escapeHtml(meetupTitleLabel(confirm.meetup.title))}»`,
      ...(copy.irreversible === undefined ? [] : [copy.irreversible]),
    ].join("\n"),
    keyboard: confirmKeyboard({
      yes: copy.yes,
      yesData: confirmStateCallback(confirm.action, token),
      noData: confirm.back,
    }),
    format: "HTML",
  };
}

export function materialsScreen(
  meetup: MeetupSnapshot,
  canManage: boolean,
  requestedPage: number,
): ShownScreen {
  const token = uuidToToken(meetup.id);
  const page = paginate(meetup.materials, requestedPage);
  const first = page.page * pageSize;
  const keyboard = new InlineKeyboard();
  for (const [index, material] of page.items.entries()) {
    const number = first + index + 1;
    const materialToken = uuidToToken(material.id);
    const title = displayMaterialTitle(material, number);
    if (material.source.kind === "message-link") {
      keyboard.url(buttonText(`${title} ↗`), material.source.url);
    } else {
      keyboard.text(buttonText(title), `v1:mm:file:${token}:${materialToken}`);
    }
    if (canManage) {
      keyboard.text("Убрать", `v1:mm:rm:${token}:${materialToken}`);
    }
    keyboard.row();
  }
  withPager(keyboard, page, (to) => `v1:mm:list:${token}:${to}`);
  if (canManage) {
    nextRow(keyboard).text("Прикрепить материал", `v1:mm:add:${token}`);
  }
  return {
    id: "materials",
    text: screenText(
      pagedTitle("Материалы", page),
      escapeHtml(meetupTitleLabel(meetup.title)),
      meetup.materials.length === 0
        ? "Пока ничего не прикреплено."
        : page.items
            .map(
              (material, index) =>
                `${first + index + 1}. ${escapeHtml(displayMaterialTitle(material, first + index + 1))}`,
            )
            .join("\n"),
    ),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}
