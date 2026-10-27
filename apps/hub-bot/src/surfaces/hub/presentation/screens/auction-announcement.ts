import { InlineKeyboard } from "grammy";
import { money, truncate } from "../../../../core/format.js";
import {
  type AnnouncementButtonKind,
  announcementButtonLabels,
  announcementTextLimit,
} from "../../../../core/notifications/organizer-announcement.js";
import { marked, pictogram } from "../../../../core/pictograms.js";
import type {
  AnnouncementDraft,
  AnnouncementLot,
  AnnouncementTemplate,
  AnnouncementTextError,
  AuctionAnnouncementResult,
  ButtonChoice,
} from "../../application/auction-announcements.js";
import { fingerprint } from "../../application/fingerprint.js";
import type { StepWindow } from "../../application/types.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleAnnouncementAskData,
  consoleAnnouncementButtonData,
  consoleAnnouncementData,
  consoleAnnouncementLotsData,
  consoleAnnouncementMediaData,
  consoleAnnouncementPhotoData,
  consoleAnnouncementSendData,
  consoleAnnouncementWindowsData,
} from "../parse-callback.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  exitToMeetups,
  outcomeText,
  type Parent,
  pagedTitle,
  paginate,
  plural,
  readableMoment,
  screenText,
  toAuctionRoot,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Объявление аукциона (PER-765, эпик PER-763): вход — ряд корня аукциона
// держателю права вести аукцион (в пульте нет места); меню шаблонов, выбор
// окна и лота, кнопка, фото лота, подтверждение со счётчиком и исходы. Своего
// состояния нет: текст едет хвостом кадра шага после строки
// `announcementTextLead`, и следующий шаг читает его оттуда
// (`presentation/announcement-input.ts`), а кнопки несут его отпечаток.

/**
 * Вход в объявление из корня аукциона: действие управления на экране, который
 * видит и участник, несёт «🛠», как «🛠 Пульт» (дизайн-код, PER-669).
 */
export const announcementLabel = marked(pictogram.admin, "Объявление");

/**
 * Строка, за которой в кадре шага идёт текст объявления, — до конца
 * сообщения. Текст стоит последним, поэтому его переводы строк не мешают
 * прочесть его целиком.
 */
export const announcementTextLead = "Текст объявления:";

const templateLabels: Readonly<Record<AnnouncementTemplate, string>> = {
  own: "Своё объявление",
  raffle: "Розыгрыш и прогнозы",
  windows: "Счастливые часы",
  lot: "История лота",
  chronicle: "Хроники дня",
};

const noButtonLabel = "Без кнопки";
const editTextLabel = "Изменить текст";
const skipPhotoLabel = "Пропустить";
const ownMediaLabel = "Своё фото или видео";

type Moments = { timeZone: string; today: CommunityDay };

function toAnnouncement(auctionId: string): Parent {
  return {
    name: "Объявление",
    data: consoleAnnouncementData(uuidToToken(auctionId)),
  };
}

function moment(instant: string, view: Moments): string {
  return readableMoment(communityLocalTime(instant, view.timeZone), view.today);
}

function span(window: StepWindow, view: Moments): string {
  return `с ${moment(window.from, view)} до ${moment(window.until, view)}`;
}

/** Меню: своё объявление и шаблоны, которые аукцион сейчас может нести. */
export function announcementMenuScreen(
  view: Extract<AuctionAnnouncementResult, { kind: "announcement-menu" }>,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const keyboard = new InlineKeyboard().text(
    templateLabels.own,
    consoleAnnouncementAskData(auction, "own"),
  );
  if (view.raffle) {
    keyboard
      .row()
      .text(
        templateLabels.raffle,
        consoleAnnouncementAskData(auction, "raffle"),
      );
  }
  if (view.windows > 0) {
    keyboard
      .row()
      .text(templateLabels.windows, consoleAnnouncementWindowsData(auction));
  }
  if (view.lots > 0) {
    keyboard
      .row()
      .text(templateLabels.lot, consoleAnnouncementLotsData(auction));
  }
  if (view.chronicle) {
    keyboard
      .row()
      .text(
        templateLabels.chronicle,
        consoleAnnouncementAskData(auction, "chronicle"),
      );
  }
  return {
    id: "announcement",
    text: screenText(
      "Объявление",
      escapeHtml(
        "Сообщение всем, у кого есть право ставок: участникам — в этом боте, гостям — в боте аукциона. Выбери своё объявление или шаблон — черновик текста можно поправить.",
      ),
    ),
    keyboard: withNav(keyboard, toAuctionRoot(view.auctionId)),
    format: "HTML",
  };
}

