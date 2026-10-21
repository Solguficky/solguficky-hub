import type { AuctionCommand, AuctionQuestion } from "./callback-data.js";
import type {
  AuctionSummaryView,
  BidOriginView,
  BidRefusal,
  DisplayNameRefusal,
  LotCardView,
  LotSetView,
  LotStatusView,
  Money,
  OwnDisplayName,
  PredictionAnswer,
  PredictionRoundStatus,
  ProxyLimitRefusal,
  RaffleView,
  StepTierView,
  StepWindowView,
} from "./ports.js";
import type {
  PredictionNomination,
  PredictionRound,
} from "./prediction-spec.js";

// Каноническое тело аукционного экрана (ADR-044, «Один аукцион, две оболочки»).
// Одинаково в обоих ботах: приложение оборачивает его в свою оболочку —
// `HubScreen` или `AuctionEntryScreen` — и только затем переводит в Telegram
// API. Текстов поверхности здесь нет: блоки семантические, подписи к ним
// выбирает рендерер.

// Положение смотрящего на лоте (PER-595): ведёт торги или купил лот.
export type LotStanding = "leader" | "won";

// Лот в строке ленты: ровно то, что нужно его строке и кнопке.
export type FeedItem = {
  lotId: string;
  title?: string;
  status: LotStatusView;
  // Окно «Счастливых часов», которое действует сейчас: строка лота его
  // отмечает.
  activeWindow?: StepWindowView;
  standing?: LotStanding;
  // Сет, в который входит лот (ADR-073): строка ленты отмечает принадлежность
  // к нему. Нет — лот вне сета.
  setName?: string;
};

// Строка хронологии: ставка или снятие участника, как их показывает экран.
// Лимита прокси здесь нет — его нет и в порту.
export type HistoryItem =
  | {
      kind: "bid";
      sequence: number;
      occurredAt: string;
      amount: Money;
      origin: BidOriginView;
      // Имя ставившего — тем же путём, что имя лидера на карточке. Нет —
      // Auction имя не отдал; идентификатор вместо имени на экран не выходит.
      participantName?: string;
      // Автора сняли с лота (ADR-072): строка зачёркнута. Нет — не снят.
      removed?: true;
    }
  | {
      kind: "removal";
      sequence: number;
      occurredAt: string;
      price: Money;
      // Имя лидера после снятия. Нет — лидера нет или имя не отдано.
      leaderName?: string;
    };

