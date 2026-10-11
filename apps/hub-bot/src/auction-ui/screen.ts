import type { AuctionCommand, AuctionQuestion } from "./callback-data.js";
import type {
  BidOriginView,
  BidRefusal,
  DisplayNameRefusal,
  LotCardView,
  LotStatusView,
  Money,
  ProxyLimitRefusal,
  RaffleView,
  StepWindowView,
} from "./ports.js";

// Каноническое тело аукционного экрана (ADR-044, «Один аукцион, две оболочки»).
// Одинаково в обоих ботах: приложение оборачивает его в свою оболочку —
// `HubScreen` или `AuctionEntryScreen` — и только затем переводит в Telegram
// API. Текстов поверхности здесь нет: блоки семантические, подписи к ним
// выбирает рендерер.

// Лот в строке ленты: ровно то, что нужно его строке и кнопке.
export type FeedItem = {
  lotId: string;
  title?: string;
  status: LotStatusView;
  // Окно «Счастливых часов», которое действует сейчас: строка лота его
  // отмечает.
  activeWindow?: StepWindowView;
};

// Строка хронологии: ставка, как её показывает экран. Лимита прокси здесь
// нет — его нет и в порту.
export type HistoryItem = {
  kind: "bid";
  sequence: number;
  occurredAt: string;
  amount: Money;
  origin: BidOriginView;
  // Имя ставившего — тем же путём, что имя лидера на карточке. Нет — Auction
  // имя не отдал; идентификатор вместо имени на экран не выходит.
  participantName?: string;
};

export type AuctionBlock =
  | {
      kind: "feed";
      auctionId: string;
      // Нумерация с нуля; пустая лента — одна страница без лотов.
      page: number;
      pageCount: number;
      lots: readonly FeedItem[];
    }
  | {
      kind: "lot";
      lotId: string;
      auctionId: string;
      version: number;
      card?: LotCardView;
      nextPrice?: Money;
      fixedStep?: Money;
      // Обычный шаг при текущей цене и окна «Счастливых часов» (PER-505):
      // действующее — с шагом в силе, будущее — только то, что снизит шаг
      // при текущей цене.
      baseStep?: Money;
      activeWindow?: StepWindowView;
      nextWindow?: StepWindowView;
      status: LotStatusView;
      // Имя участника из статуса: лидера в торгах или победителя проданного
      // лота. Нет — участника нет либо Auction имя не отдал; идентификатор
      // вместо имени на экран не выходит.
      participantName?: string;
      // Свой прокси-лимит смотрящего; других лимитов экран не знает.
      viewerProxyLimit?: Money;
      // Лот в своём избранном (ADR-063). Нет — Notifications не настроен
      // или не ответил, и кнопки избранного на карточке тоже нет.
      following?: boolean;
    }
  | {
      // Свои избранные лоты по порядку отметки (PER-495): цена, дедлайн и
      // итог — из снимка Auction, закрытые лоты остаются с итогом.
      kind: "favorites";
      // Нумерация с нуля; пустой список — одна страница без лотов.
      page: number;
      pageCount: number;
      lots: readonly FeedItem[];
    }
  | {
      // Notifications ещё не знает лот: отметка не поставлена, и это свой
      // экран исхода с «К лоту», как отказ команды (PER-472).
      kind: "follow-refused";
      lotId: string;
      auctionId: string;
      title?: string;
    }
  | {
      // Отказ команды или неизвестный исход — свой экран, а не строка над
      // карточкой: исход и содержимое не смешиваются (решение владельца
      // 7 октября 2026 года, PER-472). Карточку открывает кнопка «К лоту».
      kind: "result";
      result: CommandResult;
      lotId: string;
      auctionId: string;
      title?: string;
    }
  | {
      // Непринятый ответ на вопрос или отказ имени — тоже свой экран (PER-472):
      // кнопка задаёт вопрос заново, если повтор имеет смысл, и «К лоту».
      kind: "answer-refused";
      refusal: AnswerRefusal;
      lotId: string;
      auctionId: string;
      title?: string;
    }
  | {
      // Принятая ставка или лимит — свой экран, а не строка над карточкой
      // (PER-473): цена на карточке сразу после «Да» ещё прежняя, потому что
      // чтение Auction отстаёт от команды. Карточку открывает кнопка, и она
      // читает лот заново.
      kind: "accepted";
      command: AuctionCommand;
      lotId: string;
      auctionId: string;
      title?: string;
      amount: Money;
    }
  | {
      // Подтверждение команды участника: ставку отменить нельзя (дизайн-код,
      // «Клавиатура»). Отдельного ряда навигации у него нет.
      kind: "confirm";
      command: AuctionCommand;
      lotId: string;
      auctionId: string;
      title?: string;
      amount: Money;
      // Цена лота сейчас: автоставка объясняется разницей цены и лимита.
      currentPrice: Money;
    }
  | {
      // Вопрос с `force_reply`: сумма ставки, лимит или псевдоним. `current` —
      // строка «Сейчас: …»: порог ставки или свой лимит.
      kind: "question";
      question: AuctionQuestion;
      lotId: string;
      auctionId: string;
      title?: string;
      current?: Money;
      // Пояснение автоставки голосом помощника (PER-517) — только у вопроса
      // лимита до первой принятой автоставки или по «Как это работает».
      // `example` — пример на этом лоте; нет — у лота нет цены или шага.
      explainer?: { example?: ProxyExample };
    }
  | {
      // Первая ставка в аукционе: имя видно всем участникам, и без ника его
      // заменяет псевдоним (ADR-059). `username` — ник из update, без «@».
      kind: "name-choice";
      lotId: string;
      auctionId: string;
      title?: string;
      username?: string;
    }
  | {
      kind: "history";
      lotId: string;
      auctionId: string;
      // Название лота для заголовка. Нет — у лота нет строки каталога.
      title?: string;
      // Нумерация с нуля; хронология без ставок — одна пустая страница.
      page: number;
      pageCount: number;
      // По возрастанию `sequence`: порядок журнала, а не часов.
      entries: readonly HistoryItem[];
    }
  | {
      // Розыгрыш среди участников (ADR-066, п. 11): что показать, решает
      // статус. Нет `raffle` — у аукциона розыгрыша нет: кнопка устарела.
      kind: "raffle";
      auctionId: string;
      raffle?: RaffleView;
    }
  | {
      // Выбор имени перед регистрацией (ADR-066, п. 3): тот же экран, что
      // перед первой ставкой, но возврат — в розыгрыш.
      kind: "raffle-name-choice";
      auctionId: string;
      username?: string;
    }
  | {
      // Вопрос псевдонима из розыгрыша.
      kind: "raffle-question";
      auctionId: string;
    }
  | {
      // Непринятый псевдоним из розыгрыша — свой экран исхода, как у лота.
      kind: "raffle-answer-refused";
      auctionId: string;
      refusal: "not-text" | DisplayNameRefusal;
    };

