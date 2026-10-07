import type {
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  BidOriginView,
  FeedItem,
  HistoryItem,
  LotStatusView,
  Money,
} from "@solguficky/auction-bot-ui";
import { InlineKeyboard } from "grammy";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import type { ImageKey } from "../lot-photos.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { consoleViewData, lotFormData, lotNewData } from "../parse-callback.js";
import {
  acceptedScreen,
  confirmScreen,
  nameChoiceScreen,
  oneLine,
  questionScreen,
  quoted,
  resultText,
} from "./auction-bid.js";
import {
  bullet,
  buttonText,
  escapeHtml,
  nextRow,
  type Parent,
  pagedTitle,
  readableMoment,
  screenText,
  withNav,
  withNote,
} from "./kit.js";
import type { ScreenPhoto, ShownScreen } from "./show.js";

// Оболочка хаба для тела аукциона (ADR-044, «Один аукцион, две оболочки»;
// дизайн-код, «Аукцион: тело, шлюз, оболочка»). Тело — блоки и кнопки-действия
// общего пакета — одно на два бота; здесь блоки становятся текстом, действия —
// подписями, а последним рядом встаёт навигация хаба. Состав и порядок кнопок
// тела оболочка не меняет: кнопку, которой правило не допускает, убирает пакет.

export type AuctionView = {
  body: AuctionScreenBody;
  /** Родитель ленты: сходка аукциона либо «Ближайшие», если бот её не знает. */
  feedParent: Parent;
  presentation: "rich" | "plain";
  timeZone: string;
  today: CommunityDay;
  /** Фото карточки лота, уже готовое к отправке; нет — карточка без фото. */
  photo?: ScreenPhoto;
  /**
   * Смотрящий — администратор: оболочка добавляет входы в форму лота (PER-319).
   * Право это не решает — его проверяют Auction и Meetups на каждой команде.
   */
  canManage?: boolean;
  /**
   * Принимает ли аукцион новые лоты: `false` — онлайн-неделя открыта, и ряда
   * «Добавить лот» в ленте нет (PER-468). Статус аукциона лента тела не несёт,
   * его читает адаптер у пульта; не прочитал — отдаёт `true`, и ряд остаётся,
   * как и когда поле не задано: устаревшую кнопку защищает отказ `lots-frozen`
   * после вопроса.
   */
  canAddLots?: boolean;
};

// Входы в форму лота — ряды оболочки хаба, а не тела: у бота аукциона формы
// нет, и тело у двух ботов остаётся одним.
const addLotLabel = "Добавить лот";
const editLotLabel = "Изменить лот";
// Пульт аукциона (PER-320) — тоже ряд оболочки хаба под «Добавить лот».
const consoleLabel = "Пульт";

/**
 * Изображение карточки лота: байты и `file_id` достаёт адаптер, экрану хватает
 * ключа. `asks` — экран вопроса: адаптер шлёт его новым сообщением с
 * `force_reply` (дизайн-код, «Вопросы»).
 */
export type AuctionShown = {
  screen: ShownScreen;
  image?: ImageKey;
  asks?: true;
};

// Идентификатор фото в rich-сообщении: на него ссылается `tg://photo?id=`.
export const lotPhotoId = "lot";

const untitled = "Лот без названия";
// Длину названия Auction не ограничивает. Предел держит заголовок карточки и
// подпись кнопки внутри лимитов Telegram при любом названии.
const titleLimit = 256;
// Telegram режет обычное сообщение на 4096 символах UTF-16. У rich-карточки
// предела подписи нет, и описание в ней идёт целиком (дизайн-код, «Показ фото
// лота»); в режиме `plain` под предел режется только описание.
const plainTextLimit = 4096;

export function auctionScreen(view: AuctionView): AuctionShown {
  // Лист ставки (PER-317): подтверждение, исход, вопрос и выбор имени — свои
  // экраны.
  for (const block of view.body.blocks) {
    switch (block.kind) {
      case "confirm":
        return { screen: confirmScreen(block, view.body.keyboard, money) };
      case "accepted":
        return { screen: acceptedScreen(block, view.body.keyboard, money) };
      case "question":
        return {
          screen: questionScreen(block, view.body.keyboard, money),
          asks: true,
        };
      case "name-choice":
        return { screen: nameChoiceScreen(block, view.body.keyboard, money) };
      default:
        break;
    }
  }
  const lot = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "lot" }> =>
      block.kind === "lot",
  );
  if (lot !== undefined) return lotScreen(view, lot);
  const history = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "history" }> =>
      block.kind === "history",
  );
  if (history !== undefined) return { screen: historyScreen(view, history) };
  const feed = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "feed" }> =>
      block.kind === "feed",
  );
  if (feed === undefined) {
    // Тело без ленты, лота и хронологии пакет не отдаёт: новый вид блока не
    // становится лентой молча.
    throw new Error("auction body without a feed, a lot or a history block");
  }
  return { screen: feedScreen(view, feed) };
}