/** Окна «Счастливых часов» для шаблона: объявленные, затем запущенные. */
export function announcementWindowsScreen(
  view: Extract<AuctionAnnouncementResult, { kind: "announcement-windows" }>,
  moments: Moments,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const keyboard = new InlineKeyboard();
  view.windows.forEach((window, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      buttonText(`Окно ${index + 1}: ${span(window, moments)}`),
      consoleAnnouncementAskData(auction, "windows", index),
    );
  });
  return {
    id: "announcement-windows",
    text: screenText(
      "Счастливые часы",
      escapeHtml(
        view.windows.length === 0
          ? "Окон нет: объявлять нечего."
          : "О каком окне объявить?",
      ),
    ),
    keyboard: withNav(keyboard, toAnnouncement(view.auctionId)),
    format: "HTML",
  };
}

/** Лоты реестра для «Истории лота», по восемь на страницу. */
export function announcementLotsScreen(
  view: Extract<AuctionAnnouncementResult, { kind: "announcement-lots" }>,
  requested: number,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const page = paginate(view.lots, requested);
  const keyboard = new InlineKeyboard();
  page.items.forEach((lot, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      buttonText(lot.title),
      consoleAnnouncementAskData(auction, "lot", lot.index),
    );
  });
  withPager(keyboard, page, (target) =>
    consoleAnnouncementLotsData(auction, target),
  );
  return {
    id: "announcement-lots",
    text: screenText(
      pagedTitle("История лота", page),
      escapeHtml(
        view.lots.length === 0
          ? "Лотов нет: рассказывать не о чем."
          : "О каком лоте рассказать? Его фото можно будет приложить.",
      ),
    ),
    keyboard: withNav(keyboard, toAnnouncement(view.auctionId)),
    format: "HTML",
  };
}

// Черновик — заготовка слов, а не готовое объявление: организатор правит его
// и присылает своим текстом. Названия лотов и приз — слова организатора, и
// черновик их не обрезает, кроме длины всего текста.
export function draftText(
  draft: AnnouncementDraft,
  moments: Moments,
): string | undefined {
  switch (draft.kind) {
    case "own":
      return undefined;
    case "raffle":
      return truncate(
        [
          `Бесплатный розыгрыш среди участников аукциона${draft.prize === undefined ? "" : `: разыгрываем «${draft.prize}»`}.`,
          draft.closesAt === undefined
            ? undefined
            : `Регистрация открыта до ${moment(draft.closesAt, moments)}.`,
          draft.predictions
            ? "А ещё прогнозы: угадай, как закончатся торги."
            : undefined,
          "Жми кнопку ниже.",
        ]
          .filter((line) => line !== undefined)
          .join(" "),
        announcementTextLimit,
      );
    case "windows":
      return truncate(
        `Счастливые часы ${span(draft.window, moments)}: шаг ставки снижен до ${money(draft.window.step)}${draft.lotTitles.length === 0 ? "" : ` на лотах: ${draft.lotTitles.join(", ")}`}. Успей поставить!`,
        announcementTextLimit,
      );
    case "lot":
      return truncate(`История лота «${draft.title}»: `, announcementTextLimit);
    case "chronicle":
      return "Хроники дня: кто кого перебил, за какой лот спорили дольше всех и кто стал тёмной лошадкой торгов. Смотри в «Хрониках дня».";
    default: {
      const _exhaustive: never = draft;
      return _exhaustive;
    }
  }
}

/**
 * Вопрос о тексте: черновик шаблона блоком `<code>` — нажатие копирует его в
 * клиенте, — а ответ — свой текст. Предел — подпись фото Telegram.
 */