// Пример автоставки на текущем лоте: цена сейчас, шаг и лимит на три шага
// выше — выше него бот цену не поднимет. Считается из снимка лота, не
// выдумывается. `firstBid` — ставка, которую автоставка сделает сразу, —
// порог `nextPrice` от Auction; нет — смотрящий уже лидирует, и сразу бот не
// ставит. Последовательности ответов по шагам в примере нет: шаг на
// следующей цене считает Auction, и у ступенчатого лота он другой.
export type ProxyExample = {
  currentPrice: Money;
  step: Money;
  limit: Money;
  firstBid?: Money;
};

// Исход команды участника после «Да» или после ответа, отвергнутого до «Да».
// Отказ называет цену сам: оболочка пишет его заголовком экрана исхода.
// Принятая команда — экран `accepted`.
export type CommandResult =
  | { command: "bid"; kind: "refused"; refusal: BidRefusal }
  | { command: "proxy"; kind: "refused"; refusal: ProxyLimitRefusal }
  // Ответа Auction не дождались и после повтора тем же `op_id`: команда могла
  // пройти. Карточка, перечитанная следом, показывает, что вышло.
  | { command: AuctionCommand; kind: "unknown" };

// Почему ответ на вопрос не принят. `not-text` — ответили фото, стикером или
// голосом; суммы — ошибки разбора ввода, а имена — отказы Auction.
export type AnswerRefusal =
  | "not-text"
  | "not-a-number"
  | "other-currency"
  | "not-positive"
  | "too-precise"
  | "too-large"
  | DisplayNameRefusal;

// Действие кнопки. Подпись выбирает рендерер по нему же, поэтому поля с
// текстом у кнопки нет; лот кнопки ленты рендерер находит в блоке по `lotId`.
export type AuctionButton =
  | { action: "feed.open-lot"; lotId: string; callbackData: string }
  | { action: "favorites.open-lot"; lotId: string; callbackData: string }
  // «По шагу» с порогом в подписи: сумма — та, что уедет в подтверждение.
  | { action: "lot.bid-step"; amount: Money; callbackData: string }
  | {
      action:
        | "feed.prev"
        | "feed.next"
        | "lot.refresh"
        | "lot.bid-custom"
        | "lot.proxy"
        | "lot.history"
        | "lot.back"
        | "confirm.yes"
        | "confirm.no"
        | "question.cancel"
        | "question.explain"
        | "name.username"
        | "name.alias"
        | "name.back"
        | "accepted.lot"
        | "result.lot"
        | "answer.retry"
        | "history.prev"
        | "history.next"
        | "history.back"
        | "lot.follow"
        | "lot.unfollow"
        | "favorites.prev"
        | "favorites.next"
        | "favorites.back"
        // Розыгрыш: вход из ленты, регистрация и отмена, возврат в ленту и,
        // с выбора имени и исхода, — в розыгрыш.
        | "feed.raffle"
        | "raffle.register"
        | "raffle.cancel"
        | "raffle.back"
        | "raffle.return";
      callbackData: string;
    };

export type AuctionScreenBody = {
  blocks: readonly AuctionBlock[];
  keyboard: readonly (readonly AuctionButton[])[];
};