function feedScreen(
  view: AuctionView,
  feed: Extract<AuctionBlock, { kind: "feed" }>,
): ShownScreen {
  const items = new Map<string, FeedItem>(
    feed.lots.map((item) => [item.lotId, item]),
  );
  const keyboard = new InlineKeyboard();
  // Действие экрана стоит первым рядом, над лотами и листанием. После старта
  // онлайн-недели добавлять лот нельзя, и ряда нет; «Пульт» остаётся.
  if (view.canManage === true) {
    const auction = uuidToToken(feed.auctionId);
    if (view.canAddLots !== false) {
      keyboard.text(addLotLabel, lotNewData(auction)).row();
    }
    keyboard.text(consoleLabel, consoleViewData(auction));
  }
  for (const row of view.body.keyboard) {
    nextRow(keyboard);
    for (const button of row) {
      keyboard.text(feedLabel(button, items), button.callbackData);
    }
  }
  // Строки лотов в теле повторяют кнопки в порядке ленты — по возрастанию
  // цены (дизайн-код, «Списки»).
  return {
    id: "lots",
    text: screenText(
      pagedTitle("Лоты", { items: feed.lots, ...feed }),
      feed.lots.length === 0
        ? "Лотов пока нет."
        : feed.lots
            .map((item) =>
              bullet(
                `${escapeHtml(truncate(oneLine(item.title ?? untitled), titleLimit))} — ${priceLabel(item.status)}`,
              ),
            )
            .join("\n"),
    ),
    keyboard: withNav(keyboard, view.feedParent),
    format: "HTML",
  };
}

