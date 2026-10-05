import {
  type AnswerRefusal,
  type AuctionBlock,
  type AuctionButton,
  type AuctionDenial,
  type AuctionScreenBody,
  type BidOriginView,
  type CommandResult,
  encodeAuctionCallback,
  type FeedItem,
  type HistoryItem,
  type LotStatusView,
  MAX_COMMAND_AMOUNT,
  type Money,
} from "@solguficky/auction-bot-ui";
import type {
  AuctionListPage,
  AuctionStage,
  AuctionSummary,
} from "./auctions.js";
import type { Presentation } from "./config.js";
import {
  defaultFaq,
  entryCallback,
  type FaqContent,
  type ListAction,
  listCallback,
} from "./faq.js";
import type { ScreenId } from "./screen-catalog.js";

// Оболочка бота аукциона (ADR-044, «Один аукцион, две оболочки»). Экран здесь
// корневой: короткий контекст для пришедшего по пересланной ссылке и тело из
// общего пакета. Доступа к хабу он не обещает. Тексты принадлежат этому боту и
// с хабом не делятся, даже когда совпадают.
//
// Общий FAQ, меню и списки аукционов (PER-453) — оболочка. Лента и карточка
// лота — тело общего пакета (PER-306), лист ставки — PER-317: подтверждение,
// вопросы и выбор имени написаны по дизайн-коду сразу.
export type AuctionEntryScreen =
  | { kind: "welcome" }
  | { kind: "faq" }
  | { kind: "menu" }
  | { kind: "auctions"; list: AuctionListPage }
  | { kind: "past"; list: AuctionListPage }
  | { kind: "details" }
  | { kind: "question" }
  // `parent` — список, в котором аукцион ленты стоит сейчас: туда ведёт
  // возврат ленты. Карточке и хронологии он не нужен.
  | { kind: "auction"; body: AuctionScreenBody; parent?: ListAction }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "outdated" }
  | { kind: "unavailable" };

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
   * rich-сообщение, текст которого — его `html` (ADR-034). Без неё текст
   * уходит как есть.
   */
  format?: "html" | "rich";
  // Изображение rich-карточки лота: адаптер ставит его последним блоком. Байты
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

const context = "Аукцион сообщества.";
const untitled = "Лот без названия";

// Тексты отказов принадлежат этой оболочке (ADR-044). Отказ в `public` —
// блокировка (ADR-060, пункт 12), поэтому `declined` Identity этому боту не
// отдаёт; текст держит ответ на случай, если отдаст.
export const deniedTexts: Record<AuctionDenial, string> = {
  "not-admitted": "Заявка на рассмотрении. Участие в аукционе пока не открыто.",
  declined: "Заявка на участие в аукционе отклонена.",
  blocked: "Доступ к аукциону закрыт.",
};

const faqButton = {
  text: "Правила и FAQ",
  callback_data: entryCallback("faq"),
};
const menuButton = { text: "В меню", callback_data: entryCallback("menu") };
// Вход в меню по словарю дизайн-кода. Экраны, написанные по нему сразу, ставят
// эту кнопку; «В меню» остаётся у остальных до перевёрстки (PER-463).
const menuNavButton = { text: "Меню", callback_data: entryCallback("menu") };

