import { InlineKeyboard } from "grammy";
import {
  finalBidLabel,
  finalBidLine,
  finalPriceLines,
} from "../../../../auction-final.js";
import { raffleButtonLabel } from "../../../../auction-raffle.js";
import {
  favoritesEmpty,
  favoritesSummary,
  feedSummary,
  followLabel,
  leaderLine,
  lotNextLabel,
  lotPrevLabel,
  lotsLabel,
  ownLotLine,
  unfollowLabel,
} from "../../../../auction-standing.js";
import {
  type AuctionBlock,
  type AuctionButton,
  type AuctionScreenBody,
  type BidOriginView,
  type FeedItem,
  type HistoryItem,
  type LotStatusView,
} from "../../../../auction-ui/index.js";
import { money, truncate } from "../../../../core/format.js";
import {
  emptyDescription,
  marked,
  pictogram,
} from "../../../../core/pictograms.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import type { ImageKey } from "../lot-photos.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  auctionFaqData,
  consoleViewData,
  lotFormData,
  lotNewData,
} from "../parse-callback.js";
import {
  acceptedScreen,
  answerRefusedScreen,
  commandResultScreen,
  confirmScreen,
  followRefusedScreen,
  nameChoiceScreen,
  nameRefusedScreen,
  nameSettingsScreen,
  oneLine,
  questionScreen,
} from "./auction-bid.js";
import {
  raffleAnswerRefusedScreen,
  raffleNameChoiceScreen,
  raffleProofScreen,
  raffleQuestionScreen,
  raffleScreen,
} from "./auction-raffle.js";
import { stageWords } from "./auction-stage.js";
import { toSettingsExtensions } from "./extensions.js";
import {
  bullet,
  buttonText,
  escapeHtml,
  nextRow,
  type Parent,
  pagedTitle,
  readableMoment,
  retryLabel,
  screenText,
  submenuText,
  toAuctionRoot,
  withNav,
} from "./kit.js";
import type { ScreenPhoto, ShownScreen } from "./show.js";

// Цена и обрезка — общие у двух ботов (`src/core/format.ts`); имена
// остаются здесь для прежних потребителей.
export { money, truncate };

// Оболочка хаба для тела аукциона (ADR-044, «Один аукцион, две оболочки»;
// дизайн-код, «Аукцион: тело, шлюз, оболочка»). Тело — блоки и кнопки-действия
// аукционного дерева — одно на два бота; здесь блоки становятся текстом, действия —
// подписями, а последним рядом встаёт навигация хаба. Состав и порядок кнопок
// тела оболочка не меняет: кнопку, которой правило не допускает, убирает пакет.

export type AuctionView = {
  body: AuctionScreenBody;
  /**
   * Родитель корня аукциона (PER-605): меню «Расширения» его сходки либо
   * «Сходки», если бот сходку не знает. Лента, избранное, розыгрыш, правила и
   * пульт возвращают в корень: ему хватает идентификатора аукциона.
   */
  rootParent: Parent;
  presentation: "rich" | "plain";
  timeZone: string;
  today: CommunityDay;
  /** Фото карточки лота, уже готовое к отправке; нет — карточка без фото. */
  photo?: ScreenPhoto;
  /**
   * Смотрящий держит право вести сходки: оболочка добавляет вход в пульт
   * (PER-320) и входы в форму лота (PER-319) — «Добавить лот» и «Изменить
   * лот». Каталог лотов и пульт входят в одно право (RFC-016). Решает его не
   * оболочка — Auction и Meetups проверяют право на каждой команде.
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
  /**
   * Предпросмотр лота глазами участника (PER-512): возврат с карточки. Тело
   * приходит из `previewLot` без кнопок; карточка рисуется той же вёрсткой,
   * что у участника, с пометкой последним абзацем и без «Изменить лот».
   */
  preview?: Parent;
};

// Входы в форму лота — ряды оболочки хаба, а не тела: у бота аукциона формы
// нет, и тело у двух ботов остаётся одним.
const addLotLabel = "Добавить лот";
const editLotLabel = "Изменить лот";
// Пульт аукциона (PER-320) — ряд оболочки хаба в корне аукциона.
const consoleLabel = "Пульт";
const favoritesLabel = "Избранное";

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

