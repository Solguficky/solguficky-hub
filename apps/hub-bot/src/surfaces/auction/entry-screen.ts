import { achievementScreen } from "../../achievement-screen.js";
import {
  auctionChronicleParagraphs,
  auctionChronicleTitle,
  dayChronicleButtonLabel,
  dayChronicleParagraphs,
  dayChronicleTitle,
} from "../../auction-day-chronicle.js";
import { renderFaqText } from "../../auction-faq.js";
import {
  finalBidHeadline,
  finalBidLabel,
  finalPriceLines,
  heldProxyAccepted,
  heldProxyConfirmation,
  heldProxyQuestion,
  showsStep,
} from "../../auction-final.js";
import {
  activeHappyHourLine,
  happyHourTerms,
} from "../../auction-happy-hours.js";
import {
  predictionButtonLabel,
  predictionNameChoiceText,
  predictionNumberQuestionText,
  predictionParagraphs,
  predictionRefusalText,
  predictionRoundTitle,
  predictionTitle,
} from "../../auction-prediction.js";
import {
  predictionResultsButtonLabel,
  predictionResultsParagraphs,
  predictionResultsTitle,
} from "../../auction-prediction-results.js";
import {
  auctionStatusLine,
  programmeParagraph,
} from "../../auction-programme.js";
import { promoButtonLabel, promoCaption } from "../../auction-promo.js";
import {
  cancelRegistrationLabel,
  raffleBackName,
  raffleButtonLabel,
  raffleNameChoiceText,
  raffleParagraphs,
  raffleProofLabel,
  raffleProofParagraphs,
  raffleProofTitle,
  raffleRegisteredParagraphs,
  raffleRegisteredTitle,
  raffleRichText,
  raffleTitle,
  registerLabel,
} from "../../auction-raffle.js";
import {
  collectedLine,
  type SetLotOptions,
  setGroupLines,
  setLabel,
  setLotLabel,
  setLotLine,
  setMoreLine,
} from "../../auction-set.js";
import {
  autoFollowNote,
  awaitsFirstBid,
  currentValueLine,
  extensionLine,
  favoritesEmptyText,
  favoritesSummary,
  feedSectionLabel,
  feedSectionTitle,
  feedSummary,
  finalFeedLabel,
  followLabel,
  historyLine,
  leaderLine,
  lotButtonTail,
  lotNextLabel,
  lotPrevLabel,
  lotsLabel,
  nameSettingsParagraphs,
  nameSettingsTitle,
  ownLotLine,
  ownProxyLine,
  proxyHintLead,
  stepBidLabel,
  struckHistoryLine,
  tradingPriceLine,
  unfollowLabel,
} from "../../auction-standing.js";
import {
  type AnswerRefusal,
  type AuctionBlock,
  type AuctionButton,
  type AuctionDenial,
  type AuctionScreenBody,
  type AuctionStageView,
  type CommandResult,
  encodeAuctionCallback,
  type FeedItem,
  type LotStatusView,
  MAX_COMMAND_AMOUNT,
  type Money,
  parseAuctionCallback,
  predictionSpec,
} from "../../auction-ui/index.js";
import {
  invoiceLabel,
  invoiceMissingParagraphs,
  invoiceMissingTitle,
  invoiceParagraphs,
  invoicesBackLabel,
  invoicesButtonLabel,
  invoicesParagraphs,
  invoicesTitle,
  invoiceTitle,
} from "../../auction-winner-invoices.js";
import {
  type LotPhotoKey,
  lotPhotoKeys,
  rafflePrizePhotoKeys,
} from "../../core/auction/lot-photos.js";
import type { Presentation } from "../../core/config.js";
import {
  admittersLine,
  applyLabel,
  menuTitle,
  strayHintText,
  supportBotLink,
  supportLabel,
} from "../../core/entry.js";
import { money, truncate } from "../../core/format.js";
import {
  type AuctionNotificationSettings,
  auctionNotificationsExplanation,
  auctionNotificationsRows,
} from "../../core/notifications/outbid.js";
import {
  confirmNoLabel,
  confirmYesLabel,
  emptyDescription,
  marked,
  pictogram,
  refreshLabel,
} from "../../core/pictograms.js";
import type {
  AuctionListPage,
  AuctionStage,
  AuctionSummary,
} from "./auctions.js";
import {
  applyCallback,
  defaultFaq,
  entryCallback,
  type FaqContent,
  type ListAction,
  listCallback,
  notifyCallback,
} from "./faq.js";
import type { ScreenId } from "./screen-catalog.js";

// Цена и обрезка — общие у двух ботов (`src/core/format.ts`); имена
// остаются здесь для прежних потребителей.
export { money, truncate };

// Оболочка бота аукциона (ADR-044, «Один аукцион, две оболочки»). Экран здесь
// корневой: короткий контекст для пришедшего по пересланной ссылке и тело из
// аукционного дерева. Доступа к хабу он не обещает. Тексты принадлежат этому боту и
// с хабом не делятся, даже когда совпадают.
//
// Общий FAQ, меню и списки аукционов (PER-453) — оболочка. Лента и карточка
// лота — тело аукционного дерева (PER-306), лист ставки — PER-317. Правила экрана
// — дизайн-код (docs/design/bot/design-code.md): жирный заголовок, HTML,
// последний ряд `[‹ Родитель]`, кадр отказа с выходом. Корень один — «Меню»
// (PER-592): «Аукционы» с «Прошедшими» внутри, FAQ и «Настройки» с
// «Уведомлениями» (PER-515) и «Именем в аукционе» (PER-595) — его разделы, их
// же открывают команды. «Избранное» — в корне аукциона (PER-644).
export type AuctionEntryScreen =
  | { kind: "menu" }
  // Приветствие человека без права: заявку ставит только его кнопка.
  | { kind: "welcome"; sourceCode?: string }
  // Подсказка на сообщение вне вопроса (PER-592).
  | { kind: "hint"; openQuestion: boolean }
  | { kind: "faq" }
  // «Настройки» (PER-595): настройки уведомлений аукциона, у бота с
  // Notifications, и имя в идущем аукционе, если такой есть.
  | { kind: "settings"; notifications: boolean; auctionId?: string }
  // `detached` — экран открыт кнопкой вести, а не из «Настроек» (№73).
  | { kind: "notify"; current: AuctionNotificationSettings; detached?: true }
  | { kind: "auctions"; list: AuctionListPage }
  | { kind: "past"; list: AuctionListPage }
  | { kind: "details" }
  | { kind: "question" }
  // `parent` — список, в котором аукцион ленты стоит сейчас: туда ведёт
  // возврат ленты. Карточке и хронологии он не нужен.
  | { kind: "auction"; body: AuctionScreenBody; parent?: ListAction }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "outdated" }
  // `subject` называет недоступный сервис, когда это не аукцион.
  | {
      kind: "unavailable";
      exit: UnavailableExit;
      subject?: "notifications";
      back?: string;
      bidRejected?: true;
    };

// Выход кадра «недоступно». `retry` — «Повторить» с данными действия, на
// котором случился отказ: хранилища у экранов нет, и повтор едет в кнопке.
// `enter` — отказ на `/start` или на «Подать заявку»: повтор несёт то же
// действие с кодом канала, и возврата рядом с ним нет — у человека, которого
// бот ещё не пустил, возвращаться некуда. `answer` — отказ на ответе на вопрос:
// ответ в кнопку не помещается, его присылают ещё раз, а вопрос остаётся
// открытым.
export type UnavailableExit =
  | { kind: "retry"; data: string }
  | { kind: "enter"; data: string }
  | { kind: "answer" };

/** Подпись повтора после сбоя: по ней адаптер узнаёт нажатие под кадром отказа. */
export const retryLabel = "Повторить";

export type TelegramButton =
  | { text: string; callback_data: string; style?: "danger" }
  | { text: string; url: string };

export type RenderedScreen = {
  /** Запись каталога экранов: её метку несёт отправка (`screen-catalog.ts`). */
  id: ScreenId;
  text: string;
  keyboard: readonly (readonly TelegramButton[])[];
  /**
   * Разметка текста: `html` — обычное сообщение с `parse_mode: HTML`, `rich` —
   * rich-сообщение, текст которого — его `html` (ADR-034). Текста без
   * разметки у бота нет.
   */
  format: "html" | "rich";
  // Фото rich-карточки лота в порядке показа: адаптер ставит их первым блоком,
  // несколько — каруселью (PER-721). Байты и `file_id` достаёт адаптер
  // Telegram, экрану достаточно ключей.
  photos?: readonly LotPhotoKey[];
  // Вопрос: адаптер шлёт его новым сообщением с `force_reply` (дизайн-код,
  // «Вопросы»).
  asks?: true;
  // Промо-видео (PER-774): адаптер присылает копию поста чата медиа ботов с
  // текстом подписью новым сообщением, а без `postId` отвечает на нажатие
  // «видео недоступно» и ничего не шлёт.
  promo?: { postId?: number };
};

export type RenderOptions = {
  faq?: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  timeZone: string;
  // Форма карточки лота; по умолчанию `rich`.
  presentation?: Presentation;
  // Момент показа: год в дате называется, когда он не текущий (дизайн-код,
  // «Формат»). По умолчанию часы процесса; тесты передают свой.
  now?: Date;
  // Имя бота поддержки без «@»: кадр ожидания допуска несёт ссылку
  // «Написать в поддержку ↗» (PER-625, ADR-068). Нет — клавиатуры нет.
  supportBotUsername?: string;
};

// Лимит обычного сообщения Bot API — 4096 символов UTF-16 после разбора
// разметки. У rich-сообщения предел 32 768 «символов UTF-8», и единица не
// уточнена: описание режется с запасом, чтобы уложиться и в байты.
export const TEXT_LIMIT = 4096;
export const RICH_TEXT_LIMIT = 10_000;