export function renderEntryScreen(
  screen: AuctionEntryScreen,
  options: RenderOptions,
): RenderedScreen {
  const faq = options.faq ?? defaultFaq;
  switch (screen.kind) {
    case "faq":
      return {
        id: "faq",
        text: [
          "Правила и FAQ",
          `Что продаём\n${faq.items}`,
          `Куда идут средства\n${faq.purpose}`,
          "Правила ставок\nОтменить сделанную ставку нельзя.",
          `Почти одновременные ставки\n${faq.simultaneousBids}`,
          `Сбой и потеря связи\n${faq.connectionFailure}`,
          `Доставка победителю\n${faq.delivery}`,
        ].join("\n\n"),
        keyboard: [
          [menuButton],
          [
            faq.detailsUrl === undefined
              ? {
                  text: "Прочитать подробнее",
                  callback_data: entryCallback("details"),
                }
              : { text: "Прочитать подробнее", url: faq.detailsUrl },
          ],
          [
            faq.questionUrl === undefined
              ? {
                  text: "Задать вопрос",
                  callback_data: entryCallback("question"),
                }
              : { text: "Задать вопрос", url: faq.questionUrl },
          ],
        ],
      };
    case "menu":
      return {
        id: "menu",
        text: `${context}\nВыберите раздел.`,
        keyboard: [
          [{ text: "Аукционы", callback_data: entryCallback("auctions") }],
          [{ text: "Прошедшие", callback_data: entryCallback("past") }],
          [faqButton],
        ],
      };
    case "auctions":
    case "past":
      return renderList(screen.kind, screen.list, options);
    case "details":
      return {
        id: "details",
        text: "Организатор ещё не указал ссылку на подробные правила.",
        keyboard: [[faqButton], [menuButton]],
      };
    case "question":
      return {
        id: "question",
        text: "Организатор ещё не указал, куда направлять вопросы.",
        keyboard: [[faqButton], [menuButton]],
      };
    case "welcome":
      return {
        id: "welcome",
        text: `${context}\nЛоты появятся здесь, когда начнутся торги.`,
        keyboard: [],
      };
    case "auction": {
      const body = renderBody(screen.body, options);
      // Подтверждение и вопрос несут только свои ряды: «Да» и «Нет», «Отмена».
      if (body.asks === true || isConfirm(body.id)) return body;
      // Лента возвращает в свой список: возврат и «Меню» — один последний
      // ряд, боковой кнопки FAQ нет (дизайн-код, «Навигация»).
      if (body.id === "feed") {
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
              menuNavButton,
            ],
          ],
        };
      }
      // Хронология и выбор имени написаны по дизайн-коду сразу: возврат тела
      // и «Меню» — один последний ряд, боковой кнопки FAQ нет.
      if (body.id === "history" || body.id === "name-choice") {
        const back = body.keyboard.at(-1) ?? [];
        return {
          ...body,
          keyboard: [...body.keyboard.slice(0, -1), [...back, menuNavButton]],
        };
      }
      return {
        ...body,
        keyboard: [...body.keyboard, [faqButton], [menuButton]],
      };
    }
    case "denied":
      return {
        id: "denied",
        text: deniedTexts[screen.reason],
        keyboard: [],
      };
    case "outdated":
      return {
        id: "outdated",
        text: "Этот экран устарел. Отправьте /start, чтобы открыть аукцион заново.",
        keyboard: [[faqButton]],
      };
    case "unavailable":
      return {
        id: "unavailable",
        text: "Аукцион сейчас недоступен. Попробуйте позже.",
        keyboard: [[faqButton]],
      };
    default: {
      const _exhaustive: never = screen;
      return _exhaustive;
    }
  }
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

// Список аукционов по дизайн-коду: жирный заголовок с номером страницы, ряд на
// аукцион, листание стрелками и возврат в меню. Пустой список говорит об этом
// текстом, а не пустой клавиатурой.
function renderList(
  kind: ListAction,
  list: AuctionListPage,
  options: RenderOptions,
): RenderedScreen {
  const { title, empty } = listTexts[kind];
  const heading =
    list.pageCount === 1
      ? title
      : `${title} · ${list.page + 1} из ${list.pageCount}`;
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
    text: [
      `<b>${escapeHtml(heading)}</b>`,
      list.auctions.length === 0 ? empty : "Выберите аукцион.",
    ].join("\n\n"),
    keyboard: [
      ...list.auctions.map((auction) => [
        {
          text: auctionLabel(auction, kind, options.timeZone),
          callback_data: encodeAuctionCallback({
            kind: "feed",
            auctionId: auction.auctionId,
            page: 0,
          }),
        },
      ]),
      ...(paging.length === 0 ? [] : [paging]),
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
    ],
  };
}

// Строка аукциона: день начала онлайн-фазы, этап и число лотов. У прошедших
// этап один и тот же, строки он не различает и в их списке не пишется.
export function auctionLabel(
  auction: AuctionSummary,
  kind: ListAction,
  timeZone: string,
): string {
  return [
    auction.opensAt === undefined
      ? "Без онлайн-торгов"
      : readableDay(auction.opensAt, timeZone),
    ...(kind === "auctions" ? [stageLabels[auction.stage]] : []),
    lotCount(auction.lotCount),
  ].join(" · ");
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
  const tens = count % 100;
  const ones = count % 10;
  const word =
    tens >= 11 && tens <= 14
      ? "лотов"
      : ones === 1
        ? "лот"
        : ones >= 2 && ones <= 4
          ? "лота"
          : "лотов";
  return `${count} ${word}`;
}

