import { renderFaqText } from "../../auction-faq.js";
import {
  finalBidLabel,
  finalBidLine,
  finalPriceLines,
} from "../../auction-final.js";
import {
  cancelRegistrationLabel,
  raffleBackName,
  raffleButtonLabel,
  raffleNameChoiceText,
  raffleParagraphs,
  raffleTitle,
  registerLabel,
} from "../../auction-raffle.js";
import {
  autoFollowNote,
  currentValueLine,
  favoritesEmpty,
  favoritesSummary,
  feedSummary,
  followLabel,
  leaderLine,
  nameSettingsParagraphs,
  nameSettingsTitle,
  ownLotLine,
  proxyHintLead,
  unfollowLabel,
} from "../../auction-standing.js";
import {
  type AnswerRefusal,
  type AuctionBlock,
  type AuctionButton,
  type AuctionDenial,
  type AuctionScreenBody,
  type AuctionStageView,
  type BidOriginView,
  type CommandResult,
  encodeAuctionCallback,
  type FeedItem,
  type HistoryItem,
  type LotStatusView,
  MAX_COMMAND_AMOUNT,
  type Money,
} from "../../auction-ui/index.js";
import type { Presentation } from "../../core/config.js";
import {
  admittersLine,
  applyLabel,
  menuTitle,
  strayHintText,
} from "../../core/entry.js";
import { money, truncate } from "../../core/format.js";
import {
  OUTBID_FREQUENCIES,
  type OutbidFrequency,
  outbidButtonLabel,
  outbidExplanation,
} from "../../core/notifications/outbid.js";
import {
  confirmNoLabel,
  confirmYesLabel,
  emptyDescription,
  marked,
  pictogram,
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
// (PER-592): «Аукционы» с «Прошедшими» внутри, FAQ и, у бота с Notifications,
// «Избранное» (PER-495) и «Уведомления» (PER-515) — его разделы, их же
// открывают команды.
export type AuctionEntryScreen =
  | { kind: "menu"; favorites: boolean }
  // Приветствие человека без права: заявку ставит только его кнопка.
  | { kind: "welcome"; sourceCode?: string }
  // Подсказка на сообщение вне вопроса (PER-592).
  | { kind: "hint"; openQuestion: boolean }
  | { kind: "faq" }
  // «Настройки» (PER-595): частота «перебили», у бота с Notifications, и имя в
  // идущем аукционе, если такой есть.
  | { kind: "settings"; notifications: boolean; auctionId?: string }
  | { kind: "notify"; current: OutbidFrequency }
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
  | { kind: "unavailable"; exit: UnavailableExit; subject?: "notifications" };

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
  // Изображение rich-карточки лота: адаптер ставит его первым блоком. Байты
  // и `file_id` достаёт адаптер Telegram, экрану достаточно ключа.
  photo?: { lotId: string; version: string };
  // Вопрос: адаптер шлёт его новым сообщением с `force_reply` (дизайн-код,
  // «Вопросы»).
  asks?: true;
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

export function renderEntryScreen(
  screen: AuctionEntryScreen,
  options: RenderOptions,
): RenderedScreen {
  const faq = options.faq ?? defaultFaq;
  switch (screen.kind) {
    // Корневое меню: разделы кнопками в порядке списка команд, возврата нет.
    case "menu":
      return {
        id: "menu",
        format: "html",
        text: screenText(
          menuTitle,
          "Разделы бота. Те же разделы — в кнопке меню рядом с полем ввода.",
        ),
        keyboard: [
          [{ text: "Аукционы", callback_data: entryCallback("auctions") }],
          ...(screen.favorites
            ? [
                [
                  {
                    text: favoritesTitle,
                    callback_data: encodeAuctionCallback({
                      kind: "favorites",
                      page: 0,
                    }),
                  },
                ],
              ]
            : []),
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
          rows.length === 0
            ? "Настраивать пока нечего: имя выбирается, когда идёт аукцион."
            : "Уведомления о торгах и имя, под которым ты ставишь в идущем аукционе.",
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
          [
            faq.detailsUrl === undefined
              ? {
                  text: "Прочитать подробнее",
                  callback_data: entryCallback("details"),
                }
              : {
                  text: `Прочитать подробнее${linkSign}`,
                  url: faq.detailsUrl,
                },
          ],
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
    // Частота «перебили» (PER-515): пять режимов по одному в ряд, текущий
    // отмечен на своей кнопке маркером «• » (PER-598; дизайн-код,
    // «Уведомления»). Выбор отменяется с того же экрана, поэтому
    // подтверждения «Да» у него нет: что сработало, говорит ответ на нажатие.
    // Экран — подраздел «Настроек»: последний ряд — «‹ Настройки» (PER-595).
    case "notify":
      return {
        id: "notify",
        format: "html",
        text: screenText(notifyTitle, ...outbidExplanation),
        keyboard: [
          ...OUTBID_FREQUENCIES.map((frequency) => [
            {
              text: outbidButtonLabel(frequency, screen.current),
              callback_data: notifyCallback(frequency),
            },
          ]),
          [toSettings],
        ],
      };
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
      // Избранное — раздел под меню: возврата у тела нет, и «‹ Меню» ставит
      // оболочка (PER-592).
      if (body.id === "favorites") {
        return { ...body, keyboard: [...body.keyboard, [toMenu]] };
      }
      // Имя в аукционе — подраздел «Настроек» (PER-595): возврат ставит
      // оболочка, у хаба родитель другой.
      if (body.id === "name-settings") {
        return { ...body, keyboard: [...body.keyboard, [toSettings]] };
      }
      // Родителя ленты тело не знает: возврат в её список ставит оболочка.
      // Корень аукциона (PER-605) входа в этом боте не имеет, но нарисовать
      // его бот обязан: возврат — тот же, что у ленты.
      if (body.id === "feed" || body.id === "root") {
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
    // входят: экранов за ними у человека здесь нет, и клавиатуры тоже.
    case "denied":
      return {
        id: screen.reason === "in-community" ? "in-community" : "denied",
        format: "html",
        text: deniedTexts[screen.reason],
        keyboard: [],
      };
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
          screen.subject === "notifications"
            ? "Настройка уведомлений сейчас недоступна."
            : "Аукцион сейчас недоступен."
        }</b> ${
          exit.kind === "answer"
            ? "Пришли ответ ещё раз через минуту."
            : "Попробуй ещё раз через минуту."
        }`,
        // Сбой самих «Аукционов» несёт только повтор: возврат вёл бы туда же.
        keyboard: [
          exit.kind === "retry"
            ? exit.data === toAuctions.callback_data
              ? [retry(exit.data)]
              : [retry(exit.data), toAuctions]
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
            .map((auction) =>
              bullet(auctionLine(auction, options.timeZone, options.now)),
            )
            .join("\n"),
    ),
    keyboard: [
      ...list.auctions.map((auction) => [
        {
          text: auctionLabel(auction, options.timeZone, options.now),
          callback_data: encodeAuctionCallback({
            kind: "feed",
            auctionId: auction.auctionId,
            page: 0,
          }),
        },
      ]),
      ...(kind === "auctions"
        ? [
            [
              {
                text: listTexts.past.backName,
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
  if (auction.closesAt === undefined || auction.stage === "finished") {
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
  const items = new Map<string, FeedItem>();
  for (const block of body.blocks) {
    if (block.kind === "feed" || block.kind === "favorites") {
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
      paged("Лоты", feed),
      ...(feed.lots.length === 0
        ? ["Лотов пока нет."]
        : feedSummary(feed.mine ?? [], feed.lots, mineOptions)),
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
      case "raffle":
        return "raffle";
      case "raffle-name-choice":
        return "raffle-name-choice";
      case "raffle-question":
      case "name-question":
        return "alias-question";
      case "name-settings":
        return "name-settings";
      case "name-answer-refused":
        return "answer-refused";
      case "feed":
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
};

function rootText(block: RootBlock, options: RenderOptions): string {
  const { auction } = block;
  if (auction === undefined) {
    return screenText("Аукцион", "Этого аукциона больше нет.");
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
    "Аукцион",
    [
      rootStages[auction.stage],
      ...(online === undefined ? [] : [online]),
      ...(auction.final ? ["После них — финал в зале."] : []),
    ].join("\n"),
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
): Pick<RenderedScreen, "text" | "format" | "asks"> | undefined {
  for (const block of blocks) {
    switch (block.kind) {
      case "confirm":
        return { format: "html", text: confirmText(block) };
      case "accepted":
        return { format: "html", text: acceptedText(block) };
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
      // Розыгрыш среди участников (ADR-066): тексты общие с хабом.
      case "raffle":
        return {
          format: "html",
          text: screenText(
            raffleTitle,
            ...raffleParagraphs(block.raffle, {
              moment: (instant) =>
                readableMoment(instant, options.timeZone, options.now),
            }),
          ),
        };
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
        `${proxyGap(block.currentPrice, block.amount)}\nЛимит видишь только ты.`,
      );
}

// Принятая команда — свой экран (PER-473): сумма в заголовке, карточку с
// новой ценой открывает «‹ Лот», ленту — «‹ Лоты» (PER-595). У бота с
// избранным экран говорит, что ставка кладёт лот туда сама (ADR-063).
function acceptedText(
  block: Extract<AuctionBlock, { kind: "accepted" }>,
): string {
  const note = block.favorites === true ? autoFollowNote : undefined;
  return block.command === "bid"
    ? screenText(
        `Ставка ${money(block.amount)} принята`,
        lotSubject(block.title),
        note,
      )
    : screenText(
        `Автоставка до ${money(block.amount)} включена`,
        lotSubject(block.title),
        "Лимит видишь только ты.",
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
          "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
          ...current(),
          "Например: 3 000",
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
function proxyGap(currentPrice: Money, limit: Money): string {
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
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

// Хронология ставок лота (PER-309): жирный заголовок с номером страницы,
// название лота жирным и строки ставок по порядку журнала. Восемь строк
// на странице держат текст далеко под лимитом сообщения при любом названии.
function renderHistory(
  block: HistoryBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format"> {
  return {
    format: "html",
    text: screenText(
      paged("Ставки", block),
      lotSubject(block.title ?? untitled),
      block.entries.length === 0
        ? "Ставок пока нет."
        : block.entries
            .map((entry) => bullet(escapeHtml(historyLine(entry, options))))
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
        ? [favoritesEmpty]
        : favoritesSummary(block.total ?? block.lots.length, block.mine ?? [], {
            ...mineOptions,
            price: (item) => favoriteState(item.status, options),
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

// Строка ставки: когда, кто, сколько и как. Имени нет — Auction его не отдал,
// и строка остаётся без него: идентификатор человеку не показывается. Лимита
// прокси в строке нет — его нет и в теле.
function historyLine(entry: HistoryItem, options: RenderOptions): string {
  return [
    readableMoment(entry.occurredAt, options.timeZone, options.now),
    ...(entry.participantName === undefined ? [] : [entry.participantName]),
    money(entry.amount),
    originLabel(entry.origin),
  ].join(" · ");
}

function originLabel(origin: BidOriginView): string {
  switch (origin.kind) {
    case "proxy":
      return "авто";
    case "manual":
      return origin.source === "floor" ? "в зале" : "вручную";
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
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
): Pick<RenderedScreen, "text" | "format" | "photo"> {
  const title = truncate(block.card?.title ?? untitled, TITLE_LIMIT);
  // Исход ставки финала — своей группой под статусом и ценой (PER-336).
  const groups = [
    ...statusGroups(block, options),
    ...(block.finalBid === undefined
      ? []
      : [[finalBidLine(block.finalBid, money)]]),
  ];
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
  const image = block.card?.image;
  return {
    format: "rich",
    text: `<h1>${escapeHtml(title)}</h1>${blocks
      .map((lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`)
      .join("")}`,
    ...(image === undefined
      ? {}
      : { photo: { lotId: block.lotId, version: image.version } }),
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
    case "scheduled":
      return [
        ["Статус: торги ещё не начались"],
        [
          marked(
            pictogram.price,
            `Стартовая цена: ${money(status.startingPrice)}`,
          ),
        ],
      ];
    case "trading": {
      // Ход торгов: в финале — объявленная цена и следующая ставка ровно по
      // ней (PER-336), в онлайн-торгах — порог следующей ставки; затем шаг и
      // свой лимит.
      const course = [
        ...(status.phase === "live"
          ? finalPriceLines(block, money)
          : block.nextPrice === undefined
            ? []
            : [`Следующая ставка: от ${money(block.nextPrice)}`]),
        ...stepLines(block, options),
        ...proxyLine(block),
      ];
      return [
        [
          status.phase === "live"
            ? "Статус: торги финала"
            : "Статус: идут торги",
        ],
        [
          marked(pictogram.price, `Цена: ${money(status.currentPrice)}`),
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

// Шаг лота в торгах (дизайн-код, «Карточка лота»). В окне «Счастливых часов»
// — шаг окна до его конца и обычный шаг рядом, иначе строка «Шаг», когда шаг
// один на все цены. Будущее окно — отдельной строкой: когда и какой шаг.
function stepLines(block: LotBlock, options: RenderOptions): string[] {
  const at = (instant: string) =>
    readableMoment(instant, options.timeZone, options.now);
  const active = block.activeWindow;
  const current =
    active === undefined
      ? block.fixedStep === undefined
        ? []
        : [`Шаг: ${money(block.fixedStep)}`]
      : [
          `Счастливые часы: шаг ${money(active.step)} до ${at(active.until)}`,
          ...(block.baseStep === undefined
            ? []
            : [`Обычный шаг: ${money(block.baseStep)}`]),
        ];
  const next = block.nextWindow;
  if (next === undefined) return current;
  // Окно внутри одного дня называет день один раз: «с 12 июня, сб, 18:00 до
  // 21:00».
  const until =
    readableDay(next.from, options.timeZone, options.now) ===
    readableDay(next.until, options.timeZone, options.now)
      ? clockOf(next.until, options.timeZone)
      : at(next.until);
  return [
    ...current,
    `Счастливые часы: с ${at(next.from)} до ${until}, шаг ${money(next.step)}`,
  ];
}

function clockOf(instant: string, timeZone: string): string {
  const parts = dateParts(instant, timeZone);
  return `${parts("hour")}:${parts("minute")}`;
}

// Свой лимит смотрящего: чужих Auction не отдаёт, и строка говорит, что этот
// виден только ему.
function proxyLine(block: LotBlock): string[] {
  return block.viewerProxyLimit === undefined
    ? []
    : [
        `Твоя автоставка: до ${money(block.viewerProxyLimit)} (видишь только ты)`,
      ];
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
    case "feed.open-lot":
    case "favorites.open-lot": {
      const item = items.get(button.lotId);
      return text(
        item === undefined
          ? untitled
          : `${shorten(item.title ?? untitled)} · ${priceLabel(item.status)}`,
      );
    }
    case "feed.prev":
      return text("←");
    case "feed.next":
      return text("→");
    case "lot.refresh":
      return text("Обновить");
    case "lot.history":
      return text("Ставки");
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
    case "favorites.prev":
      return text("←");
    case "favorites.next":
      return text("→");
    case "favorites.back":
      return text("‹ Лоты");
    case "lot.bid-step":
      return text(`По шагу (${money(button.amount)})`);
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
          block.kind === "name-settings",
      );
      return text(
        (choice?.kind === "name-choice" ||
          choice?.kind === "raffle-name-choice" ||
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
      return text("Лоты");
    case "feed.raffle":
    case "root.raffle":
      return text(raffleButtonLabel);
    case "raffle.register":
      return text(registerLabel);
    case "raffle.cancel":
      return text(cancelRegistrationLabel);
    case "raffle.back":
      return text("‹ Лоты");
    case "raffle.return":
      return text(`‹ ${raffleBackName}`);
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

// «✔️ Да, …» называет действие и сумму (дизайн-код, «Клавиатура»).
function confirmLabel(blocks: readonly AuctionBlock[]): string {
  const confirm = blocks.find((block) => block.kind === "confirm");
  if (confirm?.kind !== "confirm") return confirmYesLabel("подтвердить");
  return confirm.command === "bid"
    ? confirmYesLabel(`поставить ${money(confirm.amount)}`)
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
