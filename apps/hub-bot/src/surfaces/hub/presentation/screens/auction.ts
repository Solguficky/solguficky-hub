import { InlineKeyboard } from "grammy";
import { achievementScreen } from "../../../../achievement-screen.js";
import { dayChronicleButtonLabel } from "../../../../auction-day-chronicle.js";
import {
  finalBidHeadline,
  finalBidLabel,
  finalPriceLines,
  showsStep,
  withdrawButtonLabel,
} from "../../../../auction-final.js";
import { type HallLinks, hallButtons } from "../../../../auction-hall.js";
import {
  activeHappyHourLine,
  happyHourTerms,
} from "../../../../auction-happy-hours.js";
import { predictionButtonLabel } from "../../../../auction-prediction.js";
import { programmeParagraph } from "../../../../auction-programme.js";
import { promoButtonLabel } from "../../../../auction-promo.js";
import { raffleButtonLabel } from "../../../../auction-raffle.js";
import { auctionResultsButtonLabel } from "../../../../auction-results.js";
import {
  collectedLine,
  type SetLotOptions,
  setGroupLines,
  setLabel,
  setLotLabel,
  setLotLine,
  setMoreLine,
} from "../../../../auction-set.js";
import {
  awaitsFirstBid,
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
  ownLimitLines,
  ownLotLine,
  stepBidLabel,
  struckHistoryLine,
  tradingPriceLine,
  unfollowLabel,
} from "../../../../auction-standing.js";
import type {
  AuctionBlock,
  AuctionButton,
  AuctionScreenBody,
  FeedItem,
  FeedSectionItem,
  LotStatusView,
  Money,
} from "../../../../auction-ui/index.js";
import { invoicesButtonLabel } from "../../../../auction-winner-invoices.js";
import {
  type LotPhotoKey,
  lotPhotoKeys,
  rafflePrizePhotoKeys,
  richPhotoBlock,
} from "../../../../core/auction/lot-photos.js";
import { money, truncate } from "../../../../core/format.js";
import {
  adminLabel,
  emptyDescription,
  marked,
  pictogram,
  refreshLabel,
} from "../../../../core/pictograms.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  auctionFaqData,
  consoleViewData,
  lotFormData,
  lotHappyHoursData,
  lotNewData,
  removalData,
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
import { auctionChronicleScreen } from "./auction-chronicle.js";
import { dayChronicleScreen } from "./auction-day-chronicle.js";
import {
  predictionAliasQuestionScreen,
  predictionAnswerRefusedScreen,
  predictionLotsScreen,
  predictionNameChoiceScreen,
  predictionNumberQuestionScreen,
  predictionScreen,
} from "./auction-predictions.js";
import { auctionPromoScreen } from "./auction-promo.js";
import {
  raffleAnswerRefusedScreen,
  raffleNameChoiceScreen,
  raffleProofScreen,
  raffleQuestionScreen,
  raffleRegisteredScreen,
  raffleScreen,
} from "./auction-raffle.js";
import { auctionResultsScreen } from "./auction-results.js";
import { stageLine } from "./auction-stage.js";
import {
  invoiceMissingScreen,
  invoiceScreen,
  invoicesScreen,
} from "./auction-winner-invoices.js";
import { toSettingsAuction } from "./extensions.js";
import {
  type AuctionEntry,
  addLotLabel,
  bullet,
  buttonText,
  escapeHtml,
  keyboardViaEvents,
  nextRow,
  type Parent,
  pagedTitle,
  readableMoment,
  retryLabel,
  screenText,
  submenuText,
  toAuctionRoot,
  withAccount,
  withNav,
} from "./kit.js";
import { removalLabel } from "./participant-removal.js";
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
  /**
   * Вход в дерево (PER-669): из «Событий» кнопки дерева на экране несут
   * отметку входа, и корень возвращает туда. Нет поля — вход со сходки.
   */
  entry?: AuctionEntry;
  presentation: "rich" | "plain";
  timeZone: string;
  today: CommunityDay;
  /**
   * Фото карточки лота, уже готовые к отправке, в порядке показа; нет или
   * пусто — карточка без фото.
   */
  photos?: readonly ScreenPhoto[];
  /**
   * Смотрящий держит право вести аукцион: оболочка добавляет вход в пульт
   * (PER-320) и входы в форму лота (PER-319) — «Добавить лот» и «Изменить
   * лот». Каталог лотов и пульт входят в одно право (RFC-016). Решает его не
   * оболочка — Auction и Meetups проверяют право на каждой команде.
   */
  canManage?: boolean;
  /**
   * Чат медиа ботов включён (PER-774): держатель права вести аукцион видит в
   * корне вход в промо-видео.
   */
  media?: boolean;
  /**
   * Экран зала и стрим (PER-825): кнопки-URL под карточкой лота. Нет поля —
   * адресов в настройке нет, и кнопок нет.
   */
  hall?: HallLinks;
  /**
   * Принимает ли аукцион новые лоты: `false` — онлайн-неделя открыта, и ряда
   * «Добавить лот» в ленте нет (PER-468). Статус аукциона лента тела не несёт,
   * его читает адаптер у пульта; не прочитал — отдаёт `true`, и ряд остаётся,
   * как и когда поле не задано: устаревшую кнопку защищает отказ `lots-frozen`
   * после вопроса.
   */
  canAddLots?: boolean;
  /**
   * Настоящий аккаунт победителя проданного лота (PER-648). Его отдаёт
   * Identity и только организатору: остальным имя остаётся псевдонимом, и
   * поле не задано. Нет поля — карточка показывает то, что дал Auction.
   */
  winnerUsername?: string;
  /**
   * Предпросмотр лота глазами участника (PER-512): возврат с карточки. Тело
   * приходит из `previewLot` без кнопок; карточка рисуется той же вёрсткой,
   * что у участника, с пометкой последним абзацем и без «Изменить лот».
   */
  preview?: Parent;
};

