import { InlineKeyboard } from "grammy";
import { money, truncate } from "../../../../core/format.js";
import {
  type AnnouncementButtonKind,
  announcementButtonLabels,
  announcementTextLimit,
} from "../../../../core/notifications/organizer-announcement.js";
import type {
  AnnouncementAudience,
  AnnouncementDraft,
  AnnouncementHappyHourLot,
  AnnouncementLot,
  AnnouncementTemplate,
  AnnouncementTextError,
  AuctionAnnouncementResult,
  ButtonChoice,
} from "../../application/auction-announcements.js";
import { fingerprint } from "../../application/fingerprint.js";
import {
  type CommunityDay,
  communityLocalTime,
  communityShownTime,
} from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleAnnouncementAskData,
  consoleAnnouncementAudienceData,
  consoleAnnouncementButtonData,
  consoleAnnouncementData,
  consoleAnnouncementLotsData,
  consoleAnnouncementMediaData,
  consoleAnnouncementPhotoData,
  consoleAnnouncementRecipientsData,
  consoleAnnouncementSendData,
  consoleAnnouncementWindowsData,
  consoleViewData,
} from "../parse-callback.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  outcomeText,
  type Parent,
  pagedTitle,
  paginate,
  plural,
  readableMoment,
  refusalText,
  retryLabel,
  screenText,
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
 * Вход в объявление — из пульта (PER-802): экран видит только держатель
 * права, и знак управления подписи не нужен.
 */
export const announcementLabel = "Объявление";

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

// Шаблон розыгрыша после закрытия регистрации (PER-779): о розыгрыше больше
// не объявить, а прогнозы ещё идут.
const predictionsTemplateLabel = "Прогнозы";

/** Аудитории шага «Кому» (PER-779, решение PER-768). */
export const audienceLabels: Readonly<Record<AnnouncementAudience, string>> = {
  all: "Всем",
  "not-in-raffle": "Не в розыгрыше",
  "without-predictions": "Без прогнозов",
  "not-in-raffle-or-without-predictions": "Не в розыгрыше или без прогнозов",
};

// Кто получит объявление — в тексте подтверждения.
const audienceWords: Readonly<Record<AnnouncementAudience, string>> = {
  all: "",
  "not-in-raffle": "кто ещё не в розыгрыше",
  "without-predictions": "у кого нет прогноза",
  "not-in-raffle-or-without-predictions":
    "кто ещё не в розыгрыше или без прогноза",
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

function deadline(instant: string, view: Moments): string {
  return readableMoment(communityShownTime(instant, view.timeZone), view.today);
}

function span(window: { from: string; until: string }, view: Moments): string {
  return `с ${moment(window.from, view)} до ${deadline(window.until, view)}`;
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
  if (view.raffle !== undefined) {
    keyboard
      .row()
      .text(
        view.raffle === "raffle"
          ? templateLabels.raffle
          : predictionsTemplateLabel,
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
        "Сообщение тем, у кого есть право ставок: участникам — в этом боте, гостям — в боте аукциона. Выбери своё объявление или шаблон — черновик текста можно поправить, а кому отправить, спросим перед предпросмотром.",
      ),
    ),
    keyboard: withNav(keyboard, toConsole(view.auctionId)),
    format: "HTML",
  };
}

/**
 * «Счастливые часы» для шаблона: окна и периоды, которые идут или впереди, по
 * началу (PER-804).
 */
