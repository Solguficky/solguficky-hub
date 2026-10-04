import type {
  AuctionBlock,
  AuctionButton,
  AuctionDenial,
  AuctionScreenBody,
  FeedItem,
  LotStatusView,
  Money,
} from "@solguficky/auction-bot-ui";
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
  // Изображение карточки лота: текст тогда уходит подписью к фото. Байты и
  // `file_id` достаёт адаптер Telegram, экрану достаточно ключа.
  photo?: { lotId: string; version: string };
};

export type RenderOptions = {
  faq?: FaqContent;
  // Пояс, в котором человек читает дедлайн лота.
  timeZone: string;
};

// Лимиты Bot API в символах UTF-16: подпись к фото короче сообщения.
export const CAPTION_LIMIT = 1024;
export const TEXT_LIMIT = 4096;

// Подпись кнопки лота — название и цена в одну строку экрана телефона.
const BUTTON_TITLE_LIMIT = 40;

// Длину названия Auction не ограничивает. Предел держит строки статуса — цену,
// лидера и дедлайн — внутри подписи к фото при любом названии.
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
  const photo = photoOf(body.blocks);
  const limit = photo === undefined ? TEXT_LIMIT : CAPTION_LIMIT;
  const text = fitWithin(
    [context, ...body.blocks.map((block) => renderBlock(block, options))],
    limit,
  );
  return {
    id: screenOf(body.blocks),
    text,
    keyboard: body.keyboard.map((row) =>
      row.map((button) => renderButton(button, items)),
    ),
    ...(photo === undefined ? {} : { photo }),
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

function photoOf(
  blocks: readonly AuctionBlock[],
): RenderedScreen["photo"] | undefined {
  for (const block of blocks) {
    if (block.kind === "lot" && block.card?.image !== undefined) {
      return { lotId: block.lotId, version: block.card.image.version };
    }
  }
  return undefined;
}

type Rendered = { head: string; description?: string; tail: string };

function renderBlock(block: AuctionBlock, options: RenderOptions): Rendered {
  switch (block.kind) {
    case "feed":
      return {
        head:
          block.lots.length === 0
            ? "Лотов пока нет."
            : `Лоты по возрастанию цены, страница ${block.page + 1} из ${block.pageCount}.`,
        tail: "",
      };
    case "lot": {
      const description = block.card?.description;
      return {
        head: truncate(block.card?.title ?? untitled, TITLE_LIMIT),
        ...(description === undefined || description === ""
          ? {}
          : { description }),
        tail: statusLines(block, options).join("\n"),
      };
    }
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

function statusLines(
  block: Extract<AuctionBlock, { kind: "lot" }>,
  options: RenderOptions,
): string[] {
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

// Описание — единственная часть экрана произвольной длины, поэтому под лимит
// Telegram режется оно. Остальное короче лимита при любом лоте.
function fitWithin(
  parts: readonly (string | Rendered)[],
  limit: number,
): string {
  const join = (description: (r: Rendered) => string | undefined) =>
    parts
      .map((part) =>
        typeof part === "string"
          ? part
          : [part.head, description(part), part.tail]
              .filter((line) => line !== undefined && line !== "")
              .join("\n\n"),
      )
      .join("\n\n");
  const full = join((r) => r.description);
  if (full.length <= limit) return full;
  const overflow = full.length - limit + 1;
  // Страховка на случай, когда резать нечего: лимит Bot API не нарушается.
  return truncate(
    join((r) =>
      r.description === undefined
        ? undefined
        : truncate(r.description, Math.max(1, r.description.length - overflow)),
    ),
    limit,
  );
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
