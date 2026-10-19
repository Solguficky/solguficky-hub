import { InlineKeyboard } from "grammy";
import type { AuctionSummaryView } from "../../../../auction-ui/index.js";
import {
  adminLabel,
  emptyDescription,
  extensionsLabel,
  marked,
  pictogram,
} from "../../../../core/pictograms.js";
import type {
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
import { auctionStateLine } from "./auction-stage.js";
import {
  buttonText,
  confirmKeyboard,
  dayLabel,
  escapeHtml,
  extensionsData,
  heading,
  nextRow,
  type Page,
  type Parent,
  pagedTitle,
  pageSize,
  paginate,
  readableDay,
  readableMoment,
  removeLabel,
  screenText,
  subjectLine,
  submenuText,
  toArchive,
  toCard,
  toHidden,
  toManage,
  toMeetups,
  toMenu,
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
  return meetup.visibility === "hidden" ? toHidden : toMeetups;
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

function listRows(
  page: Page<MeetupSummary>,
  today: CommunityDay,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const meetup of page.items) {
    keyboard.text(...meetupButton(meetup, today)).row();
  }
  return keyboard;
}

function listKeyboard(
  page: Page<MeetupSummary>,
  today: CommunityDay,
  pager: (page: number) => string,
  parent: Parent,
): InlineKeyboard {
  return withNav(withPager(listRows(page, today), page, pager), parent);
}

/**
 * «Сходки» — основной раздел (прежде «Ближайшие сходки»), ребёнок корневого
 * меню (PER-592): «Архив» — его дочерний экран последним рядом содержимого,
 * перед листанием, а последний ряд — «‹ Меню».
 */
export function meetupsScreen(
  meetups: readonly MeetupSummary[],
  requestedPage: number,
  today: CommunityDay,
): ShownScreen {
  const title = "Сходки";
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
    id: "meetups",
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
    keyboard: withNav(
      withPager(
        nextRow(listRows(page, today)).text(toArchive.name, toArchive.data),
        page,
        (to) => `v1:nav:hub:${to}`,
      ),
      toMenu,
    ),
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
    keyboard: listKeyboard(
      page,
      today,
      (to) => `v1:nav:archive:${to}`,
      toMeetups,
    ),
    format: "HTML",
  };
}