function feedLabel(
  button: AuctionButton,
  items: ReadonlyMap<string, FeedItem>,
): string {
  switch (button.action) {
    case "feed.open-lot": {
      const item = items.get(button.lotId);
      return item === undefined
        ? untitled
        : buttonText(`${item.title ?? untitled} · ${priceLabel(item.status)}`);
    }
    case "feed.prev":
      return "←";
    case "feed.next":
      return "→";
    case "lot.refresh":
    case "lot.bid-step":
    case "lot.bid-custom":
    case "lot.proxy":
    case "lot.history":
    case "lot.back":
    case "history.prev":
    case "history.next":
    case "history.back":
    case "confirm.yes":
    case "confirm.no":
    case "question.cancel":
    case "name.username":
    case "name.alias":
    case "name.back":
    case "accepted.lot":
      throw new Error(`action ${button.action} in a feed body`);
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

function lotScreen(
  view: AuctionView,
  lot: Extract<AuctionBlock, { kind: "lot" }>,
): AuctionShown {
  const keyboard = new InlineKeyboard();
  let back: Parent | undefined;
  for (const row of view.body.keyboard) {
    // Возврат с лота — кнопка тела, а в один ряд с «Меню» её ставит оболочка.
    const content = row.filter((button) => {
      if (button.action !== "lot.back") return true;
      back = { name: "Лоты", data: button.callbackData };
      return false;
    });
    if (content.length === 0) continue;
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(lotLabel(button), button.callbackData);
    }
  }
  if (back === undefined) {
    throw new Error("lot body without a way back to the feed");
  }
  if (view.canManage === true) {
    nextRow(keyboard).text(editLotLabel, lotFormData(uuidToToken(lot.lotId)));
  }
  const title = truncate(lot.card?.title ?? untitled, titleLimit);
  const description =
    lot.card?.description === undefined || lot.card.description === ""
      ? undefined
      : lot.card.description;
  // Карточка лота (дизайн-код, «Карточка лота»): группа статуса, группа цены
  // и лидера, описание — группы через пустую строку, в rich — блоками.
  const groups = statusGroups(lot, view);
  // Исход команды участника — заметка над названием после «Да».
  const result = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "result" }> =>
      block.kind === "result",
  );
  const note =
    result === undefined ? undefined : resultText(result.result, money);
  const rich = view.presentation === "rich";
  const photo = rich ? view.photo : undefined;
  const image =
    lot.card?.image === undefined
      ? undefined
      : { lotId: lot.lotId, version: lot.card.image.version };
  const text = rich
    ? [
        note === undefined ? "" : `<p>${escapeHtml(note)}</p>`,
        `<h1>${escapeHtml(title)}</h1>`,
        ...groups.map(
          (lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`,
        ),
        ...richParagraphs(description),
        photo === undefined ? "" : `<img src="tg://photo?id=${photo.id}"/>`,
      ].join("")
    : withNote(note, plainLot(title, description, groups));
  return {
    screen: {
      id: "lot",
      text,
      keyboard: withNav(keyboard, back),
      format: rich ? "rich" : "HTML",
      ...(photo === undefined ? {} : { media: [photo] }),
    },
    ...(rich && image !== undefined ? { image } : {}),
  };
}

// Абзацы описания в rich-карточке: перенос строки в её `html` не рисуется,
// поэтому абзац — свой блок, строки внутри — `<br>`.
function richParagraphs(description: string | undefined): string[] {
  if (description === undefined) return [];
  return description
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph.split("\n").filter((line) => line.trim() !== ""),
    )
    .filter((lines) => lines.length > 0)
    .map((lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`);
}

function plainLot(
  title: string,
  description: string | undefined,
  groups: readonly (readonly string[])[],
): string {
  const join = (shown: string | undefined) =>
    screenText(
      title,
      ...groups.map((lines) => lines.map(escapeHtml).join("\n")),
      shown === undefined ? undefined : escapeHtml(shown),
    );
  const full = join(description);
  if (full.length <= plainTextLimit || description === undefined) return full;
  // Экранирование удлиняет текст, поэтому запас считается по готовой строке.
  const overflow = full.length - plainTextLimit + 1;
  return join(truncate(description, description.length - overflow));
}

function lotLabel(button: AuctionButton): string {
  switch (button.action) {
    case "lot.refresh":
      return "Обновить";
    case "lot.history":
      return "Ставки";
    case "lot.bid-step":
      return `По шагу (${money(button.amount)})`;
    case "lot.bid-custom":
      return "Своя сумма";
    case "lot.proxy":
      return "Автоставка";
    case "feed.open-lot":
    case "feed.prev":
    case "feed.next":
    case "lot.back":
    case "history.prev":
    case "history.next":
    case "history.back":
    case "confirm.yes":
    case "confirm.no":
    case "question.cancel":
    case "name.username":
    case "name.alias":
    case "name.back":
    case "accepted.lot":
      throw new Error(`action ${button.action} in a lot body`);
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

// Хронология ставок лота (PER-309): название лота в кавычках, строки «• …» по
// порядку журнала, листание «←» и «→», а возврат тела на карточку оболочка
// ставит в один ряд с «Меню».
function historyScreen(
  view: AuctionView,
  history: Extract<AuctionBlock, { kind: "history" }>,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  let back: Parent | undefined;
  for (const row of view.body.keyboard) {
    const content = row.filter((button) => {
      if (button.action !== "history.back") return true;
      back = { name: "Лот", data: button.callbackData };
      return false;
    });
    if (content.length === 0) continue;
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(historyLabel(button), button.callbackData);
    }
  }
  if (back === undefined) {
    throw new Error("history body without a way back to the lot");
  }
  return {
    id: "bids",
    text: screenText(
      pagedTitle("Ставки", {
        items: history.entries,
        page: history.page,
        pageCount: history.pageCount,
      }),
      quoted(truncate(history.title ?? untitled, titleLimit)),
      history.entries.length === 0
        ? "Ставок пока нет."
        : history.entries
            .map((entry) => bullet(escapeHtml(historyLine(entry, view))))
            .join("\n"),
    ),
    keyboard: withNav(keyboard, back),
    format: "HTML",
  };
}

function historyLabel(button: AuctionButton): string {
  switch (button.action) {
    case "history.prev":
      return "←";
    case "history.next":
      return "→";
    case "feed.open-lot":
    case "feed.prev":
    case "feed.next":
    case "lot.refresh":
    case "lot.bid-step":
    case "lot.bid-custom":
    case "lot.proxy":
    case "lot.history":
    case "lot.back":
    case "history.back":
    case "confirm.yes":
    case "confirm.no":
    case "question.cancel":
    case "name.username":
    case "name.alias":
    case "name.back":
    case "accepted.lot":
      throw new Error(`action ${button.action} in a history body`);
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

// Строка ставки: когда, кто, сколько и как. Имени нет — Auction его не отдал,
// идентификатор человеку не показывается; лимита прокси нет и в теле.
function historyLine(entry: HistoryItem, view: AuctionView): string {
  return [
    readableMoment(
      communityLocalTime(entry.occurredAt, view.timeZone),
      view.today,
    ),
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

// Группы карточки: статус словом, затем факты о цене и лидере. Строки «ключ:
// значение» без точки; слова статусов — дизайн-код, «Карточка лота». Слова —
// те же, что у бота аукциона, словарь один.
function statusGroups(
  block: Extract<AuctionBlock, { kind: "lot" }>,
  view: AuctionView,
): string[][] {
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
                `Торги до: ${readableMoment(
                  communityLocalTime(status.deadline, view.timeZone),
                  view.today,
                )}`,
              ]),
          // Свой лимит смотрящего: чужих Auction не отдаёт.
          ...(block.viewerProxyLimit === undefined
            ? []
            : [
                `Твоя автоставка: до ${money(block.viewerProxyLimit)} (видишь только ты)`,
              ]),
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

// Обрезка по кодовым точкам: срез по UTF-16 разрезал бы суррогатную пару.
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > Math.max(0, limit - 1)) break;
    kept += point;
  }
  return `${kept}…`;
}