export function announcementQuestionText(
  draft: AnnouncementDraft,
  moments: Moments,
): string {
  const text = draftText(draft, moments);
  return [
    escapeHtml(
      `Напиши текст объявления ответом на это сообщение — до ${announcementTextLimit} знаков. Его получат как есть, без разметки.`,
    ),
    ...(text === undefined
      ? []
      : [
          `${escapeHtml("Черновик — нажми, чтобы скопировать:")}\n<code>${escapeHtml(text)}</code>`,
        ]),
  ].join("\n\n");
}

/**
 * Вопрос о своём медиа (PER-776): одно фото или видео ответом. Текст
 * объявления идёт хвостом, как в кадре шага: ответ читает его оттуда.
 */
export function announcementMediaQuestionText(
  text: string,
  refused = false,
): string {
  return [
    escapeHtml(
      refused
        ? "Это не фото и не видео. Пришли одно фото или одно видео ответом на это сообщение."
        : "Пришли одно фото или одно видео ответом на это сообщение — оно уйдёт с текстом ниже подписью.",
    ),
    textBlock(text),
  ].join("\n\n");
}

export const announcementAskErrorText: Readonly<
  Record<AnnouncementTextError, string>
> = {
  empty: "Текст пустой. Напиши объявление словами.",
  "too-long": `Текст длиннее ${announcementTextLimit} знаков — столько помещается в подпись к фото. Сократи его.`,
  nul: "В тексте есть невидимый символ, который Telegram не примет. Перепиши текст.",
};

export function textBlock(text: string): string {
  return `${announcementTextLead}\n${escapeHtml(text)}`;
}

/** Шаг кнопки: кнопки по одной в ряд, «Без кнопки» и правка текста. */
export function announcementButtonScreen(view: {
  auctionId: string;
  text: string;
  buttons: readonly AnnouncementButtonKind[];
  lot?: AnnouncementLot | undefined;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const print = fingerprint(view.text);
  const keyboard = new InlineKeyboard();
  const choices: ButtonChoice[] = [...view.buttons, "none"];
  choices.forEach((choice, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      choice === "none" ? noButtonLabel : announcementButtonLabels[choice],
      consoleAnnouncementButtonData(auction, choice, print, view.lot?.index),
    );
  });
  keyboard.row().text(
    editTextLabel,
    // Правка текста «Истории лота» остаётся при лоте: иначе «К лоту» и фото
    // лота пропали бы со следующего шага.
    view.lot === undefined
      ? consoleAnnouncementAskData(auction, "own")
      : consoleAnnouncementAskData(auction, "lot", view.lot.index),
  );
  return {
    id: "announcement-button",
    text: screenText(
      "Кнопка объявления",
      escapeHtml("Куда поведёт кнопка под объявлением?"),
      textBlock(view.text),
    ),
    keyboard: withNav(keyboard, toAnnouncement(view.auctionId)),
    format: "HTML",
  };
}

/**
 * Шаг фото: одно из фото лота шаблона, своё фото или видео через чат медиа
 * ботов (PER-776), когда он включён, или «Пропустить».
 */