// Абзацев описания в rich-карточке, дальше они сливаются в один.
const PARAGRAPH_LIMIT = 50;

// Подпись кнопки лота — название и цена в одну строку экрана телефона.
const BUTTON_TITLE_LIMIT = 40;

// Длину названия Auction не ограничивает. Предел держит название заголовком,
// а не полотном над ценой и исходом.
const TITLE_LIMIT = 256;

const untitled = "Лот без названия";

// Тексты отказов принадлежат этой оболочке (ADR-044). `declined` — отказ по
// очереди аукциона (ADR-064, пункт 15). Участнику сообщества бот отвечает
// только переходом, без ссылки: её даёт администратор (ADR-064, пункт 2).
// Первое предложение — жирное: оно кадру отказа вместо заголовка.
export const deniedTexts: Record<AuctionDenial, string> = {
  "not-admitted": `<b>Заявка на рассмотрении.</b> Участие в аукционе пока не открыто. ${admittersLine}`,
  "in-community":
    "<b>Ты уже участник сообщества солегуфиков.</b> Аукционы для тебя — в основном боте сообщества: открой сходку и нажми «🧩 Расширения».",
  declined: "<b>Заявка на участие в аукционе отклонена.</b>",
  blocked: "<b>Доступ к аукциону закрыт.</b>",
};

const faqTitle = "Правила и FAQ";
// Выход кадра, у которого родителя нет, — в корень основного раздела
// «Аукционы» (дизайн-код, «Навигация»).
const toAuctions = {
  text: "‹ Аукционы",
  callback_data: entryCallback("auctions"),
};
// Возврат разделов в корневое меню (PER-592).
const toMenu = {
  text: `‹ ${menuTitle}`,
  callback_data: entryCallback("menu"),
};

// Приветствие человека без права аукциона (PER-592): что за бот, что за
// аукцион и что дальше. Заявку ставит только кнопка под ним.
const welcomeTitle = "Привет! Это бот аукциона сообщества солегуфиков.";
const welcomeParagraphs = [
  "Здесь проходят аукционы сообщества: лоты, ставки и итоги торгов. Торговать могут допущенные участники.",
  `Чтобы участвовать, подай заявку. ${admittersLine} Если заявка уже подана, кнопка покажет, что с ней.`,
];
const notifyTitle = "Уведомления";
const settingsTitle = "Настройки";
const favoritesTitle = "Избранное";
// Корень аукциона (PER-605, PER-644): его заголовок и имя возврата в него.
const rootTitle = "Аукцион";
// Возврат подразделов «Настроек» (PER-595).
const toSettings = {
  text: `‹ ${settingsTitle}`,
  callback_data: entryCallback("settings"),
};
const linkSign = " ↗";

const heading = (text: string) => `<b>${escapeHtml(text)}</b>`;

// Текст экрана (дизайн-код, «Формат»): заголовок, пустая строка, абзацы через
// пустую строку; пустые абзацы выпадают. Над заголовком ничего нет: исход —
// свой экран (PER-472). Абзацы приходят уже экранированными.
function screenText(
  title: string,
  ...paragraphs: (string | undefined)[]
): string {
  return [
    heading(title),
    ...paragraphs.filter(
      (paragraph): paragraph is string =>
        paragraph !== undefined && paragraph !== "",
    ),
  ].join("\n\n");
}

// Экран раздела лота (дизайн-код, «Формат», PER-644): заголовок — имя экрана,
// название лота — строкой ниже курсивом, затем пустая строка и тело. Тот же
// вид, что у подменю сходки в хабе (`submenuText` в `screens/kit.ts`).
function lotSectionText(
  title: string,
  lotTitle: string,
  ...paragraphs: (string | undefined)[]
): string {
  return [
    `${heading(title)}\n<i>${escapeHtml(oneLine(lotTitle))}</i>`,
    ...paragraphs.filter(
      (paragraph): paragraph is string =>
        paragraph !== undefined && paragraph !== "",
    ),
  ].join("\n\n");
}

// Название лота в одну строку: Auction переносы строк в названии не режет, а
// в строке списка и в предмете экрана второй строкой оно читалось бы как чужая
// запись.
const oneLine = (title: string) =>
  truncate(title.replace(/\s+/g, " ").trim(), TITLE_LIMIT);

// Название лота на экранах листа ставки и хронологии — предмет экрана:
// жирный абзац без кавычек (дизайн-код, «Формат»; PER-594).
const lotSubject = (title: string | undefined) =>
  title === undefined ? undefined : `<b>${escapeHtml(oneLine(title))}</b>`;

// Строка списка в теле (дизайн-код, «Списки»): маркер, затем поля через «—».
const bullet = (line: string) => `• ${line}`;

// Слово организаторов на корневом меню бота аукциона (решение владельца
// 24.10.2026): абзацы текста, без разметки; ники уходят как есть.
export const auctionMenuIntro = [
  "@solguficky_auction_bot — бот для проведения бустигуфиковских аукционов.\nКнопки меню помогут открыть каталог лотов, сделать ставку, посмотреть свои ставки и заглянуть в FAQ.",
  "Данный бот разработан: @anticnvm\nАвторы лотов: @Nilda97 @NyanQT314 @myasko18 @DrScarecrow @Neptunini\nОтдельная благодарность: @po_darya",
] as const;