// Входы в форму лота — ряды оболочки хаба, а не тела: у бота аукциона формы
// нет, и тело у двух ботов остаётся одним.
// Знак управления — 🛠 (PER-669): экраны аукциона видит и участник.
const editLotLabel = adminLabel("Изменить лот");
// «Счастливые часы» лота (PER-787) — тот же знак управления.
const happyHoursLotLabel = adminLabel("Счастливые часы");

// Пульт аукциона (PER-320) — ряд оболочки хаба в корне аукциона.
const consoleLabel = adminLabel("Пульт");
const favoritesLabel = "Избранное";

/**
 * Фото карточки лота в порядке показа (PER-721): байты и `file_id` достаёт
 * адаптер, экрану хватает ключей. `asks` — экран вопроса: адаптер шлёт его новым сообщением с
 * `force_reply` (дизайн-код, «Вопросы»).
 */
export type AuctionShown = {
  screen: ShownScreen;
  images?: readonly LotPhotoKey[];
  asks?: true;
  // Промо-видео (PER-774): экран — копия поста чата медиа ботов новым
  // сообщением, а `postId` нет — видео недоступно, и экран не уходит.
  promo?: { postId?: number };
};

// Пометка предпросмотра — последним абзацем: над заголовком у карточки только
// фото (дизайн-код, «Форма лота»).
export const lotPreviewMark = "Предпросмотр: так лот видят участники.";

const untitled = "Лот без названия";
// Длину названия Auction не ограничивает. Предел держит заголовок карточки и
// подпись кнопки внутри лимитов Telegram при любом названии.
const titleLimit = 256;
// Telegram режет обычное сообщение на 4096 символах UTF-16. У rich-карточки
// предела подписи нет, и описание в ней идёт целиком (дизайн-код, «Показ фото
// лота»); в режиме `plain` под предел режется только описание.
const plainTextLimit = 4096;

export function auctionScreen(view: AuctionView): AuctionShown {
  const shown = auctionScreenOf(view);
  if (view.entry === "events") keyboardViaEvents(shown.screen.keyboard);
  return shown;
}