export type AuctionBlock =
  | {
      // Корень аукциона (PER-605): стадия и сроки, вход в лоты и розыгрыш.
      // Нет `auction` — Auction аукцион не отдал: кнопка устарела.
      kind: "root";
      auctionId: string;
      auction?: AuctionSummaryView;
    }
  | {
      kind: "feed";
      auctionId: string;
      // Нумерация с нуля; пустая лента — одна страница без лотов.
      page: number;
      pageCount: number;
      // Лоты страницы — для кнопок.
      lots: readonly FeedItem[];
      // Свои лоты всей ленты — где смотрящий лидер или покупатель (PER-595):
      // текст экрана — сводка о них, а не повтор кнопок. Нет — своих нет.
      mine?: readonly FeedItem[];
      // Аукцион ещё не открыл торги (PER-618): в ленте есть лоты, и ни один
      // не торговался — все готовятся, запланированы или сняты. Сводка тогда
      // не говорит о лидерстве. Нет — торги идут, прошли или лотов нет.
      beforeTrading?: true;
      // Идёт живой финал (PER-639): лот, который ведущий торгует сейчас, — нет
      // его между лотами. Кнопки тогда стоят в порядке зала: активный лот,
      // оставшиеся лоты состава по порядку выхода, затем остальные по цене.
      // Нет поля — финал не идёт или стадию прочитать не удалось.
      final?: { active?: FeedItem };
    }
  | {
      kind: "lot";
      lotId: string;
      auctionId: string;
      version: number;
      card?: LotCardView;
      nextPrice?: Money;
      fixedStep?: Money;
      // Пороги шага, когда он задан по цене (PER-491): объявленные условия
      // лота, а не вычисленная сетка.
      tiers?: readonly StepTierView[];
      // Обычный шаг при текущей цене и окна «Счастливых часов» (PER-505):
      // действующее — с шагом в силе, будущее — только то, что снизит шаг
      // при текущей цене.
      baseStep?: Money;
      activeWindow?: StepWindowView;
      nextWindow?: StepWindowView;
      status: LotStatusView;
      // Смотрящий ведёт торги или купил лот (PER-595).
      standing?: LotStanding;
      // Имя участника из статуса: лидера в торгах или победителя проданного
      // лота. Нет — участника нет либо Auction имя не отдал; идентификатор
      // вместо имени на экран не выходит.
      participantName?: string;
      // Свой прокси-лимит смотрящего; других лимитов экран не знает.
      viewerProxyLimit?: Money;
      // Лот в своём избранном (ADR-063). Нет — Notifications не настроен
      // или не ответил, и кнопки избранного на карточке тоже нет.
      following?: boolean;
      // Карточка финала (PER-336): лот торгуется в живом финале, и поверхность
      // запоминает сообщение, чтобы править его по потоку аукциона. `page` —
      // страница ленты для кнопок карточки, которые соберёт правка.
      live?: { page: number };
      // Исход ставки финала — строкой на самой карточке, а не своим экраном,
      // как в онлайн-неделе (PER-472): карточка финала живая, и экран исхода
      // вытеснил бы её из чата вместе с кнопкой на новую цену (PER-336).
      finalBid?: FinalBidOutcome;
      // Сет, в который входит лот (ADR-073, п. 7): карточка называет его и
      // ведёт к его экрану. Нет — лот вне сета.
      set?: LotSetView;
    }
  | {
      // Экран сета (ADR-073, п. 7): лоты сета по порядку организатора и
      // собравший его после итога. Открывается с карточки лота сета.
      kind: "set";
      auctionId: string;
      // Название сета — как его назвал организатор.
      name: string;
      // Лоты сета. Тот, с которого открыт экран, — среди них.
      lots: readonly FeedItem[];
      // Лоты сета, которых экран не показал: предел страницы.
      more?: number;
      // Собравший сет по отображаемому имени. До итога сета его нет.
      collectorName?: string;
    }
  | {
      // Свои избранные лоты по порядку отметки (PER-495): цена, дедлайн и
      // итог — из снимка Auction, закрытые лоты остаются с итогом.
      kind: "favorites";
      // Нумерация с нуля; пустой список — одна страница без лотов.
      page: number;
      pageCount: number;
      lots: readonly FeedItem[];
      // Свои лоты всего списка — как у ленты (PER-595). `total` — сколько
      // лотов в избранном всего; нет — столько, сколько на странице.
      mine?: readonly FeedItem[];
      total?: number;
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
      // У бота есть избранное: экран говорит, что ставка кладёт лот туда
      // сама, а снятый вручную лот ставка не вернёт (ADR-063, PER-595).
      favorites?: true;
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
      // Ставка, которую автоставка сделает сразу: у лота без ставок это
      // стартовая цена (П-01), и лимит, равный ей, всё равно ставит её.
      firstBid?: Money;
    }
  | {
      // Вопрос с `force_reply`: сумма ставки, лимит или псевдоним. `current` —
      // подписанное текущее значение (PER-595): порог ставки или, при
      // `currentIsLimit`, свой лимит.
      kind: "question";
      question: AuctionQuestion;
      lotId: string;
      auctionId: string;
      title?: string;
      current?: Money;
      currentIsLimit?: true;
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
      // Статус лота, прочитанный вместе с хронологией: по нему оболочка
      // хаба решает, ставить ли администратору снятие участника (PER-659).
      status: LotStatusView;
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
      // Как проверить честность розыгрыша (PER-618): отпечаток seed, раунд
      // маяка, раскрытие и пересчёт. Экран участника о них молчит, чтобы
      // правила, регистрация и итог читались без техники. Нет `raffle` — у
      // аукциона розыгрыша нет: кнопка устарела.
      kind: "raffle-proof";
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
    }
  | {
      // Только свой прогноз (ADR-067): ответы не содержат чужих участников.
      kind: "prediction";
      auctionId: string;
      round: PredictionRound;
      status: PredictionRoundStatus;
      answers: readonly PredictionAnswer[];
      lotNames: Readonly<Record<string, string>>;
      staleNominations?: readonly PredictionNomination[];
      opensAt?: string;
      currency?: string;
      notice?:
        | "lot-not-in-round"
        | "round-closed"
        | "stale-answer-removed"
        | "unanswered";
    }
  | {
      // Выбор лота из каталога или удержанного состава финала.
      kind: "prediction-lots";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      page: number;
      pageCount: number;
      lots: readonly FeedItem[];
      currentLotId?: string;
      currentTitle?: string;
    }
  | {
      // Вопрос с force_reply для числовой номинации.
      kind: "prediction-number-question";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      currency?: string;
      currentValue?: number;
    }
  | {
      // Выбор имени перед отправкой прогноза, через тот же экран, что и ставка.
      kind: "prediction-name-choice";
      auctionId: string;
      round: PredictionRound;
      username?: string;
    }
  | {
      kind: "prediction-alias-question";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
    }
  | {
      kind: "prediction-answer-refused";
      auctionId: string;
      round: PredictionRound;
      nomination: PredictionNomination;
      refusal: AnswerRefusal;
    }
  | {
      // Имя в аукционе из настроек (PER-595). Нет `name` — имя не выбрано;
      // `frozen` — аукцион принял ставку, и выбора на экране нет. `username`
      // — ник из update без «@», пока выбор есть.
      kind: "name-settings";
      auctionId: string;
      name?: OwnDisplayName;
      username?: string;
    }
  | {
      // Вопрос псевдонима из настроек.
      kind: "name-question";
      auctionId: string;
    }
  | {
      // Непринятый псевдоним из настроек — свой экран исхода. Закреплённое
      // имя сюда не попадает: экран имени просто его называет.
      kind: "name-answer-refused";
      auctionId: string;
      refusal: "not-text" | Exclude<DisplayNameRefusal, "name-frozen">;
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

// Исход ставки финала одним нажатием (ADR-049): принята, отказ с ценой или
// ответа не было и после повтора тем же `op_id`. Отказ `bid-not-at-next-price`
// — гонка нажатий: карточка уже несёт кнопку на новую цену.
export type FinalBidOutcome =
  | { kind: "accepted"; amount: Money }
  | { kind: "refused"; refusal: BidRefusal }
  | { kind: "unknown" };

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
  | { action: "prediction.select-lot"; lotId: string; callbackData: string }
  // Лот сета на его экране: открывает карточку лота (ADR-073, п. 7).
  | { action: "set.open-lot"; lotId: string; callbackData: string }
  // «По шагу» с порогом в подписи: сумма — та, что уедет в подтверждение.
  | { action: "lot.bid-step"; amount: Money; callbackData: string }
  // «Поставить N» карточки финала: сумма — следующая цена, она же ожидаемая
  // цена команды (ADR-049), и ставка уходит без подтверждения.
  | { action: "lot.bid-final"; amount: Money; callbackData: string }
  | {
      action: // Корень аукциона: лоты, розыгрыш и избранное.
        | "root.lots"
        | "root.predictions"
        | "root.raffle"
        | "root.favorites"
        | "feed.prev"
        | "feed.next"
        | "lot.refresh"
        | "lot.bid-custom"
        | "lot.proxy"
        | "lot.history"
        // Лоты сета — экран сета с карточки лота сета (ADR-073, п. 7).
        | "lot.set"
        // Возврат с экрана сета — карточка лота, с которой он открыт.
        | "set.back"
        // Листание лотов в карточке (PER-644): соседи в порядке ленты.
        | "lot.prev"
        | "lot.next"
        | "lot.back"
        | "confirm.yes"
        | "confirm.no"
        | "question.cancel"
        | "question.explain"
        | "name.username"
        | "name.alias"
        | "name.back"
        | "accepted.lot"
        | "accepted.feed"
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
        // Возврат ленты в корень аукциона (PER-644).
        | "feed.back"
        | "prediction.edit"
        | "prediction.clear"
        | "prediction.switch-round"
        | "prediction.back"
        // Розыгрыш: вход из корня, регистрация и отмена, возврат в корень и,
        // с выбора имени и исхода, — в розыгрыш.
        | "raffle.register"
        | "raffle.cancel"
        // «Как проверить честность» с экрана розыгрыша (PER-618).
        | "raffle.proof"
        | "raffle.back"
        | "raffle.return"
        // Имя из настроек: возврат на экран имени с исхода.
        | "name.return";
      callbackData: string;
    };

export type AuctionScreenBody = {
  blocks: readonly AuctionBlock[];
  keyboard: readonly (readonly AuctionButton[])[];
};