export function announcementPhotoScreen(view: {
  auctionId: string;
  text: string;
  button: ButtonChoice;
  lot?: AnnouncementLot | undefined;
  photos: number;
  media: boolean;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const print = fingerprint(view.text);
  const keyboard = new InlineKeyboard();
  const { lot } = view;
  const photos = lot === undefined ? 0 : view.photos;
  for (let index = 0; index < photos; index += 1) {
    // Короткие подписи встают по четыре в ряд: десять фото — три ряда.
    if (index > 0 && index % 4 === 0) keyboard.row();
    keyboard.text(
      `Фото ${index + 1}`,
      consoleAnnouncementPhotoData(
        auction,
        view.button,
        print,
        lot?.index,
        index,
      ),
    );
  }
  if (view.media) {
    if (photos > 0) keyboard.row();
    keyboard.text(
      ownMediaLabel,
      consoleAnnouncementMediaData(auction, view.button, print, lot?.index),
    );
  }
  keyboard
    .row()
    .text(
      skipPhotoLabel,
      consoleAnnouncementPhotoData(auction, view.button, print, lot?.index),
    );
  const question =
    lot === undefined || photos === 0
      ? "Приложить своё фото или видео?"
      : view.media
        ? `Приложить фото лота «${lot.title}» или своё фото или видео? Номер — порядок фото на карточке лота.`
        : `Приложить фото лота «${lot.title}»? Номер — порядок фото на карточке лота.`;
  return {
    id: "announcement-photo",
    text: screenText(
      "Фото объявления",
      escapeHtml(question),
      textBlock(view.text),
    ),
    keyboard: withNav(keyboard, toAnnouncement(view.auctionId)),
    format: "HTML",
  };
}

/**
 * Подтверждение отправки — ответ на предпросмотр, который выглядит ровно как
 * у получателя. Текст «Отправить» читает из предпросмотра, а кнопка несёт его
 * отпечаток, выбор кнопки и номера лота и фото.
 */
export function announcementConfirmScreen(view: {
  auctionId: string;
  text: string;
  button: ButtonChoice;
  lot?: AnnouncementLot | undefined;
  photo?: number | undefined;
  post?: number | undefined;
  recipientCount: number;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const people = plural(view.recipientCount, [
    "человек",
    "человека",
    "человек",
  ]);
  return {
    id: "announcement-confirm",
    text: screenText(
      "Отправить объявление?",
      escapeHtml(
        view.recipientCount === 0
          ? "Выше — как его увидят. Сейчас его никто не получит: держателей права ставок нет или все выключили вести об аукционе."
          : `Выше — как его увидят. Получат ${people} с правом ставок, кроме тех, кто выключил вести об аукционе.`,
      ),
    ),
    keyboard: confirmKeyboard({
      yes: `Да, отправить ${view.recipientCount}`,
      yesData: consoleAnnouncementSendData(
        auction,
        view.button,
        fingerprint(view.text),
        view.lot?.index,
        view.photo,
        view.post,
      ),
      noData: consoleAnnouncementData(auction),
      irreversible: true,
    }),
    format: "HTML",
    delivery: "new",
  };
}

/** Исход отправки и устаревшие шаги — свой экран с возвратом в корень аукциона. */
export function announcementOutcomeScreen(
  view: Extract<
    AuctionAnnouncementResult,
    { kind: "announcement-sent" } | { kind: "announcement-outcome" }
  >,
): ShownScreen {
  const text =
    view.kind === "announcement-sent"
      ? view.repeated
        ? "Это объявление уже отправлено. Второй раз его не получат."
        : "Объявление принято. Получатели увидят его в течение нескольких минут."
      : {
          "window-gone":
            "Этого окна в пульте больше нет. Объявление не отправлено: выбери окно заново.",
          "lot-gone":
            "Этого лота в реестре больше нет. Объявление не отправлено: выбери лот заново.",
          "photo-gone":
            "Этого фото у лота больше нет. Объявление не отправлено: выбери фото заново.",
          closed:
            "Объявлять некому: аукцион скрыт от участников или уже закончился.",
          "media-off":
            "Своё фото или видео сейчас приложить нельзя: канал медиа ботов не настроен. Объявление не отправлено.",
          "media-failed":
            "Не получилось сохранить фото или видео в канал медиа ботов. Объявление не отправлено: проверь, что бот — администратор канала, и начни заново.",
        }[view.note];
  return {
    id: "outcome",
    text: outcomeText(text),
    keyboard: withNav(new InlineKeyboard(), toAuctionRoot(view.auctionId)),
    format: "HTML",
  };
}

/**
 * Сходки аукциона процесс не знает — так бывает после рестарта: объявление
 * адресуется сходкой, а Auction её по аукциону не отдаёт. Карточка сходки
 * напомнит её процессу.
 */
export function announcementWithoutMeetupScreen(): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(
      "Открой аукцион с карточки сходки. Объявлению нужна сходка аукциона, а бот её сейчас не помнит: открой сходку, «🧩 Расширения» и аукцион — и нажми «🛠 Объявление» снова.",
    ),
    keyboard: exitToMeetups(),
    format: "HTML",
  };
}

/** Кадр шага устарел: текста в нём нет или он не сходится с кнопкой. */
export function announcementStaleScreen(auctionId: string): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(
      "Шаг устарел. Объявление не отправлено: напиши текст заново.",
    ),
    keyboard: withNav(
      new InlineKeyboard().text(
        "Ввести заново",
        consoleAnnouncementAskData(uuidToToken(auctionId), "own"),
      ),
      toAuctionRoot(auctionId),
    ),
    format: "HTML",
  };
}