export function renderEntryScreen(
  screen: AuctionEntryScreen,
  options: RenderOptions,
): RenderedScreen {
  const faq = options.faq ?? defaultFaq;
  switch (screen.kind) {
    // Корневое меню: разделы кнопками в порядке списка команд, возврата нет.
    // Под заголовком — слово организаторов о боте (решение владельца
    // 24.10.2026), а не служебная строка о разделах.
    case "menu":
      return {
        id: "menu",
        format: "html",
        text: screenText(menuTitle, ...auctionMenuIntro),
        keyboard: [
          [{ text: "Аукционы", callback_data: entryCallback("auctions") }],
          [
            {
              text: "Ачивки",
              callback_data: encodeAuctionCallback({
                kind: "achievements",
                page: 0,
              }),
            },
          ],
          [{ text: settingsTitle, callback_data: entryCallback("settings") }],
          [{ text: faqTitle, callback_data: entryCallback("faq") }],
        ],
      };
    // «Настройки» — раздел под меню (PER-595): частота «перебили» и имя в
    // идущем аукционе. Нет ни того, ни другого — текст говорит, что
    // настраивать пока нечего.
    case "settings": {
      const rows = [
        ...(screen.notifications
          ? [[{ text: notifyTitle, callback_data: notifyCallback() }]]
          : []),
        ...(screen.auctionId === undefined
          ? []
          : [
              [
                {
                  text: nameSettingsTitle,
                  callback_data: encodeAuctionCallback({
                    kind: "name",
                    auctionId: screen.auctionId,
                  }),
                },
              ],
            ]),
      ];
      return {
        id: "settings",
        format: "html",
        text: screenText(
          settingsTitle,
          settingsText(screen.notifications, screen.auctionId !== undefined),
        ),
        keyboard: [...rows, [toMenu]],
      };
    }
    case "welcome":
      return {
        id: "welcome",
        format: "html",
        text: screenText(welcomeTitle, ...welcomeParagraphs.map(escapeHtml)),
        keyboard: [
          [
            {
              text: applyLabel,
              callback_data: applyCallback(screen.sourceCode),
            },
          ],
        ],
      };
    case "hint": {
      const hint = strayHintText(screen.openQuestion);
      return {
        id: "hint",
        format: "html",
        text: `${heading(hint.lead)} ${escapeHtml(hint.rest)}`,
        keyboard: [[toMenu]],
      };
    }
    case "faq": {
      return {
        id: "faq",
        format: "html",
        text: renderFaqText(faq),
        keyboard: [
          // «Прочитать подробнее» — только со ссылкой организатора: полный
          // текст FAQ уже в сообщении, а без адреса кнопка вела бы в кадр
          // «ссылки нет» (решение владельца 24.10.2026).
          ...(faq.detailsUrl === undefined
            ? []
            : [
                [
                  {
                    text: `Прочитать подробнее${linkSign}`,
                    url: faq.detailsUrl,
                  },
                ],
              ]),
          [
            faq.questionUrl === undefined
              ? {
                  text: "Задать вопрос",
                  callback_data: entryCallback("question"),
                }
              : { text: `Задать вопрос${linkSign}`, url: faq.questionUrl },
          ],
          // «Аукционы» под FAQ — единственная кнопка, которая ставит отметку
          // ознакомления, и открывает список аукционов; последний ряд —
          // возврат в меню (PER-592).
          [{ text: "Аукционы", callback_data: entryCallback("read") }],
          [toMenu],
        ],
      };
    }
    // Настройки уведомлений аукциона (PER-515, PER-539, PER-645): каждая
    // настройка — одна кнопка с текущим значением, нажатие ведёт к
    // следующему (№72): частота «перебили» по кругу пяти режимов,
    // «Перебили в финале» и анонс финала — вкл и выкл. Выбор отменяется с
    // того же экрана, поэтому подтверждения «Да» у него нет: что сработало,
    // говорит ответ на нажатие. Экран — подраздел «Настроек»: последний ряд —
    // «‹ Настройки» (PER-595). Открытый кнопкой вести экран возврата в
    // дерево не несёт: человек пришёл из вести, и она остаётся выше в чате
    // (№73 прогона 14 октября 2026 года). Выбор на нём держит тот же вид.
    case "notify": {
      const detached = screen.detached === true;
      const rows = auctionNotificationsRows(screen.current).map((row) => [
        { text: row.text, callback_data: notifyCallback(row.change, detached) },
      ]);
      return {
        id: detached ? "notify-notice" : "notify",
        format: "html",
        text: screenText(notifyTitle, ...auctionNotificationsExplanation),
        keyboard: detached ? rows : [...rows, [toSettings]],
      };
    }
    case "auctions":
    case "past":
      return renderList(screen.kind, screen.list, options);
    // Состояния FAQ, а не узлы: возврат из них ведёт в FAQ.
    case "details":
      return faqState(
        "details",
        "Организатор ещё не указал ссылку на подробные правила.",
      );
    case "question":
      return faqState(
        "question",
        "Организатор ещё не указал, куда направлять вопросы.",
      );
    case "auction": {
      const body = renderBody(screen.body, options);
      // Подтверждение и вопрос несут только свои ряды: «Да» и «Нет», «Отмена».
      if (body.asks === true || isConfirm(body.id)) return body;
      // Имя в аукционе — подраздел «Настроек» (PER-595): возврат ставит
      // оболочка, у хаба родитель другой.
      if (body.id === "name-settings") {
        return { ...body, keyboard: [...body.keyboard, [toSettings]] };
      }
      // Родителя корня аукциона тело не знает: возврат в список, где аукцион
      // стоит сейчас, ставит оболочка. Лента, розыгрыш и избранное
      // возвращают в корень сами (PER-644).
      if (body.id === "root") {
        const parent = screen.parent ?? "auctions";
        return {
          ...body,
          keyboard: [
            ...body.keyboard,
            [
              {
                text: `‹ ${listTexts[parent].backName}`,
                callback_data: entryCallback(parent),
              },
            ],
          ],
        };
      }
      // Лот, хронология, выбор имени и исходы: возврат — последний ряд тела,
      // и ряд навигации им и кончается.
      return body;
    }
    // Кадры ожидания допуска, блокировки и перехода в бот хаба в дерево не
    // входят: экранов за ними у человека здесь нет. Кнопка-ссылка в бот
    // поддержки есть только у ожидания и только когда её адрес задан (PER-625,
    // ADR-068): «?start=auction» говорит боту поддержки, откуда человек.
    case "denied": {
      const support =
        screen.reason === "not-admitted" &&
        options.supportBotUsername !== undefined
          ? [
              [
                {
                  text: supportLabel,
                  url: supportBotLink(options.supportBotUsername, "auction"),
                },
              ],
            ]
          : [];
      return {
        id:
          screen.reason === "in-community"
            ? "in-community"
            : support.length === 0
              ? "denied"
              : "denied-support",
        format: "html",
        text: deniedTexts[screen.reason],
        keyboard: support,
      };
    }
    case "outdated":
      return {
        id: "outdated",
        format: "html",
        text: "<b>Этот экран устарел.</b> Открой аукционы и повтори действие.",
        keyboard: [[toAuctions]],
      };
    case "unavailable": {
      const { exit } = screen;
      const retry = (data: string) => ({
        text: retryLabel,
        callback_data: data,
      });
      return {
        id: "unavailable",
        format: "html",
        text: `<b>${
          screen.bidRejected === true
            ? "Аукцион недоступен, ставка не принята."
            : screen.subject === "notifications"
              ? "Настройка уведомлений сейчас недоступна."
              : "Аукцион сейчас недоступен."
        }</b> ${exit.kind === "answer" ? "Пришли ответ ещё раз через минуту." : "Попробуй ещё раз через минуту."}`,
        // Сбой самих «Аукционов» несёт только повтор: возврат вёл бы туда же.
        keyboard: [
          exit.kind === "retry"
            ? exit.data === toAuctions.callback_data
              ? [retry(exit.data)]
              : [
                  retry(exit.data),
                  screen.back === undefined
                    ? toAuctions
                    : { text: "‹ Аукцион", callback_data: screen.back },
                ]
            : exit.kind === "enter"
              ? [retry(exit.data)]
              : [toAuctions],
        ],
      };
    }
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
}

// Пояснение «Настроек» называет только пункты, которые на экране есть.
function settingsText(notifications: boolean, name: boolean): string {
  if (notifications && name) {
    return "Уведомления о торгах и имя, под которым ты ставишь в идущем аукционе.";
  }
  if (notifications) {
    return "Уведомления о торгах. Имя в аукционе появится здесь, когда пойдёт аукцион.";
  }
  if (name) return "Имя, под которым ты ставишь в идущем аукционе.";
  return "Настраивать пока нечего: имя выбирается, когда идёт аукцион.";
}

function faqState(id: "details" | "question", text: string): RenderedScreen {
  return {
    id,
    format: "html",
    text: screenText(faqTitle, text),
    keyboard: [[{ text: "‹ FAQ", callback_data: entryCallback("faq") }]],
  };
}

const listTexts: Record<
  ListAction,
  { title: string; backName: string; empty: string }
> = {
  auctions: {
    title: "Аукционы",
    backName: "Аукционы",
    empty: "Активных аукционов сейчас нет.",
  },
  past: {
    title: "Прошедшие аукционы",
    backName: "Прошедшие",
    empty: "Прошедших аукционов пока нет.",
  },
};

// Список аукционов по дизайн-коду: жирный заголовок с номером страницы, строка
// на аукцион в теле и ряд на аукцион в клавиатуре, листание стрелками.
// «Аукционы» — раздел под меню: последним рядом содержимого — «Прошедшие»,
// история внутри основного раздела, как «Архив» под «Сходками» хаба, а
// последний ряд — «‹ Меню». «Прошедшие» возвращают в «Аукционы» (PER-592).
// Пустой список говорит об этом текстом, и выход у него тот же.
function renderList(
  kind: ListAction,
  list: AuctionListPage,
  options: RenderOptions,
): RenderedScreen {
  const { title, empty } = listTexts[kind];
  const paging = [
    ...(list.page > 0
      ? [{ text: "←", callback_data: listCallback(kind, list.page - 1) }]
      : []),
    ...(list.page < list.pageCount - 1
      ? [{ text: "→", callback_data: listCallback(kind, list.page + 1) }]
      : []),
  ];
  return {
    id: kind,
    format: "html",
    text: screenText(
      paged(title, list),
      list.auctions.length === 0
        ? empty
        : list.auctions
            .map((auction) => {
              // Строка состояния (PER-767) — под строкой аукциона, текст
              // общий с хабом.
              const status =
                auction.week === undefined
                  ? undefined
                  : auctionStatusLine(auction.week, {
                      timeZone: options.timeZone,
                      now: options.now ?? new Date(),
                    });
              const line = bullet(
                auctionLine(auction, options.timeZone, options.now),
              );
              return status === undefined
                ? line
                : `${line}\n${escapeHtml(status)}`;
            })
            .join("\n"),
    ),
    keyboard: [
      ...list.auctions.map((auction) => [
        {
          text: auctionLabel(auction, options.timeZone, options.now),
          // Аукцион открывается корнем, как в хабе (PER-644): лоты, розыгрыш
          // и избранное — за ним.
          callback_data: encodeAuctionCallback({
            kind: "root",
            auctionId: auction.auctionId,
          }),
        },
      ]),
      ...(kind === "auctions"
        ? [
            [
              {
                // История выделена знаком, как «Архив» хаба (прогон 14.10, №84).
                text: marked(pictogram.history, listTexts.past.backName),
                callback_data: entryCallback("past"),
              },
            ],
          ]
        : []),
      ...(paging.length === 0 ? [] : [paging]),
      [kind === "auctions" ? toMenu : toAuctions],
    ],
  };
}

// Номер страницы стоит в заголовке (дизайн-код, «Клавиатура»); у единственной
// страницы его нет.
function paged(title: string, at: { page: number; pageCount: number }): string {
  return at.pageCount === 1
    ? title
    : `${title} · ${at.page + 1} из ${at.pageCount}`;
}

// Подпись кнопки аукциона: день начала онлайн-фазы, этап и число лотов.
export function auctionLabel(
  auction: AuctionSummary,
  timeZone: string,
  now?: Date,
): string {
  return [
    auctionDay(auction, timeZone, now),
    stageLabels[auction.stage],
    lotCount(auction.lotCount),
  ].join(" · ");
}

// Строка аукциона в теле списка: те же поля, день отделён от остального «—».
// Отсчёт до финала стоит хвостом только здесь, кнопка остаётся короткой
// (дизайн-код, «Списки аукционов и лента лотов»). День подписан — это начало
// онлайн-торгов, — а этап и отсчёт до финала выделены (PER-595).
export function auctionLine(
  auction: AuctionSummary,
  timeZone: string,
  now?: Date,
): string {
  const finale = finaleCountdown(auction, timeZone, now);
  const day =
    auction.opensAt === undefined
      ? auctionDay(auction, timeZone, now)
      : `Торги с ${auctionDay(auction, timeZone, now)}`;
  return `${day} — <b>${stageLabels[auction.stage]}</b>, ${lotCount(auction.lotCount)}${finale === undefined ? "" : `, <b>${finale}</b>`}`;
}

// Отсчёт до финала (PER-518): день финала — день общего дедлайна лотов в поясе
// сообщества, как «00:00 дня финала» у пульта. До него — «до финала N дней», в
// сам день — «финал сегодня», после — ничего. Без дедлайна и у завершённого
// аукциона отсчёта нет.
function finaleCountdown(
  auction: AuctionSummary,
  timeZone: string,
  now?: Date,
): string | undefined {
  if (
    auction.closesAt === undefined ||
    auction.stage === "finished" ||
    auction.stage === "cancelled"
  ) {
    return undefined;
  }
  const days =
    communityDayNumber(new Date(auction.closesAt), timeZone) -
    communityDayNumber(now ?? new Date(), timeZone);
  if (days < 0) return undefined;
  if (days === 0) return "финал сегодня";
  return `до финала ${days} ${plural(days, ["день", "дня", "дней"])}`;
}

// Номер дня сообщества от эпохи: разница двух номеров — число календарных
// суток в поясе, и перевод часов её не сдвигает.
function communityDayNumber(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((each) => each.type === type)?.value);
  const day = Date.UTC(part("year"), part("month") - 1, part("day"));
  // Непонятный ответ `Intl` — отказ, а не молча пропавший отсчёт.
  if (Number.isNaN(day)) {
    throw new Error(`cannot read the community day in ${timeZone}`);
  }
  return day / 86_400_000;
}

