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
// лота — тело общего пакета (PER-306), лист ставки — PER-317. Правила экрана
// — дизайн-код (docs/design/bot/design-code.md): жирный заголовок, HTML,
// последний ряд `[‹ Родитель] [Меню]`, кадр отказа с выходом.
export type AuctionEntryScreen =
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
  | { kind: "unavailable"; exit: UnavailableExit };

// Выход кадра «недоступно». `retry` — «Повторить» с данными действия, на
// котором случился отказ: хранилища у экранов нет, и повтор едет в кнопке.
// `enter` — отказ на входе: повтор зовёт тот же `RequestRole`, и «Меню» рядом
// с ним нет — оно разрешило бы личность без заявки и показало бы человеку
// «заявка на рассмотрении», которой нет. `answer` — отказ на ответе на вопрос:
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

const context = "Аукцион сообщества: лоты, ставки и итоги торгов.";
const untitled = "Лот без названия";

// Тексты отказов принадлежат этой оболочке (ADR-044). Отказ в `public` —
// блокировка (ADR-060, пункт 12), поэтому `declined` Identity этому боту не
// отдаёт; текст держит ответ на случай, если отдаст. Первое предложение —
// жирное: оно кадру отказа вместо заголовка.
export const deniedTexts: Record<AuctionDenial, string> = {
  "not-admitted":
    "<b>Заявка на рассмотрении.</b> Участие в аукционе пока не открыто.",
  declined: "<b>Заявка на участие в аукционе отклонена.</b>",
  blocked: "<b>Доступ к аукциону закрыт.</b>",
};

const faqTitle = "Правила и FAQ";
// Вход в меню с любого экрана. Отметку ознакомления с FAQ ставит не он, а
// возврат под самим FAQ.
const menuButton = { text: "Меню", callback_data: entryCallback("menu") };
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
// в строке списка и в кавычках второй строкой оно читалось бы как чужая
// запись.
const oneLine = (title: string) =>
  truncate(title.replace(/\s+/g, " ").trim(), TITLE_LIMIT);

// Название лота на экранах листа ставки и хронологии — абзац в кавычках.
const quoted = (title: string | undefined) =>
  title === undefined ? undefined : `«${escapeHtml(oneLine(title))}»`;

// Строка списка в теле (дизайн-код, «Списки»): маркер, затем поля через «—».
const bullet = (line: string) => `• ${line}`;