// День для чтения по дизайн-коду, без времени: «12 октября, сб».
function readableDay(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    weekday: "short",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("day")} ${part("month")}, ${part("weekday")}`;
}

function renderBody(
  body: AuctionScreenBody,
  options: RenderOptions,
): RenderedScreen {
  const items = new Map<string, FeedItem>();
  for (const block of body.blocks) {
    if (block.kind === "feed") {
      for (const item of block.lots) items.set(item.lotId, item);
    }
  }
  const keyboard = body.keyboard.map((row) =>
    row.map((button) => renderButton(button, items, body.blocks)),
  );
  const id = screenOf(body.blocks);
  const leaf = renderLeaf(body.blocks);
  if (leaf !== undefined) return { id, keyboard, ...leaf };
  const lot = body.blocks.find(
    (block): block is LotBlock => block.kind === "lot",
  );
  if (id === "lot" && lot !== undefined) {
    const result = body.blocks.find(
      (block): block is ResultBlock => block.kind === "result",
    );
    return { id, keyboard, ...renderCard(lot, options, result?.result) };
  }
  const history = body.blocks.find(
    (block): block is HistoryBlock => block.kind === "history",
  );
  if (id === "history" && history !== undefined) {
    return { id, keyboard, ...renderHistory(history, options) };
  }
  // Лента — текст без разметки до перевёрстки оболочки (PER-463).
  return {
    id,
    keyboard,
    text: truncate(
      [context, ...body.blocks.map((block) => renderBlock(block))].join("\n\n"),
      TEXT_LIMIT,
    ),
  };
}

// Запись каталога для тела: тело с карточкой — экран лота, с лентой — лента.
// Новый вид блока не становится лентой молча: без своей ветки он не собирается.
function screenOf(blocks: readonly AuctionBlock[]): ScreenId {
  let screen: ScreenId = "feed";
  for (const block of blocks) {
    switch (block.kind) {
      case "lot":
        screen = "lot";
        break;
      case "history":
        screen = "history";
        break;
      case "confirm":
        return block.command === "bid" ? "bid-confirm" : "proxy-confirm";
      case "question":
        return `${block.question}-question`;
      case "name-choice":
        return "name-choice";
      case "feed":
      case "result":
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
type ResultBlock = Extract<AuctionBlock, { kind: "result" }>;

function isConfirm(id: ScreenId): boolean {
  return id === "bid-confirm" || id === "proxy-confirm";
}
type HistoryBlock = Extract<AuctionBlock, { kind: "history" }>;

// Строка ленты. Карточку лота собирает `renderCard`: у неё своя разметка.
function renderBlock(block: AuctionBlock): string {
  switch (block.kind) {
    case "feed":
      return block.lots.length === 0
        ? "Лотов пока нет."
        : `Лоты по возрастанию цены, страница ${block.page + 1} из ${block.pageCount}.`;
    case "lot":
    case "history":
    case "result":
    case "confirm":
    case "question":
    case "name-choice":
      return "";
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

// Экраны листа ставки (PER-317): подтверждение, вопрос и выбор имени. Тексты
// принадлежат оболочке; слова — те же, что у бота хаба, словарь один.
function renderLeaf(
  blocks: readonly AuctionBlock[],
): Pick<RenderedScreen, "text" | "format" | "asks"> | undefined {
  for (const block of blocks) {
    switch (block.kind) {
      case "confirm":
        return { format: "html", text: confirmText(block) };
      case "question":
        return { format: "html", text: questionText(block), asks: true };
      case "name-choice":
        return { format: "html", text: nameChoiceText(block) };
      default:
        break;
    }
  }
  return undefined;
}

const lotLine = (title: string | undefined) =>
  title === undefined
    ? []
    : [`Лот: ${escapeHtml(truncate(title, TITLE_LIMIT))}`];

function confirmText(
  block: Extract<AuctionBlock, { kind: "confirm" }>,
): string {
  return block.command === "bid"
    ? [
        "<b>Ставка</b>",
        ...lotLine(block.title),
        `Сумма: ${money(block.amount)}`,
        "Отменить ставку нельзя.",
      ].join("\n")
    : [
        "<b>Автоставка</b>",
        ...lotLine(block.title),
        `Лимит: ${money(block.amount)}`,
        proxyGap(block.currentPrice, block.amount),
        "Лимит видишь только ты.",
      ].join("\n");
}

function questionText(
  block: Extract<AuctionBlock, { kind: "question" }>,
): string {
  const reason =
    block.refusal === undefined ? [] : [answerRefusalText(block.refusal)];
  const current = (prefix: string) =>
    block.current === undefined
      ? []
      : [`Сейчас: ${prefix}${money(block.current)}`];
  switch (block.question) {
    case "bid":
      return [
        ...reason,
        "<b>Своя сумма</b>",
        "Пришли сумму ставки в рублях.",
        ...current("от "),
        "Например: 1 500",
      ].join("\n");
    case "proxy":
      return [
        ...reason,
        "<b>Автоставка</b>",
        "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
        ...current(""),
        "Например: 3 000",
      ].join("\n");
    case "alias":
      return [
        ...reason,
        "<b>Псевдоним</b>",
        "Пришли псевдоним до 32 символов. Участники увидят его со звёздочкой.",
        "Например: Сова",
      ].join("\n");
    default: {
      const _exhaustive: never = block.question;
      return _exhaustive;
    }
  }
}

function nameChoiceText(
  block: Extract<AuctionBlock, { kind: "name-choice" }>,
): string {
  return [
    ...(block.refusal === undefined ? [] : [answerRefusalText(block.refusal)]),
    "<b>Имя в аукционе</b>",
    "Имя видно всем участникам аукциона рядом с твоими ставками. После первой ставки его не поменять.",
    block.username === undefined
      ? "Ника в Telegram у тебя нет: возьми псевдоним."
      : `Ставь под ником @${escapeHtml(block.username)} или возьми псевдоним.`,
  ].join("\n");
}

// Автоставка объясняется разницей цены и лимита (RFC-007): на столько бот
// может поднять цену за человека, перебивая чужие ставки по шагу.
function proxyGap(currentPrice: Money, limit: Money): string {
  const gap = limit.minorUnits - currentPrice.minorUnits;
  return gap > 0
    ? `Цена сейчас ${money(currentPrice)}: бот будет перебивать чужие ставки по шагу и поднимет её не больше чем на ${money({ minorUnits: gap, currency: limit.currency })}.`
    : `Цена сейчас ${money(currentPrice)}: лимит не выше неё, и перебивать бот не будет.`;
}

const answerRefusals: Record<AnswerRefusal, string> = {
  "not-text": "Нужен ответ текстом.",
  "not-a-number": "Это не сумма.",
  "other-currency": "Ставки принимаются только в рублях.",
  "not-positive": "Сумма должна быть больше нуля.",
  "too-precise": "Копеек — не больше двух знаков.",
  "too-large": `Бот принимает суммы до ${money({ minorUnits: MAX_COMMAND_AMOUNT, currency: "RUB" })}.`,
  "alias-invalid": "Такой псевдоним не подходит.",
  "alias-taken": "Этот псевдоним уже занят.",
  "name-frozen": "Имя уже не поменять: ты ставил в этом аукционе.",
  "username-missing": "Ника в Telegram у тебя нет: возьми псевдоним.",
};

function answerRefusalText(refusal: AnswerRefusal): string {
  return answerRefusals[refusal];
}

// Исход команды — первая строка карточки (дизайн-код, «Доставка»): после «Да»
// человек видит и ответ Auction, и лот. Отказ называет цену сам.
export function resultText(result: CommandResult): string {
  if (result.kind === "unknown") {
    return "Аукцион не ответил. Проверь цену на карточке: команда могла пройти.";
  }
  if (result.kind === "accepted") {
    return result.command === "bid"
      ? `Ставка ${money(result.amount)} принята.`
      : `Автоставка до ${money(result.amount)} включена.`;
  }
  const { refusal } = result;
  switch (refusal.kind) {
    case "lot-not-open":
      return "Торги по лоту не идут.";
    case "lot-on-hold":
      return `Лот ждёт финала, ставки сейчас не принимаются. Цена: ${money(refusal.currentPrice)}.`;
    case "bid-below-minimum":
      return `Ставка ниже порога. Сейчас можно от ${money(refusal.minRequired)}.`;
    case "bid-not-at-next-price":
      return `В финале ставят ровно ${money(refusal.expected)}.`;
    case "bidder-is-leader":
      return `Ты уже лидируешь: цена ${money(refusal.currentPrice)} — твоя.`;
    case "currency-mismatch":
      return "Лот торгуется в другой валюте.";
    case "proxy-below-current-price":
      return `Лимит ниже текущей цены. Нужно от ${money(refusal.minLimit)}.`;
    case "proxy-disabled":
      return "Автоставка на этом лоте выключена.";
    // Выбор имени — свой экран, а не строка карточки: сюда отказ не доходит.
    case "display-name-not-chosen":
      return "Выбери имя в аукционе.";
    default: {
      const _exhaustive: never = refusal;
      return _exhaustive;
    }
  }
}

// Хронология ставок лота (PER-309): жирный заголовок с номером страницы,
// название лота и строки ставок по порядку журнала. Восемь строк на странице
// держат текст далеко под лимитом сообщения при любом названии.
function renderHistory(
  block: HistoryBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format"> {
  const title =
    block.pageCount === 1
      ? "Ставки"
      : `Ставки · ${block.page + 1} из ${block.pageCount}`;
  return {
    format: "html",
    text: [
      `<b>${escapeHtml(title)}</b>`,
      escapeHtml(truncate(block.title ?? untitled, TITLE_LIMIT)),
      block.entries.length === 0
        ? "Ставок пока нет."
        : block.entries
            .map((entry) => escapeHtml(historyLine(entry, options)))
            .join("\n"),
    ].join("\n\n"),
  };
}

// Строка ставки: когда, кто, сколько и как. Имени нет — Auction его не отдал,
// и строка остаётся без него: идентификатор человеку не показывается. Лимита
// прокси в строке нет — его нет и в теле.
function historyLine(entry: HistoryItem, options: RenderOptions): string {
  return [
    readableMoment(entry.occurredAt, options.timeZone),
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

// Карточка лота начинается с названия (дизайн-код, «Формат»). Rich-карточка
// размечается блоками: перенос строки в её `html` не рисуется, поэтому абзац
// описания — свой `<p>`, строки внутри абзаца и строки статуса разделяет
// `<br>`, а фото адаптер ставит последним блоком. Предела подписи у неё нет.
// В `plain` та же карточка уходит обычным сообщением с HTML и без фото.
function renderCard(
  block: LotBlock,
  options: RenderOptions,
  result?: CommandResult,
): Pick<RenderedScreen, "text" | "format" | "photo"> {
  const title = truncate(block.card?.title ?? untitled, TITLE_LIMIT);
  const status = statusLines(block, options);
  const note = result === undefined ? [] : [escapeHtml(resultText(result))];
  const rich = (options.presentation ?? "rich") === "rich";
  const description = fitDescription(
    title,
    block.card?.description ?? "",
    status,
    rich ? RICH_TEXT_LIMIT : TEXT_LIMIT,
  );
  if (!rich) {
    return {
      format: "html",
      text: [
        ...note,
        `<b>${escapeHtml(title)}</b>`,
        escapeHtml(description),
        escapeHtml(status.join("\n")),
      ]
        .filter((part) => part !== "")
        .join("\n\n"),
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
  const blocks = [...kept, ...(rest.length === 0 ? [] : [rest]), status];
  const image = block.card?.image;
  return {
    format: "rich",
    text: `${note.map((line) => `<p>${line}</p>`).join("")}<h1>${escapeHtml(title)}</h1>${blocks
      .map((lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`)
      .join("")}`,
    ...(image === undefined
      ? {}
      : { photo: { lotId: block.lotId, version: image.version } }),
  };
}

function statusLines(block: LotBlock, options: RenderOptions): string[] {
  const { status, participantName } = block;
  switch (status.kind) {
    case "draft":
      return ["Лот готовится к торгам."];
    case "scheduled":
      return [
        "Торги ещё не начались.",
        `Стартовая цена: ${money(status.startingPrice)}.`,
      ];
    case "trading":
      return [
        `Текущая цена: ${money(status.currentPrice)}.`,
        leaderLine(status.leaderId, participantName),
        ...(block.nextPrice === undefined
          ? []
          : [`Следующая ставка — от ${money(block.nextPrice)}.`]),
        ...(block.fixedStep === undefined
          ? []
          : [`Шаг: ${money(block.fixedStep)}.`]),
        ...(status.deadline === undefined
          ? []
          : [`Торги до ${moment(status.deadline, options.timeZone)}.`]),
        ...proxyLine(block),
      ];
    case "held":
      return [
        "Лот ждёт финала.",
        `Цена: ${money(status.currentPrice)}.`,
        leaderLine(status.leaderId, participantName),
      ];
    case "sold":
      return [
        `Продан за ${money(status.price)}.`,
        participantName === undefined
          ? "Победитель определён."
          : `Победитель: ${participantName}.`,
      ];
    case "unsold":
      return ["Торги закончились, лот не продан."];
    case "withdrawn":
      return ["Лот снят с торгов."];
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Свой лимит смотрящего: чужих Auction не отдаёт, и строка говорит, что этот
// виден только ему.
function proxyLine(block: LotBlock): string[] {
  return block.viewerProxyLimit === undefined
    ? []
    : [
        `Твоя автоставка: до ${money(block.viewerProxyLimit)}. Её видишь только ты.`,
      ];
}

// Имени нет, а лидер есть — Auction не отдал имя. Идентификатор вместо имени
// человеку не показывается.
function leaderLine(
  leaderId: string | undefined,
  participantName: string | undefined,
): string {
  if (leaderId === undefined) return "Ставок пока нет.";
  return participantName === undefined
    ? "Лидер есть."
    : `Лидер: ${participantName}.`;
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

// Обрезка по кодовым точкам: срез по UTF-16 разрезал бы суррогатную пару, и
// Telegram получил бы битую строку. Кодовая точка длиннее единицы UTF-16 не
// бывает короче, поэтому результат укладывается в `limit` единиц.
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > limit - 1) break;
    kept += point;
  }
  return `${kept}…`;
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
      return text(
        item === undefined
          ? untitled
          : `${shorten(item.title ?? untitled)} · ${priceLabel(item.status)}`,
      );
    }
    case "feed.prev":
      return text("‹ Предыдущие");
    case "feed.next":
      return text("Следующие ›");
    case "lot.refresh":
      return text("Обновить");
    case "lot.history":
      return text("Ставки");
    case "lot.back":
      return text("К лотам");
    case "history.prev":
      return text("←");
    case "history.next":
      return text("→");
    case "history.back":
      return text("‹ Лот");
    case "lot.bid-step":
      return text(`По шагу (${money(button.amount)})`);
    case "lot.bid-custom":
      return text("Своя сумма");
    case "lot.proxy":
      return text("Автоставка");
    case "confirm.yes":
      return { ...text(confirmLabel(blocks)), style: "danger" };
    case "confirm.no":
      return text("Нет");
    case "question.cancel":
      return text("Отмена");
    case "name.username": {
      const choice = blocks.find((block) => block.kind === "name-choice");
      return text(
        choice?.kind === "name-choice" && choice.username !== undefined
          ? `Ник @${choice.username}`
          : "Ник",
      );
    }
    case "name.alias":
      return text("Взять псевдоним");
    case "name.back":
      return text("‹ Лот");
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

// «Да, …» называет действие и сумму (дизайн-код, «Клавиатура»).
function confirmLabel(blocks: readonly AuctionBlock[]): string {
  const confirm = blocks.find((block) => block.kind === "confirm");
  if (confirm?.kind !== "confirm") return "Да, подтвердить";
  return confirm.command === "bid"
    ? `Да, поставить ${money(confirm.amount)}`
    : "Да, включить автоставку";
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

// Валюта у платформы одна — рубль, и у неё две цифры после запятой. Копейки
// показываются, только когда они есть.
export function money(amount: Money): string {
  const whole = amount.minorUnits % 100 === 0;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: amount.currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount.minorUnits / 100);
}

// Дата для чтения по дизайн-коду: «12 июня, сб, 19:04».
export function readableMoment(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((each) => each.type === type)?.value ?? "";
  return `${part("day")} ${part("month")}, ${part("weekday")}, ${part("hour")}:${part("minute")}`;
}

function moment(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instant));
}
