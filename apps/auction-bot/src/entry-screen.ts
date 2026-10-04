import type {
  AuctionBlock,
  AuctionButton,
  AuctionDenial,
  AuctionScreenBody,
  FeedItem,
  LotStatusView,
  Money,
} from "@solguficky/auction-bot-ui";
import type { Presentation } from "./config.js";
import { defaultFaq, entryCallback, type FaqContent } from "./faq.js";
import type { ScreenId } from "./screen-catalog.js";

// Оболочка бота аукциона (ADR-044, «Один аукцион, две оболочки»). Экран здесь
// корневой: короткий контекст для пришедшего по пересланной ссылке и тело из
// общего пакета. Доступа к хабу он не обещает. Тексты принадлежат этому боту и
// с хабом не делятся, даже когда совпадают.
//
// Общий FAQ и меню — оболочка. Лента и карточка лота — тело общего пакета
// (PER-306), ставка — PER-317.
export type AuctionEntryScreen =
  | { kind: "welcome" }
  | { kind: "faq" }
  | { kind: "menu" }
  | { kind: "auctions" }
  | { kind: "details" }
  | { kind: "question" }
  | { kind: "auction"; body: AuctionScreenBody }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "outdated" }
  | { kind: "unavailable" };

export type TelegramButton =
  | { text: string; callback_data: string }
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
};

export type RenderOptions = {
  faq?: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  timeZone: string;
  // Форма карточки лота; по умолчанию `rich`.
  presentation?: Presentation;
};

// Лимиты Bot API: обычное сообщение — в символах UTF-16 после разбора
// разметки, rich-сообщение — в символах текста.
export const TEXT_LIMIT = 4096;
export const RICH_TEXT_LIMIT = 32_768;

// Подпись кнопки лота — название и цена в одну строку экрана телефона.
const BUTTON_TITLE_LIMIT = 40;

// Длину названия Auction не ограничивает. Предел держит название заголовком,
// а не полотном над ценой и исходом.
const TITLE_LIMIT = 256;

const context = "Аукцион сообщества.";
const untitled = "Лот без названия";

const faqButton = {
  text: "Правила и FAQ",
  callback_data: entryCallback("faq"),
};
const menuButton = { text: "В меню", callback_data: entryCallback("menu") };

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
          [faqButton],
        ],
      };
    case "auctions":
      return {
        id: "auctions",
        text: "Аукционы\nКаталог пока не открыт. Он появится здесь, когда будет готов.",
        keyboard: [[faqButton], [menuButton]],
      };
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
      return {
        ...body,
        keyboard: [...body.keyboard, [faqButton], [menuButton]],
      };
    }
    case "denied":
      return {
        id: "denied",
        text:
          screen.reason === "blocked"
            ? "Доступ к аукциону закрыт."
            : "Заявка на рассмотрении. Участие в аукционе пока не открыто.",
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
    row.map((button) => renderButton(button, items)),
  );
  const id = screenOf(body.blocks);
  const lot = body.blocks.find(
    (block): block is LotBlock => block.kind === "lot",
  );
  if (id === "lot" && lot !== undefined) {
    return { id, keyboard, ...renderCard(lot, options) };
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

// Строка ленты. Карточку лота собирает `renderCard`: у неё своя разметка.
function renderBlock(block: AuctionBlock): string {
  switch (block.kind) {
    case "feed":
      return block.lots.length === 0
        ? "Лотов пока нет."
        : `Лоты по возрастанию цены, страница ${block.page + 1} из ${block.pageCount}.`;
    case "lot":
      return "";
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

// Карточка лота начинается с названия (дизайн-код, «Формат»). Rich-карточка
// размечается блоками: перенос строки в её `html` не рисуется, поэтому каждый
// абзац описания и каждая строка статуса — свой `<p>`, а фото адаптер ставит
// последним блоком. Предела подписи у неё нет, описание приходит целиком.
// В `plain` та же карточка уходит обычным сообщением с HTML и без фото.
function renderCard(
  block: LotBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format" | "photo"> {
  const title = truncate(block.card?.title ?? untitled, TITLE_LIMIT);
  const status = statusLines(block, options);
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
      text: [`<b>${escapeHtml(title)}</b>`, description, status.join("\n")]
        .filter((part) => part !== "")
        .map((part, index) => (index === 0 ? part : escapeHtml(part)))
        .join("\n\n"),
    };
  }
  const paragraphs = [
    ...description.split("\n").filter((line) => line.trim() !== ""),
    ...status,
  ];
  const image = block.card?.image;
  return {
    format: "rich",
    text: `<h1>${escapeHtml(title)}</h1>${paragraphs
      .map((line) => `<p>${escapeHtml(line)}</p>`)
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
    case "lot.back":
      return text("К лотам");
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
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

function moment(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instant));
}