// Незаконченный черновик и снятая с публикации сходка в контракте не
// различаются, поэтому раздел говорит о скрытых, а не о черновиках.
export function hiddenScreen(
  meetups: readonly MeetupSummary[],
  requestedPage: number,
  today: CommunityDay,
  // Родитель — группа «Сходки и объявления» либо само «Управление»
  // (`manageItemParent`).
  parent: Parent = toManage,
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
      parent,
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
 * описание. Текст уже экранирован. Видимость — «видна» или «скрыта» — в
 * статусе видит только тот, кто управляет сходкой: остальным скрытая сходка
 * не показывается вовсе, а «видна» ничего им не говорит (решение владельца
 * 10 октября 2026 года).
 */
function cardLines(
  meetup: MeetupSnapshot,
  author: MeetupAuthor | undefined,
  today: CommunityDay,
  manageable: boolean,
  extensions: readonly string[] = [],
): string[] {
  const lifecycle =
    meetup.lifecycle === "cancelled"
      ? "отменена"
      : meetup.lifecycle === "held"
        ? "состоялась"
        : "запланирована";
  const visibility = meetup.visibility === "hidden" ? "скрыта" : "видна";
  return [
    manageable ? `Статус: ${lifecycle}, ${visibility}` : `Статус: ${lifecycle}`,
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
    marked(
      pictogram.when,
      `Когда: ${meetup.schedule === undefined ? "дата не задана" : readableMoment(meetup.schedule, today)}`,
    ),
    marked(
      pictogram.where,
      `Где: ${meetup.venue === "" ? "не указано" : escapeHtml(meetup.venue)}`,
    ),
    "",
    ...(extensions.length === 0 ? [] : [...extensions, ""]),
    meetup.description === ""
      ? emptyDescription
      : escapeHtml(meetup.description),
  ];
}

// Пометка файла в списке материалов карточки (PER-594): фото, которое уже стоит
// постером над заголовком, пометки не несёт; фото без постера — в обычной
// карточке, после отказа Telegram или сверх предела постеров — «(фото)»,
// документ — «(файл)».
function fileMark(
  source: Extract<MeetupMaterial["source"], { kind: "file" }>,
  shown: ReadonlySet<string>,
): string {
  if (source.fileKind !== "photo") return " (файл)";
  return shown.has(source.fileId) ? "" : " (фото)";
}

// Строки расширений сходки — блок после «Когда» и «Где»: сейчас одна, строка
// аукциона (PER-594). Без аукциона блока нет.
function auctionLines(view: CardView): string[] {
  return view.auction === undefined
    ? []
    : [
        escapeHtml(
          auctionStateLine(view.auction, view.timeZone ?? "UTC", view.today),
        ),
      ];
}

// `shown` — файлы, которые карточка показала постерами над заголовком.
function materialLines(
  meetup: MeetupSnapshot,
  shown: ReadonlySet<string> = new Set(),
): string[] {
  if (meetup.materials.length === 0) return [];
  const hidden = meetup.materials.length - materialCardLimit;
  return [
    "",
    marked(pictogram.materials, "Материалы:"),
    ...meetup.materials.slice(0, materialCardLimit).map((material, index) => {
      const label = escapeHtml(displayMaterialTitle(material, index + 1));
      return material.source.kind === "message-link"
        ? `${index + 1}. <a href="${escapeHtml(material.source.url)}">${label}</a>`
        : `${index + 1}. ${label}${fileMark(material.source, shown)}`;
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

export type CardView = {
  meetup: MeetupSnapshot;
  author?: MeetupAuthor | undefined;
  /** Нет — Notifications не ответил, и состояние подписки не показывается. */
  subscribed?: boolean | undefined;
  /** Смотрящий управляет сходкой: видны правка, статус и рассылка. */
  manageable: boolean;
  presentation: "rich" | "plain";
  today: CommunityDay;
  /**
   * `false` — карточка без постеров: так она приходит повторно, когда Telegram
   * не принял сообщение с фото, например файл больше недоступен.
   */
  posters?: boolean;
  /**
   * Аукцион сходки для строки его состояния (PER-594). Нет — аукциона нет,
   * бот без Auction или Auction не ответил: строки нет, без заглушки.
   */
  auction?: AuctionSummaryView;
  /** Пояс сообщества: в нём строка аукциона называет срок торгов. */
  timeZone?: string;
};

// Без подписки карточка объясняет, что она даёт: кнопка настроек сходки
// появляется только после подписки, и иначе связь между ними не видна.
const unsubscribedHint =
  "Подпишись, чтобы получать изменения, материалы и сообщения организатора этой сходки.";

// Кнопки карточки — входы в разделы сходки, и каждая несёт знак своего
// раздела, тот же, что в тексте (решение владельца по прогону 14 октября 2026
// года, PER-644). Действия управления несут один знак 🛠 (PER-669). Возврат
// «‹ …» знака не несёт.
const editLabel = adminLabel("Изменить");
const statusLabel = adminLabel("Статус");
const materialsLabel = (count: number) =>
  marked(pictogram.materials, `Материалы (${count})`);
const broadcastLabel = adminLabel("Написать подписчикам");
const subscribeLabel = marked(pictogram.on, "Подписаться на сходку");
const unsubscribeLabel = marked(pictogram.off, "Отписаться");
export const meetupNotificationsLabel = marked(
  pictogram.settings,
  "Уведомления сходки",
);

/**
 * Карточка сходки. Под ней не больше пяти рядов: правка и статус, материалы и
 * расширения, рассылка, подписка с её настройками и возврат. Файлы
 * открываются из «Материалов», а «Отметить состоявшейся» живёт в «Статусе».
 */
export function cardScreen(view: CardView): ShownScreen {
  const { meetup, manageable, presentation, today } = view;
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard();
  const editable = manageable && meetup.lifecycle !== "cancelled";
  if (editable) {
    keyboard
      .text(editLabel, `v1:manage:edit:${token}`)
      .text(statusLabel, `v1:manage:status:${token}`)
      .row();
  }
  if (editable || meetup.materials.length > 0) {
    keyboard.text(
      materialsLabel(meetup.materials.length),
      `v1:mm:list:${token}`,
    );
  }
  // Расширения сходки (PER-605; ADR-064, дополнение 2026-10-12) стоят в ряду
  // материалов: оба — содержимое сходки, и отдельным рядом они вывели бы
  // карточку организатора за пять рядов. Кнопка одна у всех и без состояния:
  // включённое расширение, включение и «расширений нет» показывает меню за
  // ней. Состояние аукциона карточка несёт строкой текста (PER-594), и сбой
  // Auction убирает только её.
  keyboard.text(extensionsLabel, extensionsData(token));
  nextRow(keyboard);
  // Написать подписчикам можно и об отменённой сходке: сообщить им об отмене
  // — законный повод, и Notifications жизненный цикл при рассылке не фильтрует.
  if (manageable) {
    keyboard.text(broadcastLabel, `v1:bc:m:${token}`).row();
  }
  // Кнопка подписки рисуется только тогда, когда Notifications ответил:
  // состояние на ней — факт, а не заглушка. Настройки сходки решают, что
  // присылать по подписке, поэтому без подписки их входа нет. Когда
  // Notifications не ответил, вход остаётся: иначе один моргнувший ответ
  // отрезает экран целиком.
  if (view.subscribed === false) {
    keyboard.text(subscribeLabel, `v1:notify:sub:${token}:1`).row();
  } else {
    if (view.subscribed === true) {
      keyboard.text(unsubscribeLabel, `v1:notify:sub:${token}:0`);
    }
    keyboard
      .text(meetupNotificationsLabel, `v1:notify:settings:${token}`)
      .row();
  }
  // Постеры — только в богатой карточке: обычное сообщение несёт либо текст,
  // либо файл, и с файлом оно перестало бы правиться на месте.
  const photos =
    presentation === "rich" && view.posters !== false ? posters(meetup) : [];
  const title = escapeHtml(meetupTitleLabel(meetup.title));
  const body = [
    ...cardLines(meetup, view.author, today, manageable, auctionLines(view)),
    ...materialLines(
      meetup,
      new Set(
        photos.flatMap((photo) => ("fileId" in photo ? [photo.fileId] : [])),
      ),
    ),
  ];
  // Подсказка о подписке стоит под карточкой.
  const hint = view.subscribed === false ? unsubscribedHint : undefined;
  return {
    id: "card",
    text: cardText({
      title,
      body,
      hint,
      presentation,
      posters: posterBlock(photos),
    }),
    keyboard: withNav(keyboard, meetupParent(meetup, today)),
    format: presentation === "rich" ? "rich" : "HTML",
    ...(photos.length === 0 ? {} : { media: photos }),
  };
}

// Текст карточки и черновика: заголовок с телом, подсказка. Заголовок и тело
// уже экранированы, подсказка — нет. Исход действия карточка не несёт: он —
// свой экран (PER-472).
function cardText(parts: {
  title: string;
  body: readonly string[];
  hint?: string | undefined;
  presentation: "rich" | "plain";
  /**
   * Готовый блок постеров богатой карточки: стоит первым, над заголовком
   * (решение владельца 10 октября 2026 года).
   */
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
      ? `${parts.posters ?? ""}<h1>${title}</h1><p>${body.join("<br>")}</p>`
      : `<b>${title}</b>\n\n${body.join("\n")}`;
  return [card, paragraph(parts.hint)]
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
    // `d` — источник подтверждения: «Нет» под ним вернёт на черновик.
    .text("Опубликовать", `v1:manage:republish:${token}:d`)
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
      // Черновик видит только организатор.
      body: cardLines(meetup, undefined, today, true),
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
    text: submenuText(
      "Изменить",
      meetupTitleLabel(meetup.title),
      "Что меняем?",
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
// конфликта версий говорят об одном и том же действии одними словами.
// Необратимость конечной стадии называет строка `irreversible`, и такое «Да»
// красное; скрытие и снятие отложенной публикации обратимы и цвета не несут
// (решение владельца 10 октября 2026 года).
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

/**
 * «Да» подтверждения смены состояния. Версия — та, которую человек видел:
 * правка между экраном и нажатием даёт конфликт, а не команду поверх неё
 * (PER-472). Самая длинная строка — `confirm-unschedule` с токеном и девятью
 * цифрами версии, 61 байт из 64.
 */
export function confirmStateCallback(
  action: MeetupStateAction,
  token: string,
  version: number,
): string {
  return `v1:manage:${stateActionCopy[action].confirmAction}:${token}:${version}`;
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
      // Снятие отложенной публикации обратимо с того же экрана — момент
      // назначается заново — и наружу не выходит, поэтому без подтверждения
      // (решение владельца 10 октября 2026 года). Кнопка сразу несёт версию.
      keyboard
        .text(
          stateActionCopy.unschedule.label,
          confirmStateCallback("unschedule", token, meetup.version),
        )
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
    text: submenuText(
      "Статус",
      meetupTitleLabel(meetup.title),
      // Экран «Статус» открывает только тот, кто управляет сходкой.
      cardLines(meetup, author, today, true).join("\n"),
    ),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}

/**
 * Подтверждение публикации (решение владельца 10 октября 2026 года): публикация
 * выходит наружу — сходку видят участники, уведомления уходят. «Да» несёт
 * версию, которую человек видит; «Нет» возвращает туда, где нажали
 * «Опубликовать». Первая публикация уведомляет подписчиков новых сходок, возврат
 * скрытой — подписчиков самой сходки (Notifications, PER-216 и PER-218); с
 * черновика бывает только первая.
 */
export function publishConfirmScreen(confirm: {
  meetup: Pick<MeetupSnapshot, "id" | "title" | "version">;
  /** Где нажали «Опубликовать»: на черновике или в «Статусе». */
  origin: "draft" | "status";
}): ShownScreen {
  const token = uuidToToken(confirm.meetup.id);
  return {
    id: "publish-confirm",
    text: [
      heading("Опубликовать сходку?"),
      "",
      subjectLine(meetupTitleLabel(confirm.meetup.title)),
      confirm.origin === "draft"
        ? "Сходка станет видна участникам, подписчики новых сходок получат уведомление."
        : "Сходка станет видна участникам. Уведомление получат подписчики новых сходок, а если сходку уже публиковали — её подписчики.",
    ].join("\n"),
    keyboard: confirmKeyboard({
      yes: "Да, опубликовать сходку",
      yesData:
        confirm.origin === "draft"
          ? `v1:manage:publish:${token}:${confirm.meetup.version}`
          : `v1:manage:confirm-publish:${token}:${confirm.meetup.version}`,
      noData:
        confirm.origin === "draft"
          ? `v1:manage:draft:${token}`
          : `v1:manage:status:${token}`,
    }),
    format: "HTML",
  };
}

/** Подтверждение смены состояния по снимку, который человек видит. */
export function stateConfirmScreen(confirm: {
  action: MeetupStateAction;
  meetup: Pick<MeetupSnapshot, "id" | "title" | "version">;
  /** Куда возвращает «Нет»: экран, с которого подтверждение открыто. */
  back: string;
}): ShownScreen {
  const copy = stateActionCopy[confirm.action];
  const token = uuidToToken(confirm.meetup.id);
  return {
    // Обратимое и необратимое подтверждения — разные записи каталога: по ним
    // линтер знает, обязан ли «Да» быть красным.
    id:
      copy.irreversible === undefined ? "state-confirm" : "state-final-confirm",
    text: [
      heading(copy.question),
      "",
      subjectLine(meetupTitleLabel(confirm.meetup.title)),
      ...(copy.irreversible === undefined ? [] : [copy.irreversible]),
    ].join("\n"),
    keyboard: confirmKeyboard({
      yes: copy.yes,
      yesData: confirmStateCallback(
        confirm.action,
        token,
        confirm.meetup.version,
      ),
      noData: confirm.back,
      irreversible: copy.irreversible !== undefined,
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
      keyboard.text(
        removeLabel("Убрать"),
        `v1:mm:rm:${token}:${materialToken}`,
      );
    }
    keyboard.row();
  }
  withPager(keyboard, page, (to) => `v1:mm:list:${token}:${to}`);
  if (canManage) {
    nextRow(keyboard).text("Прикрепить материал", `v1:mm:add:${token}`);
  }
  return {
    id: "materials",
    text: submenuText(
      pagedTitle("Материалы", page),
      meetupTitleLabel(meetup.title),
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