// Пометка предпросмотра — последним абзацем: над заголовком у карточки только
// фото (дизайн-код, «Форма лота»).
export const lotPreviewMark = "Предпросмотр: так лот видят участники.";

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
  // экраны; отказ и непринятый ответ — тоже (PER-472).
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
        return { screen: nameChoiceScreen(block, view.body.keyboard) };
      case "result":
        return {
          screen: commandResultScreen(block, view.body.keyboard, money),
        };
      case "answer-refused":
        return {
          screen: answerRefusedScreen(block, view.body.keyboard, money),
        };
      case "follow-refused":
        return { screen: followRefusedScreen(block, view.body.keyboard) };
      // Розыгрыш среди участников (ADR-066).
      case "raffle":
        return { screen: raffleScreen(block, view.body.keyboard, view) };
      case "raffle-proof":
        return { screen: raffleProofScreen(block, view.body.keyboard) };
      case "raffle-name-choice":
        return {
          screen: raffleNameChoiceScreen(block, view.body.keyboard),
        };
      case "raffle-question":
        return {
          screen: raffleQuestionScreen(view.body.keyboard),
          asks: true,
        };
      case "raffle-answer-refused":
        return {
          screen: raffleAnswerRefusedScreen(block, view.body.keyboard),
        };
      // Имя в аукционе из «Настроек» (PER-595): вход — в «Расширениях».
      case "name-settings":
        return {
          screen: nameSettingsScreen(
            block,
            view.body.keyboard,
            toSettingsExtensions,
          ),
        };
      case "name-question":
        return {
          screen: raffleQuestionScreen(view.body.keyboard),
          asks: true,
        };
      case "name-answer-refused":
        return {
          screen: nameRefusedScreen(block, view.body.keyboard, money),
        };
      default:
        break;
    }
  }
  const root = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "root" }> =>
      block.kind === "root",
  );
  if (root !== undefined) return { screen: rootScreen(view, root) };
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
  const favorites = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "favorites" }> =>
      block.kind === "favorites",
  );
  if (favorites !== undefined) {
    return { screen: favoritesScreen(view, favorites) };
  }
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
  // Лента — просто список лотов (PER-605): вход в пульт, розыгрыш, избранное и
  // правила стоят в корне аукциона, и возврат тела ведёт туда (PER-644). Над
  // лотами остаётся «Добавить лот» администратора, пока аукцион принимает
  // лоты.
  const auction = uuidToToken(feed.auctionId);
  if (view.canManage === true && view.canAddLots !== false) {
    keyboard.text(addLotLabel, lotNewData(auction)).row();
  }
  let back: Parent | undefined;
  for (const row of view.body.keyboard) {
    const content = row.filter((button) => {
      if (button.action !== "feed.back") return true;
      back = { name: "Аукцион", data: button.callbackData };
      return false;
    });
    if (content.length === 0) continue;
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(feedLabel(button, items), button.callbackData);
    }
  }
  // Текст не повторяет кнопки (PER-595): в нём сводка своих лотов — где
  // смотрящий лидер и что он купил, — а все лоты стоят кнопками в порядке
  // ленты.
  return {
    id: "lots",
    text: screenText(
      pagedTitle("Лоты", { items: feed.lots, ...feed }),
      ...(feed.lots.length === 0
        ? ["Лотов пока нет."]
        : feedSummary(feed, mineOptions)),
    ),
    keyboard: withNav(keyboard, back ?? noWayBack("feed")),
    format: "HTML",
  };
}

function noWayBack(body: string): never {
  throw new Error(`${body} body without a way back`);
}

// Строка своего лота в сводке: название и цена, как у кнопки ленты.
const mineOptions = {
  title: (item: FeedItem) =>
    escapeHtml(truncate(oneLine(item.title ?? untitled), titleLimit)),
  price: (item: FeedItem) =>
    `${priceLabel(item.status)}${item.activeWindow === undefined ? "" : ", счастливые часы"}`,
};

/**
 * Корень аукциона (PER-605; ADR-064, дополнение 2026-10-12): стадия и сроки,
 * «Лоты», «Пульт» по праву и «Розыгрыш», пока он есть, «Избранное» тела у
 * процесса с Notifications и «Правила и FAQ». Возврат — в меню «Расширения»
 * сходки.
 */