function auctionScreenOf(view: AuctionView): AuctionShown {
  // Лист ставки (PER-317): подтверждение, исход, вопрос и выбор имени — свои
  // экраны; отказ и непринятый ответ — тоже (PER-472).
  for (const block of view.body.blocks) {
    switch (block.kind) {
      case "achievements": {
        const shown = achievementScreen(block.screen, {
          rich: view.presentation === "rich",
          timeZone: view.timeZone,
        });
        if (shown.id === "my-achievements" || shown.id === "my-achievement")
          throw new Error("private auction collection is unavailable in hub");
        const photos = view.presentation === "rich" ? (view.photos ?? []) : [];
        const keyboard = new InlineKeyboard();
        for (const [index, row] of shown.keyboard.entries()) {
          if (index > 0) keyboard.row();
          for (const button of row)
            keyboard.text(button.text, button.callback_data);
        }
        return {
          screen: {
            id: shown.id,
            text: richPhotoBlock(photos.map((photo) => photo.id)) + shown.text,
            ...(photos.length === 0 ? {} : { media: photos }),
            keyboard,
            format: view.presentation === "rich" ? "rich" : "HTML",
          },
          ...(view.presentation === "rich" ? { images: shown.photos } : {}),
        };
      }
      case "confirm":
        return { screen: confirmScreen(block, view.body.keyboard, money) };
      case "accepted":
        return {
          screen: acceptedScreen(
            block,
            view.body.keyboard,
            money,
            view.timeZone,
          ),
        };
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
      case "auction-results":
        return { screen: auctionResultsScreen(block) };
      case "day-chronicle":
        return { screen: dayChronicleScreen(block) };
      case "auction-chronicle":
        return { screen: auctionChronicleScreen(block) };
      case "promo":
        return {
          screen: auctionPromoScreen(block),
          promo: block.postId === undefined ? {} : { postId: block.postId },
        };
      // Фото приза (PER-773) — как фото лота: ключи отдаются адаптеру, а
      // готовые фото приходят обратно полем `photos`.
      case "raffle": {
        const images =
          view.presentation === "rich"
            ? rafflePrizePhotoKeys(block.raffle)
            : [];
        return {
          screen: raffleScreen(block, view.body.keyboard, view),
          ...(images.length > 0 ? { images } : {}),
        };
      }
      case "raffle-registered":
        return {
          screen: raffleRegisteredScreen(block, view.body.keyboard, view),
        };
      case "raffle-proof":
        return { screen: raffleProofScreen(block, view.body.keyboard) };
      // Счета победителя (PER-322).
      case "invoices":
        return { screen: invoicesScreen(block, view.body.keyboard, view) };
      case "invoice":
        return { screen: invoiceScreen(block, view.body.keyboard, view) };
      case "invoice-missing":
        return { screen: invoiceMissingScreen(view.body.keyboard) };
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
      case "prediction":
        return { screen: predictionScreen(block, view.body.keyboard, view) };
      case "prediction-lots":
        return {
          screen: predictionLotsScreen(block, view.body.keyboard),
        };
      case "prediction-number-question":
        return {
          screen: predictionNumberQuestionScreen(block, view.body.keyboard),
          asks: true,
        };
      case "prediction-name-choice":
        return {
          screen: predictionNameChoiceScreen(block, view.body.keyboard),
        };
      case "prediction-alias-question":
        return {
          screen: predictionAliasQuestionScreen(view.body.keyboard),
          asks: true,
        };
      case "prediction-answer-refused":
        return {
          screen: predictionAnswerRefusedScreen(block, view.body.keyboard),
        };
      // Имя в аукционе из «Настроек» (PER-595): вход — в «Аукционе»
      // «Расширений» настроек (№74).
      case "name-settings":
        return {
          screen: nameSettingsScreen(
            block,
            view.body.keyboard,
            toSettingsAuction,
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
  const set = view.body.blocks.find(
    (block): block is Extract<AuctionBlock, { kind: "set" }> =>
      block.kind === "set",
  );
  if (set !== undefined) return { screen: setScreen(view, set) };
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
  const sections = new Map<number, FeedSectionItem>(
    (feed.sections ?? []).map((section) => [section.sectionId, section]),
  );
  let back: Parent | undefined;
  for (const row of view.body.keyboard) {
    const content = row.filter((button) => {
      if (button.action !== "feed.back") return true;
      // С раздела возврат — к списку разделов ленты (PER-719).
      back = {
        name: feed.section === undefined ? "Аукцион" : "Лоты",
        data: button.callbackData,
      };
      return false;
    });
    if (content.length === 0) continue;
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(
        feedLabel(button, items, sections, feed.final),
        button.callbackData,
      );
    }
  }
  // Текст не повторяет кнопки (PER-595): в нём сводка своих лотов — где
  // смотрящий лидер и что он купил, — а все лоты стоят кнопками в порядке
  // ленты.
  return {
    id: feed.section === undefined ? "lots" : "lot-section",
    text: screenText(
      pagedTitle(
        feed.section === undefined
          ? "Лоты"
          : feedSectionTitle(feed.section.name),
        { items: feed.lots, ...feed },
      ),
      // Пустой общий список при заполненных разделах — не пустой аукцион
      // (PER-719): сводка своих лотов остаётся.
      ...(feed.lots.length === 0 && (feed.sections?.length ?? 0) === 0
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
  const predictions = buttons.find(
    (button) => button.action === "root.predictions",
  );
  const results = buttons.find((button) => button.action === "root.results");
  const dayChronicle = buttons.find(
    (button) => button.action === "root.day-chronicle",
  );
  const raffle = buttons.find((button) => button.action === "root.raffle");
  const favorites = buttons.find(
    (button) => button.action === "root.favorites",
  );
  const invoices = buttons.find((button) => button.action === "root.invoices");
  const achievements = buttons.find(
    (button) => button.action === "root.achievements",
  );
  const promo = buttons.find((button) => button.action === "root.promo");
  // «🏷️ Лоты» — первым рядом парой с «🎬 Промо» (PER-774), пока у аукциона
  // есть видео, иначе своим рядом; «Розыгрыш» и «Прогнозы» — парой под ним
  // (решения владельца по прогону stage 27.10, PER-798; пересматривают №66
  // прогона 14.10): без «Прогнозов» розыгрышу в пару идут «Итоги», а то, чему
  // пары не нашлось, — своим рядом.
  if (lots !== undefined) keyboard.text(lotsLabel, lots.callbackData);
  if (promo !== undefined) keyboard.text(promoButtonLabel, promo.callbackData);
  nextRow(keyboard);
  if (raffle !== undefined) {
    keyboard.text(raffleButtonLabel, raffle.callbackData);
  }
  if (predictions !== undefined) {
    keyboard.text(predictionButtonLabel, predictions.callbackData);
    nextRow(keyboard);
  }
  if (results !== undefined) {
    keyboard.text(auctionResultsButtonLabel, results.callbackData);
  }
  nextRow(keyboard);
  // «Хроники дня» (PER-725) — своим рядом, пока идёт онлайн-неделя.
  if (dayChronicle !== undefined) {
    keyboard.text(dayChronicleButtonLabel, dayChronicle.callbackData);
  }
  nextRow(keyboard);
  // «Мои счета» (PER-322) — своим рядом, пока у смотрящего есть счета.
  if (invoices !== undefined) {
    nextRow(keyboard).text(invoicesButtonLabel, invoices.callbackData).row();
  }
  if (achievements !== undefined)
    nextRow(keyboard).text("Ачивки", achievements.callbackData).row();
  if (favorites !== undefined) {
    keyboard.text(favoritesLabel, favorites.callbackData);
  }
  keyboard.text(
    "Правила и FAQ",
    auctionFaqData(token, view.entry === "events"),
  );
  // «🛠 Пульт» — своим рядом над возвратом (PER-669): действие управления не
  // делит ряд с кнопками участника. Это единственный вход управления в корне
  // (PER-802): сеты, объявление, промо-видео и ставки зала — в пульте.
  if (view.canManage === true) {
    nextRow(keyboard).text(consoleLabel, consoleViewData(token));
  }
  const moment = (instant: string) =>
    readableMoment(communityLocalTime(instant, view.timeZone), view.today);
  // Блоки, как у карточки сходки (прогон 14.10, №65): статус, пустая строка,
  // поле «📅 Когда:» онлайн-торгов и строка финала под ним.
  const online =
    auction.opensAt === undefined
      ? undefined
      : auction.closesAt === undefined
        ? `Когда: онлайн-торги с ${moment(auction.opensAt)}`
        : `Когда: онлайн-торги с ${moment(auction.opensAt)} до ${moment(auction.closesAt)}`;
  const fields = [
    ...(online === undefined
      ? []
      : [marked(pictogram.when, escapeHtml(online))]),
    // Отменённый аукцион финала уже не проведёт (PER-606).
    ...(auction.final && auction.stage !== "cancelled"
      ? ["Финал: в зале"]
      : []),
  ];
  return {
    id: "auction-root",
    text: screenText(
      "Аукцион",
      [
        `Статус: <b>${escapeHtml(stageLine(auction))}</b>`,
        ...(fields.length === 0 ? [] : ["", ...fields]),
      ].join("\n"),
      // Программа недели (PER-724) — абзацем под сроками, текст общий с ботом
      // аукциона.
      programmeParagraph(root, {
        moment,
        timeZone: view.timeZone,
        now: new Date(),
      }),
    ),
    keyboard: withNav(keyboard, view.rootParent),
    format: "HTML",
  };
}

function feedLabel(
  button: AuctionButton,
  items: ReadonlyMap<string, FeedItem>,
  sections: ReadonlyMap<number, FeedSectionItem>,
  final?: { active?: FeedItem },
): string {
  switch (button.action) {
    case "feed.open-section": {
      const section = sections.get(button.sectionId);
      return section === undefined ? untitled : feedSectionLabel(section);
    }
    case "feed.open-lot": {
      const item = items.get(button.lotId);
      if (item === undefined) return untitled;
      const title = item.title ?? untitled;
      const finalLabel =
        final === undefined ? null : finalFeedLabel(item, final, title);
      // Сет в подписи ленты не называется (решение владельца 24.10.2026,
      // пересматривает ADR-073, п. 7): отметка съедала название, и одинаковые
      // лоты сета нельзя было различить. Сет называет карточка лота.
      return finalLabel === null
        ? lotButton(item, title)
        : buttonText(finalLabel);
    }
    case "feed.prev":
      return "←";
    case "feed.next":
      return "→";
    case "lot.current":
    case "lot.refresh":
    case "lot.bid-step":
    case "lot.bid-final":
    case "lot.bid-custom":
    case "lot.proxy":
    case "lot.withdraw":
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
    case "prediction.edit":
    case "prediction.select-lot":
    case "prediction.clear":
    case "prediction.switch-round":
    case "prediction.back":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.predictions":
    case "root.results":
    case "results.back":
    case "root.achievements":
    case "root.day-chronicle":
    case "day-chronicle.back":
    case "auction-chronicle.back":
    case "root.promo":
    case "promo.back":
    case "root.raffle":
    case "lot.set":
    case "lot.invoices":
    case "set.open-lot":
    case "set.back":
    case "root.invoices":
    case "invoices.open":
    case "invoices.back":
    case "invoice.back":
    case "invoice.retry":
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
    // «🛠 Изменить лот» — своим рядом над листанием (PER-669): действие
    // управления не делит ряд с кнопками участника, а листание и возврат —
    // последние ряды карточки.
    if (content.some(isPagerButton)) editRow(keyboard, view, lot);
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(lotLabel(button, lot), button.callbackData);
    }
  }
  if (back === undefined) {
    throw new Error("lot body without a way back to the feed");
  }
  editRow(keyboard, view, lot);
  // Ссылки на экран зала и стрим (PER-825) — своими рядами под кнопками
  // участника; в предпросмотре кнопок нет.
  if (preview === undefined) {
    for (const button of hallButtons(view.hall, lot.auctionId)) {
      nextRow(keyboard);
      keyboard.url(button.text, button.url);
    }
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
  const groups = [...statusGroups(lot, view), ...setGroups(lot)];
  const mark = preview === undefined ? [] : [lotPreviewMark];
  const rich = view.presentation === "rich";
  const photos = rich ? (view.photos ?? []) : [];
  const images = lotPhotoKeys(lot.lotId, lot.card);
  // Фото — первым блоком, над заголовком (решение владельца 10 октября 2026
  // года, «Показ фото лота»); несколько — каруселью (PER-721).
  const result = finalBidHeadline(lot, money);
  const text = rich
    ? [
        richPhotoBlock(photos.map((photo) => photo.id)),
        `<h1>${escapeHtml(title)}</h1>`,
        ...(result === undefined ? [] : [`<h2>${escapeHtml(result)}</h2>`]),
        ...groups.map(
          (lines) => `<p>${lines.map(escapeHtml).join("<br>")}</p>`,
        ),
        ...richParagraphs(description),
        ...mark.map((line) => `<p>${escapeHtml(line)}</p>`),
      ].join("")
    : plainLot(title, description, groups, mark, result);
  return {
    screen: {
      id: preview === undefined ? "lot" : "lot-preview",
      text,
      keyboard: withNav(keyboard, back),
      format: rich ? "rich" : "HTML",
      ...(photos.length === 0 ? {} : { media: photos }),
    },
    ...(rich && images.length > 0 ? { images } : {}),
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
  result?: string,
): string {
  const join = (shown: string | undefined) =>
    screenText(
      title,
      result === undefined ? undefined : `<b>${escapeHtml(result)}</b>`,
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

// Ряд листания карточки лота: соседи и «Обновить» между ними.
function isPagerButton(button: AuctionButton): boolean {
  return (
    button.action === "lot.prev" ||
    button.action === "lot.next" ||
    button.action === "lot.refresh"
  );
}

// С лота снимают участника в онлайн-торгах и с удержанного лота (ADR-072,
// п. 4); решение по статусу — для ряда, команду решает Auction.
function removable(status: LotStatusView): boolean {
  return (
    (status.kind === "trading" && status.phase === "online") ||
    status.kind === "held"
  );
}

// Вход в форму лота ставится один раз: над листанием или, если его нет, над
// возвратом. Повторный вызов ряд не добавляет.
function editRow(
  keyboard: InlineKeyboard,
  view: AuctionView,
  lot: Extract<AuctionBlock, { kind: "lot" }>,
): void {
  if (view.canManage !== true || view.preview !== undefined) return;
  const placed = keyboard.inline_keyboard.some((row) =>
    row.some((button) => button.text === editLotLabel),
  );
  if (placed) return;
  nextRow(keyboard).text(editLotLabel, lotFormData(uuidToToken(lot.lotId)));
  // «Счастливые часы» лота (PER-787): условия под периоды задаются лоту в
  // онлайн-торгах — своим рядом под правкой.
  if (lot.status.kind === "trading" && lot.status.phase === "online") {
    nextRow(keyboard).text(
      happyHoursLotLabel,
      lotHappyHoursData(uuidToToken(lot.lotId)),
    );
  }
}

function lotLabel(
  button: AuctionButton,
  lot: Extract<AuctionBlock, { kind: "lot" }>,
): string {
  switch (button.action) {
    case "lot.current":
      return "К текущему лоту";
    case "lot.refresh":
      return refreshLabel;
    case "lot.history":
      return "Ставки";
    // Лоты сета — экран сета с карточки (ADR-073, п. 7).
    case "lot.set":
      return setLabel;
    // «Мои счета» победителю на карточке проданного лота (PER-813).
    case "lot.invoices":
      return invoicesButtonLabel;
    // Без ставок первая ставка — не «по шагу» (PER-631, №82).
    case "lot.bid-step":
      return stepBidLabel(button.amount, awaitsFirstBid(lot.status));
    case "lot.bid-final":
      return finalBidLabel(button.amount, money);
    case "lot.bid-custom":
      return "Своя сумма";
    case "lot.proxy":
      return "Автоставка";
    case "lot.withdraw":
      return withdrawButtonLabel;
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
    case "feed.open-section":
    case "feed.prev":
    case "feed.next":
    case "lot.back":
    case "set.open-lot":
    case "set.back":
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
    case "prediction.edit":
    case "prediction.select-lot":
    case "prediction.clear":
    case "prediction.switch-round":
    case "prediction.back":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.predictions":
    case "root.results":
    case "results.back":
    case "root.achievements":
    case "root.day-chronicle":
    case "day-chronicle.back":
    case "auction-chronicle.back":
    case "root.promo":
    case "promo.back":
    case "root.raffle":
    case "root.invoices":
    case "invoices.open":
    case "invoices.back":
    case "invoice.back":
    case "invoice.retry":
      throw new Error(`action ${button.action} in a lot body`);
    default: {
      const _exhaustive: never = button;
      return _exhaustive;
    }
  }
}

// Сет, в который входит лот (ADR-073, п. 7): название сета и, после итога,
// кто его собрал. До итога сета второй строки нет — собравшего Auction ещё не
// знает.
function setGroups(block: Extract<AuctionBlock, { kind: "lot" }>): string[][] {
  const lotSet = block.set;
  return lotSet === undefined ? [] : [setGroupLines(lotSet)];
}

// Экран сета (ADR-073, п. 7): лоты сета по порядку организатора и, после
// итога, кто его собрал. Заголовок называет экран, а предмет — название
// сета — стоит строкой ниже курсивом (дизайн-код, «Формат»): экран-раздел
// предмета, как «Ставки» лота.
function setScreen(
  view: AuctionView,
  set: Extract<AuctionBlock, { kind: "set" }>,
): ShownScreen {
  const items = new Map<string, FeedItem>(
    set.lots.map((item) => [item.lotId, item]),
  );
  const keyboard = new InlineKeyboard();
  let back: Parent | undefined;
  for (const row of view.body.keyboard) {
    const content = row.filter((button) => {
      if (button.action !== "set.back") return true;
      back = { name: "Лот", data: button.callbackData };
      return false;
    });
    if (content.length === 0) continue;
    nextRow(keyboard);
    for (const button of content) {
      keyboard.text(setLotLabelOf(button, items), button.callbackData);
    }
  }
  if (back === undefined) {
    throw new Error("set body without a way back to the lot");
  }
  return {
    id: "set",
    text: submenuText(
      setLabel,
      oneLine(truncate(set.name, titleLimit)),
      set.lots.map((item) => bullet(setLotLine(item, setOptions))).join("\n"),
      ...(set.more === undefined ? [] : [setMoreLine(set.more)]),
      // Имя собравшего — текст участника: без экранирования Telegram отверг бы
      // разметку.
      ...(set.collectorName === undefined
        ? []
        : [escapeHtml(collectedLine(set.name, set.collectorName))]),
    ),
    keyboard: withNav(keyboard, back),
    format: "HTML",
  };
}

// Название и цена лота сета — как у строки ленты: правила оболочки хаба.
const setOptions: SetLotOptions = {
  title: (item) =>
    escapeHtml(truncate(oneLine(item.title ?? untitled), titleLimit)),
  buttonTitle: (item) =>
    escapeHtml(truncate(oneLine(item.title ?? untitled), titleLimit)),
  price: (item) => priceLabel(item.status),
};

// Подпись кнопки лота сета: название и цена, как у кнопки ленты.
function setLotLabelOf(
  button: AuctionButton,
  items: ReadonlyMap<string, FeedItem>,
): string {
  switch (button.action) {
    case "set.open-lot": {
      const item = items.get(button.lotId);
      return item === undefined
        ? untitled
        : buttonText(setLotLabel(item, setOptions));
    }
    case "lot.set":
    case "feed.open-lot":
    case "feed.open-section":
    case "favorites.open-lot":
    case "prediction.select-lot":
    case "lot.bid-step":
    case "lot.bid-final":
    case "lot.bid-custom":
    case "lot.proxy":
    case "lot.withdraw":
    case "lot.current":
    case "lot.refresh":
    case "lot.history":
    case "lot.back":
    case "lot.prev":
    case "lot.next":
    case "lot.follow":
    case "lot.unfollow":
    case "feed.prev":
    case "feed.next":
    case "feed.back":
    case "favorites.prev":
    case "favorites.next":
    case "favorites.back":
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
    case "root.favorites":
    case "prediction.edit":
    case "prediction.clear":
    case "prediction.switch-round":
    case "prediction.back":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.predictions":
    case "root.results":
    case "results.back":
    case "root.achievements":
    case "root.day-chronicle":
    case "day-chronicle.back":
    case "auction-chronicle.back":
    case "root.promo":
    case "promo.back":
    case "root.raffle":
    case "lot.invoices":
    case "set.back":
    case "root.invoices":
    case "invoices.open":
    case "invoices.back":
    case "invoice.back":
    case "invoice.retry":
      throw new Error(`action ${button.action} in a set body`);
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
        ? [favoritesEmptyText(favorites.ended)]
        : favoritesSummary(
            favorites.total ?? favorites.lots.length,
            favorites.mine ?? [],
            {
              ...mineOptions,
              price: (item) => favoriteState(item.status, view),
              ...(favorites.ended === true ? { ended: true } : {}),
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

// Кнопка лота ленты и избранного: название, обрезанное под хвост с ценой,
// отметкой лидера (прогон 14.10, №83) и, в ленте, отметкой сета, в пределе
// подписи.
function lotButton(item: FeedItem, title: string): string {
  const tail = lotButtonTail(item, priceLabel(item.status));
  return buttonText(
    `${truncate(title, Math.max(1, BUTTON_LIMIT - tail.length))}${tail}`,
  );
}

const BUTTON_LIMIT = 64;

function favoritesLabelOf(
  button: AuctionButton,
  items: ReadonlyMap<string, FeedItem>,
): string {
  switch (button.action) {
    case "favorites.open-lot": {
      const item = items.get(button.lotId);
      return item === undefined
        ? untitled
        : lotButton(item, item.title ?? untitled);
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
  // Снятие участника (PER-659, ADR-072): ряд оболочки над возвратом, как
  // «Изменить лот» на карточке, — держателю права вести аукцион и только у
  // лота, с которого снимают: онлайн-торги или удержание. Заморозку
  // состава лот не знает — её отказ приходит от Auction.
  if (view.canManage === true && removable(history.status)) {
    nextRow(keyboard).text(
      removalLabel,
      removalData(uuidToToken(history.lotId)),
    );
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
            .map((entry) =>
              bullet(
                struckHistoryLine(
                  entry,
                  escapeHtml(
                    historyLine(
                      entry,
                      readableMoment(
                        communityLocalTime(entry.occurredAt, view.timeZone),
                        view.today,
                      ),
                    ),
                  ),
                ),
              ),
            )
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
    case "feed.open-section":
    case "feed.prev":
    case "feed.next":
    case "lot.current":
    case "lot.refresh":
    case "lot.bid-step":
    case "lot.bid-final":
    case "lot.bid-custom":
    case "lot.proxy":
    case "lot.withdraw":
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
    case "prediction.edit":
    case "prediction.select-lot":
    case "prediction.clear":
    case "prediction.switch-round":
    case "prediction.back":
    case "raffle.register":
    case "raffle.cancel":
    case "raffle.proof":
    case "raffle.back":
    case "raffle.return":
    case "root.lots":
    case "root.predictions":
    case "root.results":
    case "results.back":
    case "root.achievements":
    case "root.day-chronicle":
    case "day-chronicle.back":
    case "auction-chronicle.back":
    case "root.promo":
    case "promo.back":
    case "root.raffle":
    case "lot.set":
    case "lot.invoices":
    case "set.open-lot":
    case "set.back":
    case "root.invoices":
    case "invoices.open":
    case "invoices.back":
    case "invoice.back":
    case "invoice.retry":
      throw new Error(`action ${button.action} in a history body`);
    default: {
      const _exhaustive: never = button;
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
      // Ход торгов: в финале — одна строка цены без шага (PER-336, PER-639),
      // в онлайн-торгах — порог следующей ставки и шаг; затем свой лимит.
      const course = [
        ...(status.phase === "live"
          ? finalPriceLines(block, money)
          : block.nextPrice === undefined
            ? []
            : [`Следующая ставка: от ${money(block.nextPrice)}`]),
        ...(showsStep(block) ? stepLines(block, view) : []),
        // Свой лимит смотрящего: чужих Auction не отдаёт. Исчерпанный лимит
        // так и назван (PER-631, №81), в живом финале — без совета поднять
        // его (PER-713).
        ...ownLimitLines(block),
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
        // Свой лимит лоту, который ждёт финала (PER-822).
        ...(block.viewerProxyLimit === undefined ? [] : [ownLimitLines(block)]),
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
              : `Победитель: ${withAccount(participantName, view.winnerUsername)}`,
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
// (дизайн-код, «Карточка лота»): в окне «Счастливых часов» его условия до
// конца — стартовая окна, шаг или оба (PER-787) — и обычный шаг, иначе «Шаг»,
// когда он один на все цены, или «Шаг по порогам»; будущее окно — своей
// строкой. Окна Auction отдаёт только в торгах.
function stepLines(
  block: Extract<AuctionBlock, { kind: "lot" }>,
  view: AuctionView,
): string[] {
  const local = (instant: string) => communityLocalTime(instant, view.timeZone);
  const at = (instant: string) => readableMoment(local(instant), view.today);
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
  // Окно внутри одного дня называет день один раз.
  const from = local(next.from);
  const until = local(next.until);
  const sameDay =
    from.year === until.year &&
    from.month === until.month &&
    from.day === until.day;
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    ...startOnly,
    ...current,
    `Счастливые часы: с ${at(next.from)} до ${
      sameDay ? `${pad(until.hours)}:${pad(until.minutes)}` : at(next.until)
    }, ${nextTerms}`,
  ];
}

// Обычная стартовая — текущая цена лота в торгах без ставок: с ней стартовая
// окна идёт парой (PER-787).
function regularStart(
  block: Extract<AuctionBlock, { kind: "lot" }>,
): Money | undefined {
  return block.status.kind === "trading" && block.status.leaderId === undefined
    ? block.status.currentPrice
    : undefined;
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