function auctionDay(
  auction: AuctionSummary,
  timeZone: string,
  now?: Date,
): string {
  return auction.opensAt === undefined
    ? "Без онлайн-торгов"
    : readableDay(auction.opensAt, timeZone, now);
}

const stageLabels: Record<AuctionStage, string> = {
  scheduled: "скоро старт",
  prebidding: "идут ставки",
  settling: "подводим итоги",
  "on-break": "перерыв",
  "lineup-frozen": "готовим финал",
  "in-final": "идёт финал",
  finished: "завершён",
  cancelled: "отменён",
};

function lotCount(count: number): string {
  return `${count} ${plural(count, ["лот", "лота", "лотов"])}`;
}

// Форма слова при числе: «1 лот», «3 лота», «5 лотов», «11 лотов».
function plural(
  count: number,
  [one, few, many]: readonly [string, string, string],
): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

// День для чтения по дизайн-коду, без времени: «12 октября, сб»; чужой год
// называется — «12 октября 2027, сб».
function readableDay(instant: string, timeZone: string, now?: Date): string {
  const parts = dateParts(instant, timeZone);
  return `${parts("day")} ${parts("month")}${yearOf(instant, timeZone, now)}, ${parts("weekday")}`;
}

function dateParts(
  instant: string,
  timeZone: string,
): (type: Intl.DateTimeFormatPartTypes) => string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return (type) => parts.find((each) => each.type === type)?.value ?? "";
}