export function renderEntryScreen(
  screen: AuctionEntryScreen,
  options: RenderOptions,
): RenderedScreen {
  const faq = options.faq ?? defaultFaq;
  switch (screen.kind) {
    case "faq": {
      // Тексты организатора показываются дословно: разметки в них нет.
      const section = (name: string, text: string) =>
        `${heading(name)}\n${escapeHtml(text)}`;
      return {
        id: "faq",
        format: "html",
        text: [
          heading(faqTitle),
          section("Что продаём", faq.items),
          section("Куда идут средства", faq.purpose),
          section("Правила ставок", "Отменить сделанную ставку нельзя."),
          section("Почти одновременные ставки", faq.simultaneousBids),
          section("Сбой и потеря связи", faq.connectionFailure),
          section("Доставка победителю", faq.delivery),
        ].join("\n\n"),
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
          // Возврат под FAQ — единственная кнопка, которая ставит отметку
          // ознакомления.
          [{ text: "‹ Меню", callback_data: entryCallback("read") }],
        ],
      };
    }
    case "menu":
      return {
        id: "menu",
        format: "html",
        text: screenText("Меню", context),
        // Два списка — пара одним рядом, как разделы меню хаба.
        keyboard: [
          [
            { text: "Аукционы", callback_data: entryCallback("auctions") },
            { text: "Прошедшие", callback_data: entryCallback("past") },
          ],
          [{ text: faqTitle, callback_data: entryCallback("faq") }],
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
      // Родителя ленты тело не знает: возврат в её список ставит оболочка.
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
              menuButton,
            ],
          ],
        };
      }
      // Лот, хронология и выбор имени: возврат — последняя кнопка тела, и в
      // один ряд с «Меню» её ставит оболочка.
      const back = body.keyboard.at(-1) ?? [];
      return {
        ...body,
        keyboard: [...body.keyboard.slice(0, -1), [...back, menuButton]],
      };
    }
    // Кадры ожидания допуска и блокировки в дерево не входят: экранов за ними
    // у человека нет, и клавиатуры тоже.
    case "denied":
      return {
        id: "denied",
        format: "html",
        text: deniedTexts[screen.reason],
        keyboard: [],
      };
    case "outdated":
      return {
        id: "outdated",
        format: "html",
        text: "<b>Этот экран устарел.</b> Открой меню и повтори действие.",
        keyboard: [[menuButton]],
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
        text: `<b>Аукцион сейчас недоступен.</b> ${
          exit.kind === "answer"
            ? "Пришли ответ ещё раз через минуту."
            : "Попробуй ещё раз через минуту."
        }`,
        keyboard: [
          exit.kind === "retry"
            ? [retry(exit.data), menuButton]
            : exit.kind === "enter"
              ? [retry(exit.data)]
              : [menuButton],
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
    keyboard: [
      [{ text: "‹ FAQ", callback_data: entryCallback("faq") }, menuButton],
    ],
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
// на аукцион в теле и ряд на аукцион в клавиатуре, листание стрелками и
// возврат в меню. Пустой список говорит об этом текстом, а не пустой
// клавиатурой.
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
      ...(paging.length === 0 ? [] : [paging]),
      [{ text: "‹ Меню", callback_data: entryCallback("menu") }],
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
export function auctionLine(
  auction: AuctionSummary,
  timeZone: string,
  now?: Date,
): string {
  return `${auctionDay(auction, timeZone, now)} — ${stageLabels[auction.stage]}, ${lotCount(auction.lotCount)}`;
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
    return { id, keyboard, ...renderCard(lot, options) };
  }
  const history = body.blocks.find(
    (block): block is HistoryBlock => block.kind === "history",
  );
  if (id === "history" && history !== undefined) {
    return { id, keyboard, ...renderHistory(history, options) };
  }
  const feed = body.blocks.find(
    (block): block is FeedBlock => block.kind === "feed",
  );
  if (feed === undefined) {
    throw new Error("auction body without a feed, a lot or a history block");
  }
  // Пустая лента несёт заголовок так же, как заполненная; строки лотов в теле
  // идут в порядке ленты — по возрастанию цены.
  return {
    id,
    keyboard,
    format: "html",
    text: screenText(
      paged("Лоты", feed),
      feed.lots.length === 0
        ? "Лотов пока нет."
        : feed.lots
            .map((item) =>
              bullet(
                `${escapeHtml(oneLine(item.title ?? untitled))} — ${priceLabel(item.status)}`,
              ),
            )
            .join("\n"),
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
      case "accepted":
        return block.command === "bid" ? "bid-accepted" : "proxy-accepted";
      case "question":
        return `${block.question}-question`;
      case "name-choice":
        return "name-choice";
      case "result":
        return "command-result";
      case "answer-refused":
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

function isConfirm(id: ScreenId): boolean {
  return id === "bid-confirm" || id === "proxy-confirm";
}
type HistoryBlock = Extract<AuctionBlock, { kind: "history" }>;
type FeedBlock = Extract<AuctionBlock, { kind: "feed" }>;

// Экраны листа ставки (PER-317): подтверждение, исход, вопрос и выбор имени. Тексты
// принадлежат оболочке; слова — те же, что у бота хаба, словарь один.
function renderLeaf(
  blocks: readonly AuctionBlock[],
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

// Подтверждение (дизайн-код, «Подтверждение»): заголовок-вопрос с суммой,
// название лота в кавычках, затем что нельзя отменить.
function confirmText(
  block: Extract<AuctionBlock, { kind: "confirm" }>,
): string {
  return block.command === "bid"
    ? screenText(
        `Поставить ${money(block.amount)}?`,
        quoted(block.title),
        "Отменить ставку нельзя.",
      )
    : screenText(
        `Включить автоставку до ${money(block.amount)}?`,
        quoted(block.title),
        `${proxyGap(block.currentPrice, block.amount)}\nЛимит видишь только ты.`,
      );
}

// Принятая команда — свой экран (PER-473): сумма в заголовке, карточку с
// новой ценой открывает «К лоту».
function acceptedText(
  block: Extract<AuctionBlock, { kind: "accepted" }>,
): string {
  return block.command === "bid"
    ? screenText(`Ставка ${money(block.amount)} принята`, quoted(block.title))
    : screenText(
        `Автоставка до ${money(block.amount)} включена`,
        quoted(block.title),
        "Лимит видишь только ты.",
      );
}

function questionText(
  block: Extract<AuctionBlock, { kind: "question" }>,
): string {
  // Вопрос (дизайн-код, «Вопросы»): под заголовком одним абзацем — что
  // прислать, «Сейчас: …» и образец. Непринятый ответ — свой экран.
  const current = (prefix: string) =>
    block.current === undefined
      ? []
      : [`Сейчас: ${prefix}${money(block.current)}`];
  switch (block.question) {
    case "bid":
      return screenText(
        "Своя сумма",
        [
          "Пришли сумму ставки в рублях.",
          ...current("от "),
          "Например: 1 500",
        ].join("\n"),
      );
    case "proxy":
      return screenText(
        "Автоставка",
        [
          "Пришли лимит в рублях: до этой суммы бот будет ставить за тебя по шагу. Лимит видишь только ты.",
          ...current(""),
          "Например: 3 000",
        ].join("\n"),
      );
    case "alias":
      return screenText(
        "Псевдоним",
        [
          "Пришли псевдоним до 32 символов. Участники увидят его со звёздочкой.",
          "Например: Сова",
        ].join("\n"),
      );
    default: {
      const _exhaustive: never = block.question;
      return _exhaustive;
    }
  }
}

function nameChoiceText(
  block: Extract<AuctionBlock, { kind: "name-choice" }>,
): string {
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

// Автоставка объясняется разницей цены и лимита (RFC-007): на столько бот
// может поднять цену за человека, перебивая чужие ставки по шагу.
function proxyGap(currentPrice: Money, limit: Money): string {
  const gap = limit.minorUnits - currentPrice.minorUnits;
  return gap > 0
    ? `Цена сейчас ${money(currentPrice)}: бот будет перебивать чужие ставки по шагу и поднимет её не больше чем на ${money({ minorUnits: gap, currency: limit.currency })}.`
    : `Цена сейчас ${money(currentPrice)}: лимит не выше неё, и перебивать бот не будет.`;
}

// Исход — свой экран (дизайн-код, «Экран исхода», PER-472): исход в
// заголовке без точки, название лота в кавычках, затем пояснение. Отказ
// называет цену сам; принятая команда — экран `accepted`.
type Outcome = { title: string; detail?: string };

function outcomeText(outcome: Outcome, lotTitle: string | undefined): string {
  return screenText(
    outcome.title,
    quoted(lotTitle),
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
// название лота в кавычках и строки ставок по порядку журнала. Восемь строк
// на странице держат текст далеко под лимитом сообщения при любом названии.
function renderHistory(
  block: HistoryBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format"> {
  return {
    format: "html",
    text: screenText(
      paged("Ставки", block),
      quoted(block.title ?? untitled),
      block.entries.length === 0
        ? "Ставок пока нет."
        : block.entries
            .map((entry) => bullet(escapeHtml(historyLine(entry, options))))
            .join("\n"),
    ),
  };
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

// Карточка лота (дизайн-код, «Карточка лота»): название, группа статуса,
// группа цены и лидера, описание — группы через пустую строку, строки «ключ:
// значение» без точки. Rich-карточка размечается блоками: перенос строки в её
// `html` не рисуется, поэтому группа и абзац описания — свой `<p>`, строки
// внутри — `<br>`, а фото адаптер ставит последним блоком. Предела подписи у
// неё нет. В `plain` та же карточка уходит обычным сообщением с HTML и без
// фото. Исход команды карточка не несёт: он — свой экран (PER-472).
function renderCard(
  block: LotBlock,
  options: RenderOptions,
): Pick<RenderedScreen, "text" | "format" | "photo"> {
  const title = truncate(block.card?.title ?? untitled, TITLE_LIMIT);
  const groups = statusGroups(block, options);
  const rich = (options.presentation ?? "rich") === "rich";
  const description = fitDescription(
    title,
    block.card?.description ?? "",
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

// Группы карточки: статус словом, затем факты о цене и лидере, если они есть.
// Слова статусов — дизайн-код, «Карточка лота».
function statusGroups(block: LotBlock, options: RenderOptions): string[][] {
  const { status, participantName } = block;
  switch (status.kind) {
    case "draft":
      return [["Статус: готовится к торгам"]];
    case "scheduled":
      return [
        ["Статус: торги ещё не начались"],
        [`Стартовая цена: ${money(status.startingPrice)}`],
      ];
    case "trading":
      return [
        ["Статус: идут торги"],
        [
          `Цена: ${money(status.currentPrice)}`,
          leaderLine(status.leaderId, participantName),
          ...(block.nextPrice === undefined
            ? []
            : [`Следующая ставка: от ${money(block.nextPrice)}`]),
          ...(block.fixedStep === undefined
            ? []
            : [`Шаг: ${money(block.fixedStep)}`]),
          ...(status.deadline === undefined
            ? []
            : [
                `Торги до: ${readableMoment(status.deadline, options.timeZone, options.now)}`,
              ]),
          ...proxyLine(block),
        ],
      ];
    case "held":
      return [
        ["Статус: ждёт финала"],
        [
          `Цена: ${money(status.currentPrice)}`,
          leaderLine(status.leaderId, participantName),
        ],
      ];
    case "sold":
      return [
        ["Статус: продан"],
        [
          `Цена продажи: ${money(status.price)}`,
          participantName === undefined
            ? "Победитель: определён"
            : `Победитель: ${participantName}`,
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

// Свой лимит смотрящего: чужих Auction не отдаёт, и строка говорит, что этот
// виден только ему.
function proxyLine(block: LotBlock): string[] {
  return block.viewerProxyLimit === undefined
    ? []
    : [
        `Твоя автоставка: до ${money(block.viewerProxyLimit)} (видишь только ты)`,
      ];
}

// Имени нет, а лидер есть — Auction не отдал имя. Идентификатор вместо имени
// человеку не показывается.
function leaderLine(
  leaderId: string | undefined,
  participantName: string | undefined,
): string {
  if (leaderId === undefined) return "Лидер: пока нет";
  return participantName === undefined
    ? "Лидер: есть"
    : `Лидер: ${participantName}`;
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
    case "accepted.lot":
    case "result.lot":
      return text("К лоту");
    case "answer.retry":
      return text("Ввести заново");
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

// Дата для чтения по дизайн-коду: «12 июня, сб, 19:04»; чужой год называется.
export function readableMoment(
  instant: string,
  timeZone: string,
  now?: Date,
): string {
  const parts = dateParts(instant, timeZone);
  return `${readableDay(instant, timeZone, now)}, ${parts("hour")}:${parts("minute")}`;
}