export function announcementWindowsScreen(
  view: Extract<AuctionAnnouncementResult, { kind: "announcement-windows" }>,
  moments: Moments,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const keyboard = new InlineKeyboard();
  view.windows.forEach((window, position) => {
    if (position > 0) keyboard.row();
    keyboard.text(
      buttonText(
        `${window.kind === "period" ? "Период" : "Окно"}: ${span(window, moments)}`,
      ),
      consoleAnnouncementAskData(auction, "windows", window.index),
    );
  });
  return {
    id: "announcement-windows",
    text: screenText(
      "Счастливые часы",
      escapeHtml(
        view.windows.length === 0
          ? "Окон и периодов впереди нет: объявлять нечего."
          : "О каких счастливых часах объявить?",
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

// Лот периода в черновике: «Ваза — старт 800 ₽, шаг 50 ₽».
function lotTerms(lot: AnnouncementHappyHourLot): string {
  const terms = [
    ...(lot.start === undefined ? [] : [`старт ${money(lot.start)}`]),
    ...(lot.step === undefined ? [] : [`шаг ${money(lot.step)}`]),
  ];
  return terms.length === 0 ? lot.title : `${lot.title} — ${terms.join(", ")}`;
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
      // После закрытия регистрации шаблон — «Прогнозы» (PER-779).
      if (!draft.raffle) {
        return "Прогнозы аукциона: угадай, как закончатся торги. Жми кнопку ниже.";
      }
      return truncate(
        [
          `Бесплатный розыгрыш среди участников аукциона${draft.prize === undefined ? "" : `: разыгрываем «${draft.prize}»`}.`,
          draft.closesAt === undefined
            ? undefined
            : `Регистрация открыта до ${deadline(draft.closesAt, moments)}.`,
          draft.predictions
            ? "А ещё прогнозы: угадай, как закончатся торги."
            : undefined,
          "Жми кнопку ниже.",
        ]
          .filter((line) => line !== undefined)
          .join(" "),
        announcementTextLimit,
      );
    case "windows": {
      const { window, lots } = draft;
      // Окно снижает шаг всем своим лотам, период задаёт условия каждому
      // лоту свои (PER-804).
      const terms =
        window.step !== undefined
          ? `шаг ставки снижен до ${money(window.step)}${lots.length === 0 ? "" : ` на лотах: ${lots.map((lot) => lot.title).join(", ")}`}`
          : lots.length === 0
            ? "особые условия торгов"
            : `особые условия на лотах: ${lots.map(lotTerms).join("; ")}`;
      return truncate(
        `Счастливые часы ${span(window, moments)}: ${terms}. Успей поставить!`,
        announcementTextLimit,
      );
    }
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
  audience: AnnouncementAudience;
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
      consoleAnnouncementButtonData(
        auction,
        choice,
        print,
        view.audience,
        view.lot?.index,
      ),
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
  audience: AnnouncementAudience;
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
        view.audience,
        lot?.index,
        index,
      ),
    );
  }
  if (view.media) {
    if (photos > 0) keyboard.row();
    keyboard.text(
      ownMediaLabel,
      consoleAnnouncementMediaData(
        auction,
        view.button,
        print,
        view.audience,
        lot?.index,
      ),
    );
  }
  keyboard
    .row()
    .text(
      skipPhotoLabel,
      consoleAnnouncementPhotoData(
        auction,
        view.button,
        print,
        view.audience,
        lot?.index,
      ),
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
 * Шаг «Кому» (PER-779): аудитории, которые аукцион может назвать сейчас, по
 * одной в ряд, выбранная — первой. Число получателей назовёт предпросмотр:
 * считает его Notifications, а людей шаг не видит.
 */
export function announcementAudienceScreen(view: {
  auctionId: string;
  text: string;
  button: ButtonChoice;
  lot?: AnnouncementLot | undefined;
  photo?: number | undefined;
  post?: number | undefined;
  audience: AnnouncementAudience;
  audiences: readonly AnnouncementAudience[];
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const print = fingerprint(view.text);
  const keyboard = new InlineKeyboard();
  const ordered = [
    view.audience,
    ...view.audiences.filter((audience) => audience !== view.audience),
  ];
  ordered.forEach((audience, index) => {
    if (index > 0) keyboard.row();
    keyboard.text(
      audienceLabels[audience],
      consoleAnnouncementRecipientsData(auction, {
        button: view.button,
        print,
        audience,
        lot: view.lot?.index,
        photo: view.photo,
        post: view.post,
      }),
    );
  });
  return {
    id: "announcement-audience",
    text: screenText(
      "Кому",
      escapeHtml(
        view.audience === "all"
          ? "Кому отправить объявление? Сколько человек его получит, покажет предпросмотр."
          : `Кому отправить объявление? Первым — выбор шаблона: «${audienceLabels[view.audience]}». Сколько человек его получит, покажет предпросмотр.`,
      ),
      textBlock(view.text),
    ),
    keyboard: withNav(keyboard, toAnnouncement(view.auctionId)),
    format: "HTML",
  };
}

/**
 * Подтверждение отправки — ответ на предпросмотр, который выглядит ровно как
 * у получателя. Текст «Отправить» читает из предпросмотра, а кнопка несёт его
 * отпечаток, выбор кнопки, номера лота и фото и аудиторию. «Нет» возвращает
 * в «Кому», когда выбирать было из чего.
 */
export function announcementConfirmScreen(view: {
  auctionId: string;
  text: string;
  button: ButtonChoice;
  lot?: AnnouncementLot | undefined;
  photo?: number | undefined;
  // Отпечаток `photoId` фото предпросмотра: «Отправить» возьмёт именно его
  // (PER-792).
  photoPrint?: string | undefined;
  post?: number | undefined;
  audience: AnnouncementAudience;
  audiences: readonly AnnouncementAudience[];
  recipientCount: number;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const people = plural(view.recipientCount, [
    "человек",
    "человека",
    "человек",
  ]);
  const choice = {
    button: view.button,
    print: fingerprint(view.text),
    audience: view.audience,
    lot: view.lot?.index,
    photo: view.photo,
    post: view.post,
  };
  const narrowed = view.audience !== "all";
  const who = audienceWords[view.audience];
  return {
    id: "announcement-confirm",
    text: screenText(
      "Отправить объявление?",
      escapeHtml(
        view.recipientCount === 0
          ? narrowed
            ? `Выше — как его увидят. Сейчас его никто не получит: среди держателей права ставок нет тех, ${who}, или они выключили вести об аукционе.`
            : "Выше — как его увидят. Сейчас его никто не получит: держателей права ставок нет или все выключили вести об аукционе."
          : narrowed
            ? `Выше — как его увидят. Получат ${people} с правом ставок — те, ${who}, кроме выключивших вести об аукционе.`
            : `Выше — как его увидят. Получат ${people} с правом ставок, кроме тех, кто выключил вести об аукционе.`,
      ),
    ),
    keyboard: confirmKeyboard({
      yes: `Да, отправить ${view.recipientCount}`,
      yesData: consoleAnnouncementSendData(auction, {
        ...choice,
        photoPrint: view.photoPrint,
      }),
      noData:
        view.audiences.length > 1
          ? consoleAnnouncementAudienceData(auction, choice)
          : consoleAnnouncementData(auction),
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
          "audience-gone":
            "Этих получателей больше не выбрать: регистрация в розыгрыше закрылась или раунд прогнозов кончился. Объявление не отправлено: начни заново и выбери, кому.",
          "not-replicated": notReplicatedText,
        }[view.note];
  return {
    id: "outcome",
    text: outcomeText(text),
    keyboard: withNav(new InlineKeyboard(), toConsole(view.auctionId)),
    format: "HTML",
  };
}

// Пульт уже показывает аукцион, а рассылка ещё видит его скрытым: публикация
// до неё не дошла (PER-792).
const notReplicatedText =
  "Рассылка ещё не знает, что аукцион опубликован. Объявление не отправлено: попробуй ещё раз через минуту.";

const announcementUnavailableText =
  "Не получилось загрузить данные. Это на моей стороне. Попробуй ещё раз через минуту.";

/**
 * Шаг не прошёл, но повтор его вылечит (PER-792): Notifications недоступен
 * или его реплика ещё не увидела публикацию аукциона. Кадр несёт текст шага
 * хвостом, как сам шаг, — «Повторить» прочтёт его оттуда тем же разбором и
 * повторит подсчёт, а не объявит шаг устаревшим.
 */
export function announcementRetryScreen(view: {
  auctionId: string;
  reason: "unavailable" | "not-replicated";
  retry: string;
  text?: string | undefined;
}): ShownScreen {
  const lead = refusalText(
    view.reason === "unavailable"
      ? announcementUnavailableText
      : notReplicatedText,
  );
  return {
    id: "refusal",
    text: view.text === undefined ? lead : `${lead}\n\n${textBlock(view.text)}`,
    keyboard: withNav(
      new InlineKeyboard().text(retryLabel, view.retry),
      toConsole(view.auctionId),
    ),
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
      toConsole(auctionId),
    ),
    format: "HTML",
  };
}

// Вход — из пульта (PER-802), и возврат — в пульт.
function toConsole(auctionId: string): Parent {
  return { name: "Пульт", data: consoleViewData(uuidToToken(auctionId)) };
}