// Год стоит в дате, только когда он не совпадает с годом момента показа в
// поясе сообщества: в текущем году он шум, в чужом — без него дата врёт.
function yearOf(instant: string, timeZone: string, now?: Date): string {
  const year = (at: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(at);
  const shown = year(new Date(instant));
  return shown === year(now ?? new Date()) ? "" : ` ${shown}`;
}

function renderBody(
  body: AuctionScreenBody,
  options: RenderOptions,
): RenderedScreen {
  const achievements = body.blocks.find(
    (block) => block.kind === "achievements",
  );
  if (achievements !== undefined) {
    const shown = achievementScreen(achievements.screen, {
      rich: options.presentation !== "plain",
      timeZone: options.timeZone,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return {
      ...shown,
      format: options.presentation === "plain" ? "html" : "rich",
      ...(options.presentation === "plain" ? { photos: [] } : {}),
    };
  }
  const items = new Map<string, FeedItem>();
  for (const block of body.blocks) {
    if (
      block.kind === "feed" ||
      block.kind === "favorites" ||
      block.kind === "set"
    ) {
      for (const item of block.lots) items.set(item.lotId, item);
    }
  }
  const keyboard = body.keyboard.map((row) =>
    row.map((button) => renderButton(button, items, body.blocks)),
  );
  const id = screenOf(body.blocks);
  const leaf = renderLeaf(body.blocks, options);
  if (leaf !== undefined) return { id, keyboard, ...leaf };
  const root = body.blocks.find(
    (block): block is RootBlock => block.kind === "root",
  );
  if (id === "root" && root !== undefined) {
    return { id, keyboard, format: "html", text: rootText(root, options) };
  }
  const lot = body.blocks.find(
    (block): block is LotBlock => block.kind === "lot",
  );
  if (id === "lot" && lot !== undefined) {
    return { id, keyboard, ...renderCard(lot, options) };
  }
  const history = body.blocks.find(
    (block): block is HistoryBlock => block.kind === "history",
  );
  if (id === "history" && history !== undefined) {
    return { id, keyboard, ...renderHistory(history, options) };
  }
  const favorites = body.blocks.find(
    (block): block is FavoritesBlock => block.kind === "favorites",
  );
  if (id === "favorites" && favorites !== undefined) {
    return { id, keyboard, ...renderFavorites(favorites, options) };
  }
  const set = body.blocks.find(
    (block): block is SetBlock => block.kind === "set",
  );
  if (id === "set" && set !== undefined) {
    return { id, keyboard, ...renderSet(set) };
  }
  const feed = body.blocks.find(
    (block): block is FeedBlock => block.kind === "feed",
  );
  if (feed === undefined) {
    throw new Error("auction body without a feed, a lot or a history block");
  }
  // Пустая лента несёт заголовок так же, как заполненная. Текст не повторяет
  // кнопки: в нём сводка своих лотов — где смотрящий лидер и что он купил
  // (PER-595), а все лоты — кнопками в порядке ленты.
  return {
    id,
    keyboard,
    format: "html",
    text: screenText(
      paged(
        feed.section === undefined
          ? "Лоты"
          : feedSectionTitle(feed.section.name),
        feed,
      ),
      // Пустой общий список при заполненных разделах — не пустой аукцион
      // (PER-719): сводка своих лотов остаётся.
      ...(feed.lots.length === 0 && (feed.sections?.length ?? 0) === 0
        ? ["Лотов пока нет."]
        : feedSummary(feed, mineOptions)),
    ),
  };
}

// Строка своего лота в сводке: название и цена, как у строки ленты.
const mineOptions = {
  title: (item: FeedItem) => escapeHtml(oneLine(item.title ?? untitled)),
  price: (item: FeedItem) =>
    `${priceLabel(item.status)}${item.activeWindow === undefined ? "" : ", счастливые часы"}`,
};

// Запись каталога для тела: тело с карточкой — экран лота, с лентой — лента.
// Новый вид блока не становится лентой молча: без своей ветки он не собирается.
function screenOf(blocks: readonly AuctionBlock[]): ScreenId {
  let screen: ScreenId = "feed";
  for (const block of blocks) {
    switch (block.kind) {
      case "achievements":
        return achievementScreen(block.screen).id;
      case "root":
        return "root";
      case "lot":
        screen = "lot";
        break;
      case "history":
        screen = "history";
        break;
      case "favorites":
        screen = "favorites";
        break;
      case "set":
        screen = "set";
        break;
      case "follow-refused":
        return "follow-refused";
      case "confirm":
        return block.command === "bid" ? "bid-confirm" : "proxy-confirm";
      case "accepted":
        return block.command === "bid" ? "bid-accepted" : "proxy-accepted";
      case "question":
        return `${block.question}-question`;
      case "name-choice":
        return "name-choice";
      case "result":
        return "command-result";
      case "answer-refused":
      case "raffle-answer-refused":
        return "answer-refused";
      case "prediction-results":
        return "prediction-results";
      case "day-chronicle":
        return "day-chronicle";
      case "auction-chronicle":
        return "auction-chronicle";
      case "promo":
        return "promo";
      case "raffle":
        return "raffle";
      case "raffle-registered":
        return "raffle-registered";
      case "raffle-proof":
        return "raffle-proof";
      // Счета победителя (PER-322).
      case "invoices":
        return "invoices";
      case "invoice":
        return "invoice";
      case "invoice-missing":
        return "invoice-missing";
      case "raffle-name-choice":
        return "raffle-name-choice";
      case "raffle-question":
      case "name-question":
        return "alias-question";
      case "prediction":
        return "predictions";
      case "prediction-lots":
        return "prediction-lots";
      case "prediction-number-question":
        return "prediction-number-question";
      case "prediction-name-choice":
        return "prediction-name-choice";
      case "prediction-alias-question":
        return "prediction-alias-question";
      case "prediction-answer-refused":
        return "prediction-answer-refused";
      case "name-settings":
        return "name-settings";
      case "name-answer-refused":
        return "answer-refused";
      case "feed":
        // Раздел ленты (PER-719) — свой экран с возвратом к списку разделов.
        if (block.section !== undefined) screen = "feed-section";
        break;
      default: {
        const _exhaustive: never = block;
        return _exhaustive;
      }
    }
  }
  return screen;
}

type LotBlock = Extract<AuctionBlock, { kind: "lot" }>;
type RootBlock = Extract<AuctionBlock, { kind: "root" }>;
type SetBlock = Extract<AuctionBlock, { kind: "set" }>;

// Стадия корня аукциона: черновика этот бот не получает, но слово для него
// есть — перевод полон по стадиям.
const rootStages: Record<AuctionStageView, string> = {
  draft: "Аукцион готовится.",
  scheduled: "Скоро старт.",
  prebidding: "Идут ставки.",
  settling: "Подводим итоги.",
  "on-break": "Перерыв перед финалом.",
  "lineup-frozen": "Готовим финал.",
  "in-final": "Идёт финал.",
  finished: "Аукцион завершён.",
  cancelled: "Аукцион отменён: проданные лоты остались проданными.",
};

function rootText(block: RootBlock, options: RenderOptions): string {
  const { auction } = block;
  if (auction === undefined) {
    return screenText(rootTitle, "Этого аукциона больше нет.");
  }
  const day = (instant: string) =>
    readableDay(instant, options.timeZone, options.now);
  const online =
    auction.opensAt === undefined
      ? undefined
      : auction.closesAt === undefined
        ? `Онлайн-торги — с ${day(auction.opensAt)}.`
        : `Онлайн-торги — с ${day(auction.opensAt)} до ${day(auction.closesAt)}.`;
  return screenText(
    rootTitle,
    [
      rootStages[auction.stage],
      ...(online === undefined ? [] : [online]),
      // Отменённый аукцион финала уже не проведёт (PER-606).
      ...(auction.final && auction.stage !== "cancelled"
        ? ["После них — финал в зале."]
        : []),
    ].join("\n"),
    // Программа недели (PER-724) — абзацем под сроками, текст общий с хабом.
    programmeParagraph(block, {
      moment: (instant) =>
        readableMoment(instant, options.timeZone, options.now),
      timeZone: options.timeZone,
      now: options.now ?? new Date(),
    }),
  );
}

function isConfirm(id: ScreenId): boolean {
  return id === "bid-confirm" || id === "proxy-confirm";
}
type HistoryBlock = Extract<AuctionBlock, { kind: "history" }>;
type FeedBlock = Extract<AuctionBlock, { kind: "feed" }>;
type FavoritesBlock = Extract<AuctionBlock, { kind: "favorites" }>;

// Экраны листа ставки (PER-317): подтверждение, исход, вопрос и выбор имени. Тексты
// принадлежат оболочке; слова — те же, что у бота хаба, словарь один.
function renderLeaf(
  blocks: readonly AuctionBlock[],
  options: RenderOptions,
):
  | Pick<RenderedScreen, "text" | "format" | "asks" | "photos" | "promo">
  | undefined {
  for (const block of blocks) {
    switch (block.kind) {
      // Промо-видео (PER-774): текст — подпись копии поста, слова общие с
      // хабом.
      case "promo":
        return {
          format: "html",
          text: screenText(promoCaption),
          promo: block.postId === undefined ? {} : { postId: block.postId },
        };
      case "confirm":
        return { format: "html", text: confirmText(block) };
      case "accepted":
        return {
          format: "html",
          text: acceptedText(block, options.timeZone),
        };
      case "result":
        return {
          format: "html",
          text: outcomeText(resultOutcome(block.result), block.title),
        };
      case "answer-refused":
        return {
          format: "html",
          text: outcomeText(answerRefusals[block.refusal], block.title),
        };
      // Notifications ещё не знает лот: факт аукциона не дошёл до него.
      case "follow-refused":
        return {
          format: "html",
          text: outcomeText(
            {
              title: "Лот пока нельзя добавить в избранное",
              detail: "Попробуй ещё раз через минуту.",
            },
            block.title,
          ),
        };
      case "question":
        return { format: "html", text: questionText(block), asks: true };
      case "name-choice":
        return { format: "html", text: nameChoiceText(block) };
      case "raffle-name-choice":
        return {
          format: "html",
          text: screenText(
            "Имя в аукционе",
            raffleNameChoiceText(block.username),
          ),
        };
      // Счета победителя (PER-322): тексты общие с хабом.
      case "invoices":
        return {
          format: "html",
          text: screenText(
            invoicesTitle,
            ...invoicesParagraphs(block, {
              moment: (instant) =>
                readableMoment(instant, options.timeZone, options.now),
            }),
          ),
        };
      case "invoice":
        return {
          format: "html",
          text: screenText(
            invoiceTitle(block),
            ...invoiceParagraphs(block, {
              moment: (instant) =>
                readableMoment(instant, options.timeZone, options.now),
            }),
          ),
        };
      case "invoice-missing":
        return {
          format: "html",
          text: screenText(invoiceMissingTitle, ...invoiceMissingParagraphs()),
        };
      // Розыгрыш среди участников (ADR-066): тексты общие с хабом.
      case "prediction-results":
        return {
          format: "html",
          text: screenText(
            predictionResultsTitle,
            ...predictionResultsParagraphs(block, { money }),
          ),
        };
      // Хроники дня (PER-725): тексты общие с хабом.
      case "day-chronicle":
        return {
          format: "html",
          text: screenText(
            dayChronicleTitle,
            ...dayChronicleParagraphs(block, { money }),
          ),
        };
      // Статистика аукциона (PER-770): тексты общие с хабом.
      case "auction-chronicle":
        return {
          format: "html",
          text: screenText(
            auctionChronicleTitle,
            ...auctionChronicleParagraphs(block, { money }),
          ),
        };
      case "raffle": {
        const paragraphs = raffleParagraphs(block.raffle, {
          moment: (instant) =>
            readableMoment(instant, options.timeZone, options.now),
        });
        // Приз с фото (PER-773) — rich-сообщение, фото над заголовком ставит
        // адаптер, как у карточки лота; в `plain` фото нет.
        const photos =
          (options.presentation ?? "rich") === "rich"
            ? rafflePrizePhotoKeys(block.raffle)
            : [];
        return photos.length === 0
          ? { format: "html", text: screenText(raffleTitle, ...paragraphs) }
          : {
              format: "rich",
              text: raffleRichText(raffleTitle, paragraphs),
              photos,
            };
      }
      case "raffle-registered":
        return {
          format: "html",
          text: screenText(
            raffleRegisteredTitle,
            ...raffleRegisteredParagraphs(block.raffle, {
              moment: (instant) =>
                readableMoment(instant, options.timeZone, options.now),
            }),
          ),
        };
      case "raffle-proof":
        return {
          format: "html",
          text: screenText(
            raffleProofTitle,
            ...raffleProofParagraphs(block.raffle),
          ),
        };
      case "prediction":
        return {
          format: "html",
          text: screenText(
            predictionTitle,
            ...predictionParagraphs(block, {
              moment: (instant) =>
                readableMoment(instant, options.timeZone, options.now),
              money,
            }),
          ),
        };
      case "prediction-lots": {
        const nomination = predictionSpec(block.nomination);
        const current =
          block.currentTitle === undefined
            ? undefined
            : `Сейчас выбрано: ${escapeHtml(oneLine(block.currentTitle))}`;
        return {
          format: "html",
          text: screenText(
            paged("Выбрать лот", block),
            `${nomination.number} · ${escapeHtml(nomination.question)}`,
            current,
            block.lots.length === 0
              ? "В этом раунде пока нет доступных лотов."
              : block.lots
                  .map(
                    (lot) =>
                      `• ${escapeHtml(oneLine(lot.title ?? untitled))} — ${priceLabel(lot.status)}`,
                  )
                  .join("\n"),
          ),
        };
      }
      case "prediction-number-question":
        return {
          format: "html",
          text: screenText(
            predictionSpec(block.nomination).question,
            ...predictionNumberQuestionText(block, money),
          ),
          asks: true,
        };
      case "prediction-name-choice":
        return {
          format: "html",
          text: screenText(
            nameSettingsTitle,
            predictionNameChoiceText(block.username),
          ),
        };
      case "prediction-alias-question":
        return { format: "html", text: aliasQuestionText(), asks: true };
      case "prediction-answer-refused": {
        const refusal = predictionRefusalText(block.refusal);
        return {
          format: "html",
          text: screenText(refusal.title, refusal.detail),
        };
      }
      case "raffle-question":
      case "name-question":
        return { format: "html", text: aliasQuestionText(), asks: true };
      case "raffle-answer-refused":
      case "name-answer-refused":
        return {
          format: "html",
          text: outcomeText(answerRefusals[block.refusal], undefined),
        };
      // Имя в аукционе из настроек (PER-595): тексты общие с хабом.
      case "name-settings":
        return {
          format: "html",
          text: screenText(
            nameSettingsTitle,
            ...nameSettingsParagraphs(block.name, block.username),
          ),
        };
      default:
        break;
    }
  }
  return undefined;
}

// Подтверждение (дизайн-код, «Подтверждение»): заголовок-вопрос с суммой,
// название лота жирным, затем что нельзя отменить.
function confirmText(
  block: Extract<AuctionBlock, { kind: "confirm" }>,
): string {
  return block.command === "bid"
    ? screenText(
        `Поставить ${money(block.amount)}?`,
        lotSubject(block.title),
        "Отменить ставку нельзя.",
      )
    : screenText(
        `Включить автоставку до ${money(block.amount)}?`,
        lotSubject(block.title),
        `${block.forFinal === true ? heldProxyConfirmation(block.currentPrice, block.amount, money) : proxyGap(block.currentPrice, block.amount, block.firstBid)}\nЛимит видишь только ты.`,
      );
}

// Принятая команда — свой экран (PER-473): сумма в заголовке, карточку с
// новой ценой открывает «‹ Лот», ленту — «‹ Лоты» (PER-595). У бота с
// избранным экран говорит, что ставка кладёт лот туда сама (ADR-063), если
// лота там не было, а продление анти-снайпом называет новый дедлайн
// (PER-631, №107).
function acceptedText(
  block: Extract<AuctionBlock, { kind: "accepted" }>,
  timeZone: string,
): string {
  const note = block.favorites === true ? autoFollowNote : undefined;
  const extension =
    block.extension === undefined
      ? undefined
      : extensionLine(block.extension, timeZone);
  return block.command === "bid"
    ? screenText(
        `Ставка ${money(block.amount)} принята`,
        lotSubject(block.title),
        extension,
        note,
      )
    : screenText(
        `Автоставка до ${money(block.amount)} включена`,
        lotSubject(block.title),
        block.forFinal === true
          ? `${heldProxyAccepted}\nЛимит видишь только ты.`
          : "Лимит видишь только ты.",
        extension,
        note,
      );
}

function questionText(
  block: Extract<AuctionBlock, { kind: "question" }>,
): string {
  // Вопрос (дизайн-код, «Вопросы»): под заголовком одним абзацем — что
  // прислать, подписанное текущее значение (PER-595) и образец. Непринятый
  // ответ — свой экран.
  const current = () =>
    currentValueLine(
      block.current === undefined
        ? undefined
        : {
            amount: money(block.current),
            limit: block.currentIsLimit === true,
          },
    );
  switch (block.question) {
    case "bid":
      return screenText(
        "Своя сумма",
        ["Пришли сумму ставки в рублях.", ...current(), "Например: 1 500"].join(
          "\n",
        ),
      );
    case "proxy":
      return screenText(
        "Автоставка",
        block.explainer === undefined
          ? undefined
          : proxyExplainer(block.explainer),
        [
          block.forFinal === true
            ? heldProxyQuestion
            : "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
          ...current(),
          // Подсказка уже несёт пример с ценой этого лота: второй, общий,
          // с ним расходится.
          ...(block.explainer === undefined ? ["Например: 3 000"] : []),
        ].join("\n"),
      );
    case "alias":
      return aliasQuestionText();
    default: {
      const _exhaustive: never = block.question;
      return _exhaustive;
    }
  }
}

function aliasQuestionText(): string {
  return screenText(
    "Псевдоним",
    [
      "Пришли псевдоним до 32 символов. Участники увидят его со звёздочкой.",
      "Например: Сова",
    ].join("\n"),
  );
}

function nameChoiceText(block: { username?: string }): string {
  return screenText(
    "Имя в аукционе",
    [
      "Имя видно всем участникам аукциона рядом с твоими ставками. После первой ставки его не поменять.",
      block.username === undefined
        ? "Ника в Telegram у тебя нет: возьми псевдоним."
        : `Ставь под ником @${escapeHtml(block.username)} или возьми псевдоним.`,
    ].join("\n"),
  );
}

// Пояснение автоставки голосом помощника (PER-517, RFC-007): платишь цену, а
// не лимит. Пример — на этом лоте: цена сейчас, шаг и лимит на три шага выше.
// Не лидеру бот сразу ставит порог, который посчитал Auction, лидеру — ничего;
// ответов по шагам пример не расписывает: у ступенчатого лота шаг на
// следующей цене другой. Текст тот же, что у бота хаба.
function proxyExplainer(
  explainer: NonNullable<
    Extract<AuctionBlock, { kind: "question" }>["explainer"]
  >,
): string {
  const lines = [proxyHintLead];
  const { example } = explainer;
  if (example !== undefined) {
    const price = money(example.currentPrice);
    const limit = money(example.limit);
    lines.push(
      example.firstBid === undefined
        ? `Например: цена сейчас ${price} — твоя, шаг ${money(example.step)}, твой лимит ${limit}. Бот будет отвечать на чужие ставки, но не выше ${limit}. Никто не перебьёт — заплатишь ${price}, а не ${limit}.`
        : `Например: цена сейчас ${price}, шаг ${money(example.step)}, твой лимит ${limit}. Бот сразу поставит за тебя ${money(example.firstBid)} и будет отвечать на чужие ставки, но не выше ${limit}. Никто не перебьёт — заплатишь ${money(example.firstBid)}, а не ${limit}.`,
    );
  }
  return lines.join("\n");
}

// Автоставка объясняется разницей цены и лимита (RFC-007): на столько бот
// может поднять цену за человека, перебивая чужие ставки по шагу.
// У лота без ставок автоставка сразу ставит стартовую цену (П-01), даже
// лимитом, равным ей: подтверждение говорит о первой ставке прямо.
function proxyGap(
  currentPrice: Money,
  limit: Money,
  firstBid: Money | undefined,
): string {
  if (firstBid !== undefined) {
    return `Ставок ещё нет: бот сразу поставит за тебя ${money(firstBid)} и будет перебивать чужие ставки по шагу, но не выше ${money(limit)}.`;
  }
  const gap = limit.minorUnits - currentPrice.minorUnits;
  return gap > 0
    ? `Цена сейчас ${money(currentPrice)}: бот будет перебивать чужие ставки по шагу и поднимет её не больше чем на ${money({ minorUnits: gap, currency: limit.currency })}.`
    : `Цена сейчас ${money(currentPrice)}: лимит не выше неё, и перебивать бот не будет.`;
}

// Исход — свой экран (дизайн-код, «Экран исхода», PER-472): исход в
// заголовке без точки, название лота жирным, затем пояснение. Отказ
// называет цену сам; принятая команда — экран `accepted`.
type Outcome = { title: string; detail?: string };

function outcomeText(outcome: Outcome, lotTitle: string | undefined): string {
  return screenText(
    outcome.title,
    lotSubject(lotTitle),
    outcome.detail === undefined ? undefined : escapeHtml(outcome.detail),
  );
}

const answerRefusals: Record<AnswerRefusal, Outcome> = {
  "not-text": { title: "Нужен ответ текстом" },
  "not-a-number": { title: "Это не сумма" },
  "other-currency": { title: "Ставки принимаются только в рублях" },
  "not-positive": { title: "Сумма должна быть больше нуля" },
  "too-precise": { title: "Копеек — не больше двух знаков" },
  "too-large": {
    title: "Сумма слишком большая",
    detail: `Бот принимает суммы до ${money({ minorUnits: MAX_COMMAND_AMOUNT, currency: "RUB" })}.`,
  },
  "alias-invalid": { title: "Такой псевдоним не подходит" },
  "alias-taken": { title: "Этот псевдоним уже занят" },
  "name-frozen": {
    title: "Имя уже не поменять",
    detail: "Ты ставил в этом аукционе.",
  },
  "username-missing": {
    title: "Ника в Telegram у тебя нет",
    detail: "Возьми псевдоним.",
  },
};

export function resultOutcome(result: CommandResult): Outcome {
  if (result.kind === "unknown") {
    return {
      title: "Аукцион не ответил",
      detail: "Проверь цену на карточке: команда могла пройти.",
    };
  }
  const { refusal } = result;
  switch (refusal.kind) {
    case "lot-not-open":
      return { title: "Торги по лоту не идут" };
    case "lot-on-hold":
      return {
        title: "Лот ждёт финала",
        detail: `Ставки сейчас не принимаются. Цена: ${money(refusal.currentPrice)}.`,
      };
    case "bid-below-minimum":
      return {
        title: "Ставка ниже порога",
        detail: `Сейчас можно от ${money(refusal.minRequired)}.`,
      };
    case "bid-above-maximum":
      return {
        title: "Ставка выше потолка",
        detail: `Максимум сейчас — 5 × ${money(refusal.next)}.`,
      };
    case "bid-not-at-next-price":
      return {
        title: "Ставка не по цене финала",
        detail: `В финале ставят ровно ${money(refusal.expected)}.`,
      };
    case "bidder-is-leader":
      return {
        title: "Ты уже лидируешь",
        detail: `Цена ${money(refusal.currentPrice)} — твоя.`,
      };
    case "currency-mismatch":
      return { title: "Лот торгуется в другой валюте" };
    case "proxy-below-current-price":
      return {
        title: "Лимит ниже текущей цены",
        detail: `Нужно от ${money(refusal.minLimit)}.`,
      };
    case "proxy-disabled":
      return { title: "Автоставка на этом лоте выключена" };
    // Выбор имени — свой экран, а не отказ: сюда отказ не доходит.
    case "display-name-not-chosen":
      return { title: "Выбери имя в аукционе" };
    // Снял администратор (ADR-072): кто и почему, ответ не несёт.
    case "removed-from-lot":
      return { title: "Ставки на этом лоте для тебя закрыты" };
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

// Хронология ставок лота (PER-309): жирный заголовок с номером страницы,
// название лота курсивом строкой ниже (PER-644) и строки ставок по порядку журнала. Восемь строк
// на странице держат текст далеко под лимитом сообщения при любом названии.
function renderHistory(
  block: HistoryBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format"> {
  return {
    format: "html",
    text: lotSectionText(
      paged("Ставки", block),
      block.title ?? untitled,
      block.entries.length === 0
        ? "Ставок пока нет."
        : block.entries
            .map((entry) =>
              bullet(
                struckHistoryLine(
                  entry,
                  escapeHtml(
                    historyLine(
                      entry,
                      readableMoment(
                        entry.occurredAt,
                        options.timeZone,
                        options.now,
                      ),
                    ),
                  ),
                ),
              ),
            )
            .join("\n"),
    ),
  };
}

// Избранное (PER-495): свои отмеченные лоты по порядку отметки — кнопками.
// Текст не повторяет кнопки (PER-595): сколько лотов в избранном и сводка
// своих — где смотрящий лидер и что он купил; у лота в торгах строка несёт
// ещё и дедлайн. Пустой список говорит, как его пополнить.
function renderFavorites(
  block: FavoritesBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format"> {
  return {
    format: "html",
    text: screenText(
      paged(favoritesTitle, block),
      ...((block.total ?? block.lots.length) === 0
        ? [favoritesEmptyText(block.ended)]
        : favoritesSummary(block.total ?? block.lots.length, block.mine ?? [], {
            ...mineOptions,
            price: (item) => favoriteState(item.status, options),
            ...(block.ended === true ? { ended: true } : {}),
          })),
    ),
  };
}

// Цена и до какого момента идут торги: дедлайн есть только у онлайн-торгов.
function favoriteState(status: LotStatusView, options: RenderOptions): string {
  return status.kind === "trading" && status.deadline !== undefined
    ? `${priceLabel(status)}, торги до ${readableMoment(status.deadline, options.timeZone, options.now)}`
    : priceLabel(status);
}

// Экран сета (ADR-073, п. 7): лоты сета по порядку организатора и, после
// итога, кто его собрал. Заголовок называет экран, а предмет — название сета —
// стоит строкой ниже курсивом: экран-раздел предмета, как «Ставки» лота.
function renderSet(block: SetBlock): Pick<RenderedScreen, "text" | "format"> {
  return {
    format: "html",
    text: lotSectionText(
      setLabel,
      block.name,
      block.lots.length === 0
        ? "Лотов в сете пока нет."
        : block.lots
            .map((item) => bullet(setLotLine(item, setOptions)))
            .join("\n"),
      ...(block.more === undefined ? [] : [setMoreLine(block.more)]),
      // Имя собравшего — текст участника: без экранирования Telegram отверг бы
      // разметку.
      ...(block.collectorName === undefined
        ? []
        : [escapeHtml(collectedLine(block.name, block.collectorName))]),
    ),
  };
}

// Название и цена лота сета — как у строки ленты: правила оболочки бота
// аукциона.
const setOptions: SetLotOptions = {
  title: (item) => escapeHtml(oneLine(item.title ?? untitled)),
  buttonTitle: (item) => escapeHtml(shorten(item.title ?? untitled)),
  price: (item) => priceLabel(item.status),
};

// Сет, в который входит лот (ADR-073, п. 7): название сета и, после итога,
// кто его собрал. До итога сета второй строки нет — собравшего Auction ещё не
// знает.
function setGroups(block: LotBlock): string[][] {
  const lotSet = block.set;
  return lotSet === undefined ? [] : [setGroupLines(lotSet)];
}

// Карточка лота (дизайн-код, «Карточка»): название, группа статуса, группа
// цены, лидера и срока со знаками, группа хода торгов, описание или его
// заглушка — группы через пустую строку, строки «ключ: значение» без точки. Rich-карточка размечается блоками: перенос строки в её
// `html` не рисуется, поэтому группа и абзац описания — свой `<p>`, строки
// внутри — `<br>`, а фото адаптер ставит первым блоком, над заголовком.
// Предела подписи у неё нет. В `plain` та же карточка уходит обычным сообщением с HTML и без
// фото. Исход команды карточка не несёт: он — свой экран (PER-472).
function renderCard(
  block: LotBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format" | "photos"> {
  const title = truncate(block.card?.title ?? untitled, TITLE_LIMIT);
  // Исход ставки финала — своей группой под статусом и ценой (PER-336).
  const groups = [...statusGroups(block, options), ...setGroups(block)];
  const result = finalBidHeadline(block, money);
  const rich = (options.presentation ?? "rich") === "rich";
  // Пустое описание — та же заглушка, что у карточки сходки хаба (дизайн-код,
  // «Карточка»; PER-594).
  const description = fitDescription(
    title,
    block.card?.description === undefined || block.card.description === ""
      ? emptyDescription
      : block.card.description,
    groups.flat(),
    rich ? RICH_TEXT_LIMIT : TEXT_LIMIT,
  );
  if (!rich) {
    return {
      format: "html",
      text: screenText(
        title,
        result === undefined ? undefined : `<b>${escapeHtml(result)}</b>`,
        ...groups.map((lines) => escapeHtml(lines.join("\n"))),
        escapeHtml(description),
      ),
    };
  }
  const paragraphs = description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").filter((l) => l.trim() !== ""))
    .filter((lines) => lines.length > 0);
  // Число блоков у rich-сообщения ограничено: абзацы сверх предела сливаются
  // в последний, текст при этом не теряется.
  const kept = paragraphs.slice(0, PARAGRAPH_LIMIT - 1);
  const rest = paragraphs.slice(PARAGRAPH_LIMIT - 1).flat();
  const blocks = [...groups, ...kept, ...(rest.length === 0 ? [] : [rest])];
  const photos = lotPhotoKeys(block.lotId, block.card);
  return {
    format: "rich",
    text: `<h1>${escapeHtml(title)}</h1>${result === undefined ? "" : `<h2>${escapeHtml(result)}</h2>`}${blocks
      .map((lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`)
      .join("")}`,
    ...(photos.length === 0 ? {} : { photos }),
  };
}

// Группы карточки: статус словом, затем блок цены, лидера и срока со знаками
// словаря, затем ход торгов — следующая ставка, шаг, своя автоставка. Слова
// статусов — дизайн-код, «Карточка лота»; у хаба они те же.
function statusGroups(block: LotBlock, options: RenderOptions): string[][] {
  const { status, participantName } = block;
  switch (status.kind) {
    case "draft":
      return [["Статус: готовится к торгам"]];
    // Шаг до торгов — тем же форматом, что в торгах (PER-618): условия
    // Auction отдаёт с первого планирования, и участник видит их заранее.
    case "scheduled": {
      const step = stepLines(block, options);
      return [
        ["Статус: торги ещё не начались"],
        [
          marked(
            pictogram.price,
            `Стартовая цена: ${money(status.startingPrice)}`,
          ),
        ],
        ...(step.length === 0 ? [] : [step]),
      ];
    }
    case "trading": {
      // Ход торгов: в финале — одна строка цены без шага (PER-336, PER-639),
      // в онлайн-торгах — порог следующей ставки и шаг; затем свой лимит.
      const course = [
        ...(status.phase === "live"
          ? finalPriceLines(block, money)
          : block.nextPrice === undefined
            ? []
            : [`Следующая ставка: от ${money(block.nextPrice)}`]),
        ...(showsStep(block) ? stepLines(block, options) : []),
        ...proxyLine(block),
      ];
      return [
        [
          status.phase === "live"
            ? "Статус: торги финала"
            : "Статус: идут торги",
        ],
        [
          // Без ставок — «Стартовая цена» (PER-631, №82).
          tradingPriceLine(status),
          marked(
            pictogram.leader,
            leaderLine(status.leaderId, participantName, block.standing),
          ),
          ...(status.deadline === undefined
            ? []
            : [
                marked(
                  pictogram.deadline,
                  `Торги до: ${readableMoment(status.deadline, options.timeZone, options.now)}`,
                ),
              ]),
        ],
        ...(course.length === 0 ? [] : [course]),
      ];
    }
    case "held":
      return [
        ["Статус: ждёт финала"],
        [
          marked(pictogram.price, `Цена: ${money(status.currentPrice)}`),
          marked(
            pictogram.leader,
            leaderLine(status.leaderId, participantName, block.standing),
          ),
        ],
      ];
    // Покупатель видит, что лот его (PER-595).
    case "sold":
      return [
        ["Статус: продан", ...(block.standing === "won" ? [ownLotLine] : [])],
        [
          marked(pictogram.price, `Цена продажи: ${money(status.price)}`),
          marked(
            pictogram.leader,
            participantName === undefined
              ? "Победитель: определён"
              : `Победитель: ${participantName}`,
          ),
        ],
      ];
    case "unsold":
      return [["Статус: не продан"]];
    case "withdrawn":
      return [["Статус: снят с торгов"]];
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Шаг лота до торгов и в торгах (дизайн-код, «Карточка лота»). В окне
// «Счастливых часов» — его условия до конца, стартовая окна, шаг или оба
// (PER-787), и обычный шаг рядом, иначе строка
// «Шаг», когда шаг один на все цены, или «Шаг по порогам». Будущее окно —
// отдельной строкой: когда и какой шаг; окна Auction отдаёт только в торгах.
function stepLines(block: LotBlock, options: RenderOptions): string[] {
  const at = (instant: string) =>
    readableMoment(instant, options.timeZone, options.now);
  const active = block.activeWindow;
  const activeTerms =
    active === undefined
      ? undefined
      : happyHourTerms(active, regularStart(block), money);
  const current =
    // Окно только со стартовой шаг не меняет: строка шага остаётся.
    active === undefined ||
    activeTerms === undefined ||
    active.step === undefined
      ? block.tiers === undefined
        ? block.fixedStep === undefined
          ? []
          : [`Шаг: ${money(block.fixedStep)}`]
        : [
            "Шаг по порогам:",
            ...block.tiers.map(
              (tier) => `от ${money(tier.lowerBound)} — ${money(tier.step)}`,
            ),
          ]
      : [
          activeHappyHourLine(at(active.until), activeTerms),
          ...(block.baseStep === undefined
            ? []
            : [`Обычный шаг: ${money(block.baseStep)}`]),
        ];
  const startOnly =
    active !== undefined &&
    activeTerms !== undefined &&
    active.step === undefined
      ? [activeHappyHourLine(at(active.until), activeTerms)]
      : [];
  const next = block.nextWindow;
  const nextTerms =
    next === undefined
      ? undefined
      : happyHourTerms(next, regularStart(block), money);
  if (next === undefined || nextTerms === undefined) {
    return [...startOnly, ...current];
  }
  // Окно внутри одного дня называет день один раз: «с 12 июня, сб, 18:00 до
  // 21:00».
  const until =
    readableDay(next.from, options.timeZone, options.now) ===
    readableDay(next.until, options.timeZone, options.now)
      ? clockOf(next.until, options.timeZone)
      : at(next.until);
  return [
    ...startOnly,
    ...current,
    `Счастливые часы: с ${at(next.from)} до ${until}, ${nextTerms}`,
  ];
}

// Обычная стартовая — текущая цена лота в торгах без ставок: с ней стартовая
// окна идёт парой (PER-787).
function regularStart(block: LotBlock): Money | undefined {
  return block.status.kind === "trading" && block.status.leaderId === undefined
    ? block.status.currentPrice
    : undefined;
}

function clockOf(instant: string, timeZone: string): string {
  const parts = dateParts(instant, timeZone);
  return `${parts("hour")}:${parts("minute")}`;
}

// Свой лимит смотрящего: чужих Auction не отдаёт, и строка говорит, что этот
// виден только ему; исчерпанный лимит так и назван (PER-631, №81), в живом
// финале — без совета поднять его (PER-713).
function proxyLine(block: LotBlock): string[] {
  return block.viewerProxyLimit === undefined
    ? []
    : [ownProxyLine({ ...block, viewerProxyLimit: block.viewerProxyLimit })];
}

// Описание — единственная часть карточки произвольной длины, поэтому под лимит
// Telegram режется оно. Длина считается по видимому тексту до экранирования:
// лимит Bot API действует после разбора разметки. Название и строки статуса
// короче лимита при любом лоте.
function fitDescription(
  title: string,
  description: string,
  status: readonly string[],
  limit: number,
): string {
  const visible = [title, description, ...status].join("\n\n").length;
  if (visible <= limit) return description;
  return truncate(
    description,
    Math.max(1, description.length - (visible - limit)),
  );
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderButton(
  button: AuctionButton,
  items: ReadonlyMap<string, FeedItem>,
  blocks: readonly AuctionBlock[],
): TelegramButton {
  const text = (label: string) => ({
    text: label,
    callback_data: button.callbackData,
  });
  switch (button.action) {
    case "feed.open-lot": {
      const item = items.get(button.lotId);
      if (item === undefined) return text(untitled);
      const title = shorten(item.title ?? untitled);
      // В ленте живого финала лот на торгах и лоты состава подписаны иначе
      // (PER-639).
      const final = blocks.find(
        (block): block is FeedBlock => block.kind === "feed",
      )?.final;
      const label =
        (final === undefined ? null : finalFeedLabel(item, final, title)) ??
        `${title}${lotButtonTail(item, priceLabel(item.status))}`;
      // Сет в подписи ленты не называется (решение владельца 24.10.2026,
      // пересматривает ADR-073, п. 7): сет называет карточка лота.
      return text(label);
    }
    // Избранное — свой список: отметки сета в нём нет (PER-510).
    case "favorites.open-lot": {
      const item = items.get(button.lotId);
      if (item === undefined) return text(untitled);
      const title = shorten(item.title ?? untitled);
      // Лидер видит себя и на кнопке избранного, как в ленте (прогон 14.10,
      // №83).
      return text(`${title}${lotButtonTail(item, priceLabel(item.status))}`);
    }
    // Лот сета на его экране: подпись как у кнопки ленты, без отметки сета.
    case "set.open-lot": {
      const item = items.get(button.lotId);
      if (item === undefined) return text(untitled);
      return text(setLotLabel(item, setOptions));
    }
    // Раздел ленты (PER-719): название и число лотов.
    case "feed.open-section": {
      const section = blocks
        .find((block): block is FeedBlock => block.kind === "feed")
        ?.sections?.find((each) => each.sectionId === button.sectionId);
      return text(section === undefined ? untitled : feedSectionLabel(section));
    }
    case "feed.prev":
      return text("←");
    case "feed.next":
      return text("→");
    case "root.predictions":
      return text(predictionButtonLabel);
    case "root.prediction-results":
      return text(predictionResultsButtonLabel);
    case "prediction-results.back":
      return text("‹ Аукцион");
    case "root.achievements":
      return text("Ачивки");
    case "root.day-chronicle":
      return text(dayChronicleButtonLabel);
    case "day-chronicle.back":
      return text("‹ Аукцион");
    case "auction-chronicle.back":
      return text("‹ Аукцион");
    case "root.promo":
      return text(promoButtonLabel);
    case "promo.back":
      return text("‹ Аукцион");
    case "lot.current":
      return text("К текущему лоту");
    case "lot.refresh":
      return text(refreshLabel);
    case "lot.history":
      return text("Ставки");
    // Лоты сета — экран сета с карточки (ADR-073, п. 7).
    case "lot.set":
      return text(setLabel);
    case "set.back":
      return text("‹ Лот");
    case "lot.back":
      return text("‹ Лоты");
    case "history.prev":
      return text("←");
    case "history.next":
      return text("→");
    case "history.back":
      return text("‹ Лот");
    case "lot.follow":
      return text(followLabel);
    case "lot.unfollow":
      return text(unfollowLabel);
    case "lot.prev":
      return text(lotPrevLabel);
    case "lot.next":
      return text(lotNextLabel);
    case "favorites.prev":
      return text("←");
    case "favorites.next":
      return text("→");
    // С раздела ленты возврат — к списку разделов (PER-719).
    case "feed.back":
      return text(
        blocks.some(
          (block) => block.kind === "feed" && block.section !== undefined,
        )
          ? "‹ Лоты"
          : `‹ ${rootTitle}`,
      );
    case "favorites.back":
    case "raffle.back":
      return text(`‹ ${rootTitle}`);
    // Без ставок первая ставка — не «по шагу» (PER-631, №82).
    case "lot.bid-step":
      return text(stepBidLabel(button.amount, firstBidOffered(blocks)));
    case "lot.bid-final":
      return text(finalBidLabel(button.amount, money));
    case "lot.bid-custom":
      return text("Своя сумма");
    case "lot.proxy":
      return text("Автоставка");
    case "confirm.yes":
      return { ...text(confirmLabel(blocks)), style: "danger" };
    case "confirm.no":
      return text(confirmNoLabel);
    case "question.cancel":
      return text("Отмена");
    case "question.explain":
      return text("Как это работает");
    case "name.username": {
      const choice = blocks.find(
        (block) =>
          block.kind === "name-choice" ||
          block.kind === "raffle-name-choice" ||
          block.kind === "prediction-name-choice" ||
          block.kind === "name-settings",
      );
      return text(
        (choice?.kind === "name-choice" ||
          choice?.kind === "raffle-name-choice" ||
          choice?.kind === "prediction-name-choice" ||
          choice?.kind === "name-settings") &&
          choice.username !== undefined
          ? `Ник @${choice.username}`
          : "Ник",
      );
    }
    case "name.alias":
      return text("Взять псевдоним");
    case "name.back":
    case "accepted.lot":
    case "result.lot":
      return text("‹ Лот");
    case "accepted.feed":
      return text("‹ Лоты");
    case "name.return":
      return text(`‹ ${nameSettingsTitle}`);
    case "answer.retry":
      return text("Ввести заново");
    case "root.lots":
      return text(lotsLabel);
    case "root.raffle":
      return text(raffleButtonLabel);
    case "root.favorites":
      return text(favoritesTitle);
    case "root.invoices":
      return text(invoicesButtonLabel);
    case "invoices.open": {
      const block = blocks.find(
        (each): each is Extract<AuctionBlock, { kind: "invoices" }> =>
          each.kind === "invoices",
      );
      return text(
        invoiceLabel(
          block?.invoices.find((item) => item.invoiceId === button.invoiceId),
        ),
      );
    }
    case "invoices.back":
      return text(`‹ ${rootTitle}`);
    case "invoice.back":
      return text(invoicesBackLabel);
    case "invoice.retry":
      return text("Повторить");
    case "raffle.register":
      return text(registerLabel);
    case "raffle.cancel":
      return text(cancelRegistrationLabel);
    case "raffle.proof":
      return text(raffleProofLabel);
    case "raffle.return":
      return text(`‹ ${raffleBackName}`);
    case "prediction.edit": {
      const parsed = parseAuctionCallback(button.callbackData);
      if (!parsed.ok || parsed.intent.kind !== "prediction-edit") {
        throw new Error("prediction edit button has invalid callback data");
      }
      const { nomination } = parsed.intent;
      const block = blocks.find(
        (each): each is Extract<AuctionBlock, { kind: "prediction" }> =>
          each.kind === "prediction",
      );
      const answered = block?.answers.some(
        (answer) => answer.nomination === nomination,
      );
      return text(
        `${answered ? "Изменить" : "Ответить"} ${predictionSpec(nomination).number}`,
      );
    }
    case "prediction.select-lot": {
      const block = blocks.find(
        (each): each is Extract<AuctionBlock, { kind: "prediction-lots" }> =>
          each.kind === "prediction-lots",
      );
      const item = block?.lots.find((lot) => lot.lotId === button.lotId);
      return text(
        item === undefined
          ? untitled
          : `${shorten(item.title ?? untitled)} · ${priceLabel(item.status)}`,
      );
    }
    case "prediction.clear":
      return text("Очистить");
    case "prediction.switch-round": {
      const parsed = parseAuctionCallback(button.callbackData);
      if (!parsed.ok || parsed.intent.kind !== "prediction") {
        throw new Error("prediction round button has invalid callback data");
      }
      return text(predictionRoundTitle(parsed.intent.round));
    }
    case "prediction.back":
      return text(
        blocks.some((block) => block.kind === "prediction")
          ? `‹ ${rootTitle}`
          : "‹ Прогнозы",
      );
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

function firstBidOffered(blocks: readonly AuctionBlock[]): boolean {
  const lot = blocks.find((block) => block.kind === "lot");
  return lot?.kind === "lot" && awaitsFirstBid(lot.status);
}

// «✔️ Да, …» называет действие (дизайн-код, «Клавиатура»). Сумма — в вопросе
// «Поставить N?»: с ней «Да» обрезалось в паре с «Нет» (PER-631, №86).
function confirmLabel(blocks: readonly AuctionBlock[]): string {
  const confirm = blocks.find((block) => block.kind === "confirm");
  if (confirm?.kind !== "confirm") return confirmYesLabel("подтвердить");
  return confirm.command === "bid"
    ? confirmYesLabel("поставить")
    : confirmYesLabel("включить автоставку");
}

function priceLabel(status: LotStatusView): string {
  switch (status.kind) {
    case "trading":
    case "held":
      return money(status.currentPrice);
    case "scheduled":
      return `старт ${money(status.startingPrice)}`;
    case "sold":
      return `продан за ${money(status.price)}`;
    case "unsold":
      return "не продан";
    case "withdrawn":
      return "снят";
    case "draft":
      return "готовится";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function shorten(title: string): string {
  return truncate(title, BUTTON_TITLE_LIMIT);
}

// Дата для чтения по дизайн-коду: «12 июня, сб, 19:04»; чужой год называется.
export function readableMoment(
  instant: string,
  timeZone: string,
  now?: Date,
): string {
  const parts = dateParts(instant, timeZone);
  return `${readableDay(instant, timeZone, now)}, ${parts("hour")}:${parts("minute")}`;
}