function rootScreen(
  view: AuctionView,
  root: Extract<AuctionBlock, { kind: "root" }>,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  const { auction } = root;
  // Auction аукциона не отдал: его удалили — или включили только что, и
  // чтение Auction его ещё не видит. Различить нельзя, поэтому у кадра
  // «Повторить», а не тупик.
  if (auction === undefined) {
    keyboard.text(retryLabel, toAuctionRoot(root.auctionId).data);
    return {
      id: "auction-root",
      text: screenText(
        "Аукцион",
        "Аукцион не найден. Если его только что включили, он появится через несколько секунд.",
      ),
      keyboard: withNav(keyboard, view.rootParent),
      format: "HTML",
    };
  }
  const token = uuidToToken(root.auctionId);
  const buttons = view.body.keyboard.flat();
  const lots = buttons.find((button) => button.action === "root.lots");
  const raffle = buttons.find((button) => button.action === "root.raffle");
  const favorites = buttons.find(
    (button) => button.action === "root.favorites",
  );
  if (lots !== undefined) keyboard.text(lotsLabel, lots.callbackData).row();
  if (view.canManage === true) {
    keyboard.text(consoleLabel, consoleViewData(token));
  }
  if (raffle !== undefined) {
    keyboard.text(raffleButtonLabel, raffle.callbackData);
  }
  nextRow(keyboard);
  if (favorites !== undefined) {
    keyboard.text(favoritesLabel, favorites.callbackData);
  }
  keyboard.text("Правила и FAQ", auctionFaqData(token));
  const moment = (instant: string) =>
    readableMoment(communityLocalTime(instant, view.timeZone), view.today);
  const online =
    auction.opensAt === undefined
      ? undefined
      : auction.closesAt === undefined
        ? `Онлайн-торги: с ${moment(auction.opensAt)}`
        : `Онлайн-торги: с ${moment(auction.opensAt)} до ${moment(auction.closesAt)}`;
  return {
    id: "auction-root",
    text: screenText(
      "Аукцион",
      [
        `Статус: ${stageWords[auction.stage]}`,
        ...(online === undefined ? [] : [online]),
        ...(auction.final ? ["Финал: в зале"] : []),
      ]
        .map(escapeHtml)
        .join("\n"),
    ),
    keyboard: withNav(keyboard, view.rootParent),
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
    case "lot.bid-final":
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
    case "question.explain":
    case "name.username":
    case "name.alias":
    case "name.back":
    case "accepted.lot":
    case "accepted.feed":
    case "result.lot":
    case "answer.retry":
    case "name.return":
    case "lot.follow":
    case "lot.unfollow":
    case "favorites.open-lot":
    case "favorites.prev":
    case "favorites.next":
    case "favorites.back":
    case "feed.back":
    case "root.favorites":
    case "lot.prev":
    case "lot.next":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.raffle":
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
  const { preview } = view;
  let back: Parent | undefined = preview;
  for (const row of view.body.keyboard) {
    if (preview !== undefined) {
      throw new Error("lot preview body with buttons");
    }
    // Возврат с лота — кнопка тела, а рядом навигации её ставит оболочка.
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
  if (view.canManage === true && preview === undefined) {
    nextRow(keyboard).text(editLotLabel, lotFormData(uuidToToken(lot.lotId)));
  }
  const title = truncate(lot.card?.title ?? untitled, titleLimit);
  // Пустое описание — та же заглушка, что у карточки сходки (дизайн-код,
  // «Карточка»; PER-594).
  const description =
    lot.card?.description === undefined || lot.card.description === ""
      ? emptyDescription
      : lot.card.description;
  // Карточка лота (дизайн-код, «Карточка»): группа статуса, группа цены,
  // лидера и срока со знаками, группа хода торгов, описание — группы через
  // пустую строку, в rich — блоками. Исход ставки финала — своей группой под
  // ними (PER-336).
  const groups = [
    ...statusGroups(lot, view),
    ...(lot.finalBid === undefined
      ? []
      : [[finalBidLine(lot.finalBid, money)]]),
  ];
  const mark = preview === undefined ? [] : [lotPreviewMark];
  const rich = view.presentation === "rich";
  const photo = rich ? view.photo : undefined;
  const image =
    lot.card?.image === undefined
      ? undefined
      : { lotId: lot.lotId, version: lot.card.image.version };
  // Фото — первым блоком, над заголовком (решение владельца 10 октября 2026
  // года, «Показ фото лота»).
  const text = rich
    ? [
        photo === undefined ? "" : `<img src="tg://photo?id=${photo.id}"/>`,
        `<h1>${escapeHtml(title)}</h1>`,
        ...groups.map(
          (lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`,
        ),
        ...richParagraphs(description),
        ...mark.map((line) => `<p>${escapeHtml(line)}</p>`),
      ].join("")
    : plainLot(title, description, groups, mark);
  return {
    screen: {
      id: preview === undefined ? "lot" : "lot-preview",
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

// `footer` — абзацы после описания: пометка предпросмотра. Предел текста
// держит и их, поэтому у предела они отнимают место у описания.
function plainLot(
  title: string,
  description: string | undefined,
  groups: readonly (readonly string[])[],
  footer: readonly string[] = [],
): string {
  const join = (shown: string | undefined) =>
    screenText(
      title,
      ...groups.map((lines) => lines.map(escapeHtml).join("\n")),
      shown === undefined ? undefined : escapeHtml(shown),
      ...footer.map(escapeHtml),
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
    case "lot.bid-final":
      return finalBidLabel(button.amount, money);
    case "lot.bid-custom":
      return "Своя сумма";
    case "lot.proxy":
      return "Автоставка";
    case "lot.follow":
      return followLabel;
    case "lot.unfollow":
      return unfollowLabel;
    case "lot.prev":
      return lotPrevLabel;
    case "lot.next":
      return lotNextLabel;
    case "favorites.open-lot":
    case "favorites.prev":
    case "favorites.next":
    case "favorites.back":
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
    case "question.explain":
    case "name.username":
    case "name.alias":
    case "name.back":
    case "accepted.lot":
    case "accepted.feed":
    case "result.lot":
    case "answer.retry":
    case "name.return":
    case "feed.back":
    case "root.favorites":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.raffle":
      throw new Error(`action ${button.action} in a lot body`);
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

// Избранное (PER-495): свои отмеченные лоты по порядку отметки — строка в
// теле и кнопка на лот, листание и возврат тела в ленту, из корня которой
// список открыт; в один ряд с «Меню» его ставит оболочка.
function favoritesScreen(
  view: AuctionView,
  favorites: Extract<AuctionBlock, { kind: "favorites" }>,
): ShownScreen {
  const items = new Map<string, FeedItem>(
    favorites.lots.map((item) => [item.lotId, item]),
  );
  const keyboard = new InlineKeyboard();
  let back: Parent | undefined;
  for (const row of view.body.keyboard) {
    // Список открыт из корня аукциона, и тело ведёт назад туда же
    // (PER-605, PER-644).
    const content = row.filter((button) => {
      if (button.action !== "favorites.back") return true;
      back = { name: "Аукцион", data: button.callbackData };
      return false;
    });
    if (content.length === 0) continue;
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(favoritesLabelOf(button, items), button.callbackData);
    }
  }
  if (back === undefined) {
    throw new Error("favorites body without a way back to the feed");
  }
  return {
    id: "favorites",
    text: screenText(
      pagedTitle(favoritesLabel, { items: favorites.lots, ...favorites }),
      ...((favorites.total ?? favorites.lots.length) === 0
        ? [favoritesEmpty]
        : favoritesSummary(
            favorites.total ?? favorites.lots.length,
            favorites.mine ?? [],
            {
              ...mineOptions,
              price: (item) => favoriteState(item.status, view),
            },
          )),
    ),
    keyboard: withNav(keyboard, back),
    format: "HTML",
  };
}

// Цена и до какого момента идут торги: дедлайн есть только у онлайн-торгов.
// Закрытый лот называет итог.
function favoriteState(status: LotStatusView, view: AuctionView): string {
  return status.kind === "trading" && status.deadline !== undefined
    ? `${priceLabel(status)}, торги до ${readableMoment(
        communityLocalTime(status.deadline, view.timeZone),
        view.today,
      )}`
    : priceLabel(status);
}

function favoritesLabelOf(
  button: AuctionButton,
  items: ReadonlyMap<string, FeedItem>,
): string {
  switch (button.action) {
    case "favorites.open-lot": {
      const item = items.get(button.lotId);
      return item === undefined
        ? untitled
        : buttonText(`${item.title ?? untitled} · ${priceLabel(item.status)}`);
    }
    case "favorites.prev":
      return "←";
    case "favorites.next":
      return "→";
    default:
      throw new Error(`action ${button.action} in a favorites body`);
  }
}

// Хронология ставок лота (PER-309): название лота жирным, строки «• …» по
// порядку журнала, листание «←» и «→», а возврат тела на карточку оболочка
// ставит рядом навигации.
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
    text: submenuText(
      pagedTitle("Ставки", {
        items: history.entries,
        page: history.page,
        pageCount: history.pageCount,
      }),
      oneLine(truncate(history.title ?? untitled, titleLimit)),
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
    case "lot.bid-final":
    case "lot.bid-custom":
    case "lot.proxy":
    case "lot.history":
    case "lot.back":
    case "history.back":
    case "confirm.yes":
    case "confirm.no":
    case "question.cancel":
    case "question.explain":
    case "name.username":
    case "name.alias":
    case "name.back":
    case "accepted.lot":
    case "accepted.feed":
    case "result.lot":
    case "answer.retry":
    case "name.return":
    case "lot.follow":
    case "lot.unfollow":
    case "favorites.open-lot":
    case "favorites.prev":
    case "favorites.next":
    case "favorites.back":
    case "feed.back":
    case "root.favorites":
    case "lot.prev":
    case "lot.next":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.raffle":
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

// Группы карточки: статус словом, затем блок цены, лидера и срока со знаками
// словаря — как «Когда» и «Где» у сходки, — затем ход торгов: следующая
// ставка, шаг, своя автоставка. Строки «ключ: значение» без точки; слова
// статусов — дизайн-код, «Карточка лота». Слова — те же, что у бота аукциона,
// словарь один.
function statusGroups(
  block: Extract<AuctionBlock, { kind: "lot" }>,
  view: AuctionView,
): string[][] {
  const { status, participantName } = block;
  switch (status.kind) {
    case "draft":
      return [["Статус: готовится к торгам"]];
    // Шаг до торгов — тем же форматом, что в торгах (PER-618): условия
    // Auction отдаёт с первого планирования, и участник видит их заранее.
    case "scheduled": {
      const step = stepLines(block, view);
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
      // Ход торгов: в финале — объявленная цена и следующая ставка ровно по
      // ней (PER-336), в онлайн-торгах — порог следующей ставки; затем шаг и
      // свой лимит.
      const course = [
        ...(status.phase === "live"
          ? finalPriceLines(block, money)
          : block.nextPrice === undefined
            ? []
            : [`Следующая ставка: от ${money(block.nextPrice)}`]),
        ...stepLines(block, view),
        // Свой лимит смотрящего: чужих Auction не отдаёт.
        ...(block.viewerProxyLimit === undefined
          ? []
          : [
              `Твоя автоставка: до ${money(block.viewerProxyLimit)} (видишь только ты)`,
            ]),
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
                  `Торги до: ${readableMoment(
                    communityLocalTime(status.deadline, view.timeZone),
                    view.today,
                  )}`,
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

// Шаг лота до торгов и в торгах — те же строки, что у бота аукциона
// (дизайн-код, «Карточка лота»): в окне «Счастливых часов» шаг окна до его
// конца и обычный шаг, иначе «Шаг», когда он один на все цены, или «Шаг по
// порогам»; будущее окно — своей строкой. Окна Auction отдаёт только в торгах.
function stepLines(
  block: Extract<AuctionBlock, { kind: "lot" }>,
  view: AuctionView,
): string[] {
  const local = (instant: string) => communityLocalTime(instant, view.timeZone);
  const at = (instant: string) => readableMoment(local(instant), view.today);
  const active = block.activeWindow;
  const current =
    active === undefined
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
          `Счастливые часы: шаг ${money(active.step)} до ${at(active.until)}`,
          ...(block.baseStep === undefined
            ? []
            : [`Обычный шаг: ${money(block.baseStep)}`]),
        ];
  const next = block.nextWindow;
  if (next === undefined) return current;
  // Окно внутри одного дня называет день один раз.
  const from = local(next.from);
  const until = local(next.until);
  const sameDay =
    from.year === until.year &&
    from.month === until.month &&
    from.day === until.day;
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    ...current,
    `Счастливые часы: с ${at(next.from)} до ${
      sameDay ? `${pad(until.hours)}:${pad(until.minutes)}` : at(next.until)
    }, шаг ${money(next.step)}`,
  ];
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
