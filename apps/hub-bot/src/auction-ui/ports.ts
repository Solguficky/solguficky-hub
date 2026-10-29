// Порты, через которые пакет ходит в Identity и Auction. Реализаций здесь нет:
// клиентов gRPC держит приложение и переводит в эти типы сгенерированные
// сообщения. Пакет поэтому не зависит ни от `@bufbuild/protobuf`, ни от
// сгенерированного кода, а contract suite подставляет вместо клиентов шпионов.

import type {
  PredictionNomination,
  PredictionRound,
} from "./prediction-spec.js";

export const ACCESS_RIGHTS = [
  "access-hub",
  "place-bids",
  "manage-members",
  "admit-bidders",
  "manage-meetups",
  "grant-admins",
  "run-auctions",
] as const;

// Права, которые Identity вывел из круга, наборов и выданных записей (RFC-016).
// Поверхность пускает только по праву — ни круг, ни набор допуск не решают;
// незнакомое право адаптер отбрасывает, и оно ничего не даёт.
export type AccessRight = (typeof ACCESS_RIGHTS)[number];

// Решение о допуске читает только права смотрящего: те же права уходят в
// Auction, и он решает по ним о своём ресурсе.
export type ResolvedIdentity = {
  viewer: Viewer;
  // Отметка блокировки. Допуск она не решает — только выбирает текст отказа.
  blocked: boolean;
};

export type TelegramUser = {
  telegramUserId: number;
  telegramUsername?: string;
};

export interface IdentityPort {
  resolveIdentity(user: TelegramUser): Promise<ResolvedIdentity>;
}

// Очередь, в которую поверхность ставит заявку на `/start`: хаб — в очередь
// сообщества, бот аукциона — в очередь аукциона (`identity.v1.ApplicationQueue`).
export type ApplicationQueue = "community" | "auction";

// Вход на `/start` (ADR-060, пункты 1–7 и 17–19; ADR-064, пункт 8).
export type AccessRequest = {
  user: TelegramUser;
  queue: ApplicationQueue;
  // Код канала из payload `s_<код>` без префикса, как пришёл: известен ли
  // канал, решает Identity. Нет — payload префикса не нёс; пустая строка —
  // пустой код после `s_`.
  sourceCode?: string;
  // `first_name` того же update — для карточки модератора.
  firstName: string;
};

export const ACCESS_REQUEST_OUTCOMES = [
  "already-held",
  "granted-by-allowlist",
  "pending",
  "declined",
  "blocked",
  // Очередь закрыта настройкой Identity: вход только по белому списку, заявки
  // нет (дополнение ADR-060 от 2026-10-25). Закрывается только очередь
  // сообщества, поэтому бот аукциона читает его как незнакомый исход.
  "invitation-only",
  // Значение, которого край не знает. По контракту читается как отказ.
  "unspecified",
] as const;

// `identity.v1.AccessRequestOutcome` в словаре пакета.
export type AccessRequestOutcome = (typeof ACCESS_REQUEST_OUTCOMES)[number];

// Отметки блокировки в ответе входа нет: её несёт исход `blocked`.
export type AccessRequestAnswer = {
  viewer: Viewer;
  outcome: AccessRequestOutcome;
};

// Порт входа отдельный от `IdentityPort`: шлюзу нажатия он не нужен, а заявку
// зовёт приложение — один раз на «Подать заявку», вместо разрешения личности
// (дополнение ADR-060 от 2026-10-12).
export interface EntryPort {
  requestAccess(request: AccessRequest): Promise<AccessRequestAnswer>;
}

// Смотрящий в запросах Auction с правами, которые вывел Identity (RFC-016).
// Круга, наборов и отметки блокировки здесь нет, как и в `auction.v1.Viewer`:
// решение по ресурсу Auction принимает по правам.
export type Viewer = {
  identityId: string;
  rights: readonly AccessRight[];
};

// Сумма в минимальных единицах валюты — копейках для RUB. `number`, а не
// `bigint`: суммы аукциона далеко внутри безопасного целого, а снимок ходит
// через `JSON.stringify` в contract suite. Адаптер проверяет `int64` провода.
export type Money = {
  minorUnits: number;
  currency: string;
};

// Каталожная карточка лота (ADR-057). Изображение — только его версия: байты
// грузит приложение через `LotImagePort`, когда показывает карточку.
// `image` — обложка, первое из `photos` (PER-721). Пустые `photos` при
// `image` — Auction до списка фото: карточка показывает одну обложку.
export type LotCardView = {
  title: string;
  // Пустая строка — описания нет.
  description: string;
  image?: { version: string };
  photos?: readonly LotPhotoView[];
};

// Одно фото лота в порядке показа (PER-721): байты — `getLotPhoto` по
// `photoId`, версия меняется вместе с байтами.
export type LotPhotoView = { photoId: string; version: string };

// Где лот, — ветка `status` снимка. Причины снятия и непродажи экраны не
// показывают, поэтому их здесь нет.
export type LotStatusView =
  | { kind: "draft" }
  | { kind: "scheduled"; startingPrice: Money }
  | {
      kind: "trading";
      currentPrice: Money;
      leaderId?: string;
      // Момент RFC 3339 в UTC. Нет — лот ведёт человек, а не время.
      deadline?: string;
      // Сколько раз анти-снайп уже продлил дедлайн; ноль — реальное значение.
      // Нет — адаптер его не назвал, и экран о продлении молчит.
      extensionsUsed?: number;
      // Онлайн-торги принимают любую сумму от порога, живой финал — ровно
      // следующую цену (ADR-049): у карточки финала одна кнопка на неё.
      phase: TradingPhase;
      // Цена, которую объявил ведущий, — только пока она выше текущей: тогда
      // она и есть следующая цена (П-08 RFC-011).
      ask?: Money;
    }
  | { kind: "held"; currentPrice: Money; leaderId?: string }
  | { kind: "sold"; winnerId: string; price: Money }
  | { kind: "unsold" }
  | { kind: "withdrawn" };

export type TradingPhase = "online" | "live";

// Окно «Счастливых часов» лота — полуинтервал `[from, until)`, моменты RFC 3339
// в UTC. Окно задаёт шаг, стартовую цену или оба (ADR-047, дополнение
// 2026-10-27); хотя бы одно есть всегда.
export type StepWindowView = {
  from: string;
  until: string;
  // Шаг в окне. Нет — окно шаг не меняет.
  step?: Money;
  // Цена первой ставки в окне, пока у лота нет ставок, ниже обычной
  // стартовой. У действующего окна Auction отдаёт её, только пока она и есть
  // следующая цена; у будущего — объявленной.
  start?: Money;
};

// Порог шага по цене (PER-491): шаг при цене не ниже `lowerBound` и ниже
// следующего порога. Первая граница — ноль, границы возрастают (И-15).
export type StepTierView = {
  lowerBound: Money;
  step: Money;
};

// Сет лотов, в который входит лот (ADR-073, п. 1): название и состав по
// порядку организатора. Сет из меньше чем двух лотов участнику не
// показывается, поэтому в снимке его нет вовсе.
export type LotSetView = {
  name: string;
  // Лоты сета по порядку организатора.
  lotIds: readonly string[];
  // Собравший сет по отображаемому имени в аукционе. До итога сета его нет:
  // Auction записывает собравшего один раз, когда последний лот сета пришёл к
  // терминальному исходу (ADR-073, п. 4).
  collectorName?: string;
};

// Срез `auction.v1.LotSnapshot`, который нужен экранам. Поля добавляют листья,
// которые их показывают.
export type LotView = {
  lotId: string;
  auctionId: string;
  version: number;
  // Нет — у лота нет строки каталога; это не то же, что пустое описание.
  card?: LotCardView;
  // Порог ставки сейчас; есть только у лота в торгах.
  nextPrice?: Money;
  // Шаг, когда он один на все цены. Сетку шагов край не вычисляет: правило
  // шага принадлежит Auction, а `nextPrice` уже несёт его результат.
  fixedStep?: Money;
  // Пороги шага, когда он задан по цене (PER-491). Это объявленные условия
  // лота, а не вычисленная сетка: `nextPrice` по-прежнему считает Auction.
  tiers?: readonly StepTierView[];
  // Обычный шаг при текущей цене, без окна; есть только у лота в торгах.
  baseStep?: Money;
  // Окно «Счастливых часов», которое действует сейчас и снижает шаг, с шагом
  // в силе. Auction считает его на момент ответа, поэтому после конца окна
  // следующее чтение его уже не несёт.
  activeWindow?: StepWindowView;
  // Ближайшее окно, которое ещё не началось, с объявленной суммой шага.
  nextWindow?: StepWindowView;
  // Принимает ли лот прокси-лимиты. У лота без условий торгов — нет.
  proxyEnabled: boolean;
  // Свой лимит смотрящего. Чужих лимитов Auction не отдаёт вовсе.
  viewerProxyLimit?: Money;
  // Сет, в который входит лот (ADR-073). Нет — лот вне сета.
  lotSet?: LotSetView;
  // Анти-снайп из условий торгов: ставка ближе `windowSeconds` к дедлайну
  // продлевает его, пока продлений меньше `maxExtensions` (PER-631, №107).
  // Нет — у лота нет условий торгов.
  antiSnipe?: AntiSnipeView;
  status: LotStatusView;
};

export type AntiSnipeView = {
  windowSeconds: number;
  maxExtensions: number;
};

// Одна страница `ListAuctionLots`. Пустой `nextPageToken` — лента кончилась.
export type LotPage = {
  lots: readonly LotView[];
  nextPageToken: string;
};

// Как поставлена ставка. Канал есть только у ручной: прокси-ставку ставит
// система в пределах лимита, а сам лимит в хронологию не попадает.
export type BidOriginView =
  | { kind: "manual"; source: "bot" | "floor" }
  | { kind: "proxy" };

// Запись хронологии лота — публичный факт его журнала: ставка или снятие
// участника администратором (ADR-072). Серия автоставок уже свёрнута Auction
// в одну запись с итоговой ценой. Запись вида, которого пакет не знает,
// адаптер пропускает.
export type LotHistoryEntryView =
  | {
      kind: "bid";
      // Позиция факта в журнале лота: монотонна, но не непрерывна.
      sequence: number;
      // Момент RFC 3339 в UTC.
      occurredAt: string;
      bidId: string;
      participantId: string;
      amount: Money;
      origin: BidOriginView;
      // Автора ставки потом сняли с лота: запись остаётся с пометкой. Нет —
      // ставка не снята.
      removed?: true;
    }
  | {
      // Кого сняли, говорят пометки ставок; кто снял и почему, Auction
      // наружу не отдаёт.
      kind: "removal";
      sequence: number;
      occurredAt: string;
      // Цена, с которой лот пошёл дальше.
      price: Money;
      // Лидер после снятия. Нет — вести лот некому.
      leaderId?: string;
    };

// Одна страница `ListLotHistory` по возрастанию `sequence`. Пустой
// `nextPageToken` — хронология кончилась.
export type LotHistoryPage = {
  entries: readonly LotHistoryEntryView[];
  nextPageToken: string;
};

// Где аукцион — ветка `status` у `auction.v1.AuctionSnapshot`. Корень аукциона
// (PER-605) называет стадию и сроки онлайн-торгов; правило каждой стадии
// принадлежит Auction, дерево его не выводит.
export type AuctionStageView =
  | "draft"
  | "scheduled"
  | "prebidding"
  | "settling"
  | "on-break"
  | "lineup-frozen"
  | "in-final"
  | "finished"
  | "cancelled";

// Срез `auction.v1.AuctionSnapshot` для корня аукциона. Моменты — RFC 3339 в
// UTC; нет — у черновика конфигурации нет или фаза их не задала.
export type AuctionSummaryView = {
  auctionId: string;
  stage: AuctionStageView;
  opensAt?: string;
  closesAt?: string;
  // Финал в зале запланирован: после онлайн-торгов лоты состава уходят в него.
  final: boolean;
  // Состав финала (PER-639): есть, только пока состав объявлен или идёт финал.
  lineup?: FinalLineupView;
  // Аукцион скрыт от участников (ADR-047, дополнение 2026-10-20): признак
  // приходит только тому, от кого аукцион не скрыт, — держателю
  // `run_auctions`; остальным скрытого аукциона нет вовсе.
  hidden?: true;
  // Ориентировочное начало финала (ADR-040, дополнение 2026-10-19): анонс,
  // а не условие торгов. Нет — администратор его не выставил.
  finalAt?: string;
  // «Счастливые часы» недели (PER-724): объявленные в конфигурации и
  // запущенные по ходу торгов, по началу окна. Нет — окон нет.
  stepWindows?: readonly AuctionStepWindowView[];
  // Закрытие регистрации в розыгрыше из конфигурации недели (PER-593) —
  // строка состояния аукциона в меню и списках (PER-767). Нет — неделя без
  // розыгрыша.
  raffleClosesAt?: string;
  // Порядок и разделы ленты, которые выставил администратор (PER-719). Нет —
  // администратор лоты не упорядочивал, и лента идёт в порядке создания.
  layout?: LotLayoutView;
  // Промо-видео аукциона (PER-774): номер поста в чате медиа ботов, который
  // выставил администратор. Нет — видео нет.
  promoVideo?: number;
};

// Порядок и разделы ленты (PER-719): лоты вне разделов и разделы, каждые в
// порядке администратора. Лот стоит не больше чем в одном месте.
export type LotLayoutView = {
  lotIds: readonly string[];
  sections: readonly LotSectionView[];
};

// Раздел ленты: номер выбирает пульт, он же едет в кнопке раздела.
export type LotSectionView = {
  sectionId: number;
  name: string;
  lotIds: readonly string[];
};

// Окно сниженного шага аукциона — полуинтервал [from, until) моментов
// RFC 3339 в UTC и лоты, к которым оно применяется.
export type AuctionStepWindowView = {
  from: string;
  until: string;
  lotIds: readonly string[];
};

// Замороженный состав финала: лоты в порядке выхода и лот, который ведущий
// торгует сейчас. Активного лота нет до первого и между лотами.
export type FinalLineupView = {
  order: readonly string[];
  activeLotId?: string;
};

export interface AuctionPort {
  // Аукцион по идентификатору (PER-605) или `undefined`, если Auction его не
  // отдаёт этому вызывающему: удалённый, чужой или черновик для бота аукциона.
  // Прочие отказы метод бросает.
  getAuction(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<AuctionSummaryView | undefined>;
  // `atLeastVersion` — версия из ответа принятой команды (PER-470): адаптер
  // дочитывает лот до неё в своём бюджете, а не догнав — отдаёт последний
  // прочитанный снимок, а не отказ. Без неё — одно чтение.
  getLot(request: {
    viewer: Viewer;
    lotId: string;
    atLeastVersion?: number;
  }): Promise<LotView>;
  // Лот или `undefined`, если Auction его не знает или смотрящему не видно:
  // NOT_FOUND здесь ответ, а не сбой. Списку избранного (PER-495) он отличает
  // лот удалённого аукциона, отметка на который живёт в Notifications, от
  // отказа соседа. Прочие отказы метод бросает, как `getLot`.
  findLot(request: {
    viewer: Viewer;
    lotId: string;
  }): Promise<LotView | undefined>;
  listAuctionLots(request: {
    viewer: Viewer;
    auctionId: string;
    pageToken: string;
  }): Promise<LotPage>;
  listLotHistory(request: {
    viewer: Viewer;
    lotId: string;
    pageToken: string;
  }): Promise<LotHistoryPage>;
  // Готовые к показу имена по идентификаторам участников (ADR-059): метки
  // ставит Auction, край их не добавляет.
  getDisplayNames(request: {
    viewer: Viewer;
    auctionId: string;
    participantIds: readonly string[];
  }): Promise<Readonly<Record<string, string>>>;
  // Своё имя смотрящего в аукционе (ADR-059) — тем же `GetDisplayNames`.
  // `undefined` — имя не выбрано: Auction отдал заглушку (PER-595).
  getOwnDisplayName(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<OwnDisplayName | undefined>;
  placeBid(request: {
    viewer: Viewer;
    lotId: string;
    amount: Money;
    opId: string;
  }): Promise<CommandOutcome<BidRefusal>>;
  setProxyLimit(request: {
    viewer: Viewer;
    lotId: string;
    max: Money;
    opId: string;
  }): Promise<CommandOutcome<ProxyLimitRefusal>>;
  chooseDisplayName(request: {
    viewer: Viewer;
    auctionId: string;
    choice: DisplayNameChoice;
  }): Promise<DisplayNameOutcome>;
  // Розыгрыш среди участников (ADR-066): `undefined` — у аукциона его нет или
  // он ещё не открыт — регистрация открывается вместе с онлайн-торгами.
  getRaffle(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<RaffleView | undefined>;
  registerForRaffle(request: {
    viewer: Viewer;
    auctionId: string;
    opId: string;
  }): Promise<RaffleOutcome<RaffleRegistrationRefusal>>;
  cancelRaffleRegistration(request: {
    viewer: Viewer;
    auctionId: string;
    opId: string;
  }): Promise<RaffleOutcome<RaffleCancellationRefusal>>;
  // Прогнозы (ADR-067): читается только состояние смотрящего; отправка всегда
  // заменяет весь прогноз раунда, а `unanswered` повторяется с тем же `opId`.
  getMyPredictions(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<readonly PredictionRoundView[]>;
  submitPrediction(request: {
    viewer: Viewer;
    auctionId: string;
    round: PredictionRound;
    answers: readonly PredictionAnswer[];
    opId: string;
  }): Promise<PredictionOutcome>;
  // Счета смотрящего в аукционе и текст организатора «как оплатить и
  // получить» (PER-322). Пустой список — смотрящий ничего не выиграл; чужих
  // счетов Auction не отдаёт. Отказы метод бросает.
  listMyInvoices(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<MyInvoicesView>;
  // Способ получения своего счёта (P-54): выбор заменяет прежний до выдачи.
  chooseFulfillment(request: {
    viewer: Viewer;
    invoiceId: string;
    method: FulfillmentMethod;
    opId: string;
  }): Promise<FulfillmentOutcome>;
  // Итоги прогнозов (PER-568). Четыре исхода чтения Auction.
  getPredictionResults(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<PredictionResultsView>;
  // Хроники дня (PER-725): агрегаты последних суток. Окно выбирает Auction по
  // своим часам, право — `place_bids`.
  getDayChronicle(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<DayChronicleView>;
  // Статистика аукциона (PER-770): те же агрегаты за все торги. Право —
  // `place_bids`, как у хроник дня.
  getAuctionChronicle(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<AuctionChronicleView>;
}

// Статистика аукциона (PER-770) — срез `GetAuctionChronicle`: счётчики всех
// торгов, рекорд роста, который выбрал Auction, и агрегаты каждого лота
// реестра без значимого порядка. Людей в срезе нет — только их число.
export type AuctionChronicleView = {
  bidCount: number;
  participantCount: number;
  tradedLotCount: number;
  // Нет — ни один лот не вырос.
  growthRecord?: { lotId: string; growth: Money };
  lots: readonly AuctionChronicleLot[];
};

export type AuctionChronicleLot = {
  lotId: string;
  bidCount: number;
  leaderChanges: number;
  longestDuel: number;
};

// Хроники дня (PER-725) — срез `GetAuctionDayChronicle`: агрегаты окна каждого
// лота реестра без значимого порядка, а из жизни лота — только число ставок и
// рост от стартовой цены, по которым ищется «тёмная лошадка». Служебного пульта
// — участников, времени последней ставки — Auction сюда не отдаёт.
export type DayChronicleView = {
  lots: readonly DayChronicleLot[];
};

export type DayChronicleLot = {
  lotId: string;
  // Ставки, смены лидера и самая длинная дуэль — окна.
  bidCount: number;
  leaderChanges: number;
  longestDuel: number;
  // Ставки за всю жизнь лота, прочитанные после окна.
  totalBidCount: number;
  // Текущая цена минус стартовая; нет — у лота нет цены.
  priceGrowth?: Money;
};

// Счёт проданного лота глазами победителя (PER-322; integration.md,
// «Счета»). Деньги идут мимо продукта: оплату отмечает организатор, и статус
// меняется только его отметкой.
export type FulfillmentMethod = "pickup" | "delivery" | "digital";

export type InvoiceStatus = "awaiting-payment" | "paid" | "handed-over";

export type WinnerInvoiceView = {
  invoiceId: string;
  lotId: string;
  amount: Money;
  // Момент RFC 3339 в UTC. Просрочка — не статус: счёт ждёт оплаты после него.
  paymentDueAt: string;
  // Нет — победитель способ ещё не выбрал.
  fulfillment?: FulfillmentMethod;
  status: InvoiceStatus;
};

export type MyInvoicesView = {
  invoices: readonly WinnerInvoiceView[];
  // Свободный текст администратора; нет — он его не написал.
  paymentInstructions?: string;
};

// `not-found` — счёта нет или он чужой: Auction их не различает.
export type FulfillmentOutcome =
  | { kind: "accepted" }
  | { kind: "refused"; refusal: "fulfillment-frozen" }
  | { kind: "not-found" }
  | { kind: "unanswered" };

export type PredictionOwnResult =
  | { kind: "guessed" }
  | { kind: "missed"; deviation?: number };

export type PredictionNominationResult = {
  nomination: PredictionNomination;
  value:
    | { kind: "lots"; lotIds: readonly string[] }
    | { kind: "number"; value: number };
  winnerNames: readonly string[];
  winnerCount: number;
  mine?: PredictionOwnResult;
};

export type PredictionResultsView =
  | { kind: "after-final" }
  | { kind: "by-hand" }
  | { kind: "cancelled" }
  | {
      kind: "counted";
      nominations: readonly PredictionNominationResult[];
    };

export type PredictionAnswer =
  | {
      nomination: PredictionNomination;
      answer: { kind: "lot"; lotId: string };
    }
  | {
      nomination: PredictionNomination;
      answer: { kind: "number"; value: number };
    };

export type PredictionRoundStatus =
  | "not-open"
  | "open"
  | "closed"
  | "cancelled";

export type PredictionRoundView = {
  round: PredictionRound;
  status: PredictionRoundStatus;
  answers: readonly PredictionAnswer[];
};

export type Prediction = Pick<PredictionRoundView, "round" | "answers">;

export type PredictionRefusal =
  | { kind: "round-not-open" }
  | { kind: "round-closed" }
  | { kind: "cancelled" }
  | { kind: "display-name-not-chosen" }
  | {
      kind: "lot-not-in-round";
      nomination: PredictionNomination;
      lotId: string;
    };

export type PredictionOutcome =
  | { kind: "accepted"; prediction: Prediction }
  | { kind: "refused"; refusal: PredictionRefusal }
  | { kind: "unanswered" };

// Где розыгрыш (`auction.v1.RaffleStatus`). `closing` — момент закрытия прошёл,
// а пул ещё фиксируется; `not-held` — онлайн-торги открылись не раньше момента
// закрытия, и регистрация не открывалась; `cancelled` — аукцион отменили до
// жеребьёвки (ADR-066, дополнение 2026-10-12), и seed не раскроется;
// `awaiting-winner` — пул ждёт итога, который назовёт администратор
// (ADR-066, дополнение 2026-10-24).
export type RaffleStatusView =
  | "open"
  | "closing"
  | "awaiting-beacon"
  | "awaiting-winner"
  | "drawn"
  | "no-tickets"
  | "not-held"
  | "cancelled";

// Билет пула. Имени нет — его стёрли через 30 дней после жеребьёвки; номер
// остаётся.
export type RaffleTicketView = { number: number; displayName?: string };

// Что нужно для пересчёта без доступа к сервису (ADR-066, «Пересчёт
// участником»). У пула без билетов есть только seed.
export type RaffleRevealView = {
  seed: string;
  randomness?: string;
  value?: string;
  winningTicket?: number;
};

// Розыгрыш, как его видит смотрящий: `registered` и `myTicket` — о нём.
export type RaffleView = {
  auctionId: string;
  status: RaffleStatusView;
  // Момент RFC 3339 в UTC: когда закрывается регистрация.
  closesAt: string;
  // Момент RFC 3339 в UTC: когда прошла жеребьёвка; нет до неё и при пустом пуле.
  drawnAt?: string;
  // SHA-256 seed строчным hex и раунд маяка drand; нет у непроведённого.
  commitment?: string;
  beaconRound?: number;
  registered: boolean;
  // Билеты 1…N по порядку регистрации; пусто, пока пул не зафиксирован.
  tickets: readonly RaffleTicketView[];
  myTicket?: number;
  reveal?: RaffleRevealView;
  // Приз розыгрыша одной строкой (PER-649); нет — розыгрыш без приза.
  prize?: string;
  // Итог называет администратор, а не маяк (PER-727): известно с фиксации
  // пула, и пересчитывать такой итог нечего. Нет поля — итог по маяку.
  drawnByHand?: true;
  // Фото приза без байтов (PER-773): байты читает край через
  // `LotImagePort.getRafflePrizePhoto`, версия — ключ кэша `file_id`. Нет —
  // приз без фото.
  prizePhoto?: { photoId: string; version: string };
};

export type RaffleRegistrationRefusal =
  | "raffle-not-found"
  | "registration-closed"
  | "display-name-not-chosen";

export type RaffleCancellationRefusal =
  | "raffle-not-found"
  | "registration-closed";

// Исход команды розыгрыша: принятая отвечает розыгрышем после неё, поэтому
// экран не перечитывает его. `unanswered` повторяется тем же `op_id`, как у
// ставки.
export type RaffleOutcome<Refusal> =
  | { kind: "accepted"; raffle: RaffleView }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "unanswered" };

// Источник `op_id`: канонический UUIDv7 в нижнем регистре с дефисами. Портом,
// а не вызовом внутри пакета, чтобы contract suite видел ключ команды.
export interface OperationIdPort {
  newOperationId(): string;
}

// Именованные отказы команд участника (integration.md, «Auction gRPC»). Отказ
// окончателен: повторять команду после него край не вправе (RFC-011, П-06),
// поэтому он несёт цену, которую экран называет человеку.
export type BidRefusal =
  | { kind: "lot-not-open" }
  | { kind: "lot-on-hold"; currentPrice: Money }
  | { kind: "bid-below-minimum"; minRequired: Money }
  | { kind: "bid-above-maximum"; next: Money }
  | { kind: "bid-not-at-next-price"; expected: Money }
  | { kind: "bidder-is-leader"; currentPrice: Money }
  | { kind: "currency-mismatch" }
  | { kind: "display-name-not-chosen" }
  | { kind: "removed-from-lot" };

// `removed-from-lot` у ставки и у лимита — администратор снял участника с лота
// (ADR-072): ставить и выставлять лимит на этом лоте он больше не может, а кто
// и почему снял, ответ не несёт.
export type ProxyLimitRefusal =
  | { kind: "lot-not-open" }
  | { kind: "proxy-below-current-price"; minLimit: Money }
  | { kind: "proxy-disabled" }
  | { kind: "currency-mismatch" }
  | { kind: "display-name-not-chosen" }
  | { kind: "removed-from-lot" };

// Исход команды с `op_id`. `unanswered` — ответа не было вовсе: дедлайн вызова
// истёк или связь оборвалась. Только его пакет повторяет, и тем же `op_id`:
// принятую команду Auction узнаёт по нему и второй раз не исполняет. Прочие
// сбои транспорта порт бросает.
//
// `lotVersion` принятой команды — версия `LotView`, с которой чтение показывает
// её целиком; 0 — Auction её не назвал.
export type CommandOutcome<Refusal> =
  | { kind: "accepted"; lotVersion: number }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "unanswered" };

// Как участник показан в аукционе (ADR-059): ник из update без «@» — пустая
// строка значит, что ника нет, — или псевдоним, как его ввели.
export type DisplayNameChoice =
  | { kind: "username"; username: string }
  | { kind: "alias"; alias: string };

export type DisplayNameRefusal =
  | "username-missing"
  | "alias-invalid"
  | "alias-taken"
  | "name-frozen";

// Выбранное имя смотрящего. `frozen` — аукцион уже принял его ставку или
// лимит, и выбор больше не меняется (ADR-059, п. 5).
export type OwnDisplayName = { text: string; frozen: boolean };

// `frozen` у принятого — повтор того же выбора после первой ставки: имя
// закреплено (PER-595).
export type DisplayNameOutcome =
  | { kind: "accepted"; name: string; frozen?: true }
  | { kind: "refused"; refusal: DisplayNameRefusal };

export type LotImage = {
  content: Uint8Array;
  mediaType: string;
  // Версия этих байтов; может быть новее версии из прочитанной карточки.
  version: string;
};

// Байты изображения лота. Пакет этот порт не зовёт: загрузка файла и кэш
// `file_id` — дело Telegram-края приложения (ADR-057, дополнение), а тип здесь,
// чтобы оба бота реализовали одну сигнатуру.
export interface LotImagePort {
  getAchievementImage?(code: string): Promise<LotImage>;
  getLotImage(request: { viewer: Viewer; lotId: string }): Promise<LotImage>;
  // Одно фото лота по идентификатору из `LotCardView.photos` (PER-721).
  getLotPhoto(request: {
    viewer: Viewer;
    lotId: string;
    photoId: string;
  }): Promise<LotImage>;
  // Фото приза розыгрыша аукциона (PER-773) в той же форме. Нет метода —
  // экран розыгрыша идёт без фото.
  getRafflePrizePhoto?(request: {
    viewer: Viewer;
    auctionId: string;
  }): Promise<LotImage>;
}

// Избранные лоты (ADR-063): отметка «человек следит за лотом» живёт в
// Notifications, а цену, дедлайн и итог экран берёт у Auction. Отметка своя:
// смотрящий отмечает и читает только себя. Ответ команды — состояние после
// неё, поэтому повтор не создаёт дубля. `not-ready` — Notifications ещё не
// знает лот: факт `AUCTION_EVENTS` не дошёл, и повтор решает человек.
export type FollowOutcome =
  | { kind: "done"; following: boolean }
  | { kind: "not-ready" };

export interface FavoritesPort {
  // Свои отметки по возрастанию момента отметки, закрытые лоты включительно.
  listFollowedLots(viewer: Viewer): Promise<readonly string[]>;
  followLot(request: { viewer: Viewer; lotId: string }): Promise<FollowOutcome>;
  unfollowLot(request: {
    viewer: Viewer;
    lotId: string;
  }): Promise<FollowOutcome>;
}

// Пояснение автоставки (PER-517): вопрос лимита объясняет разницу цены и
// лимита, пока у человека нет ни одной принятой автоставки. Отметка живёт в
// Notifications и одна у человека в обоих ботах; лимиты туда не уезжают.
export interface ProxyExplainerPort {
  seen(viewer: Viewer): Promise<boolean>;
  markSeen(viewer: Viewer): Promise<void>;
}

// `favorites` нет — у процесса нет адреса Notifications: карточка обходится
// без кнопки избранного, а список отказывает как недоступный сосед. Нет
// `proxyExplainer` — вопрос лимита объясняет автоставку каждый раз.
export type AuctionBotPorts = {
  achievements?: import("./achievement-types.js").AchievementsPort;
  identity: IdentityPort;
  auction: AuctionPort;
  operations: OperationIdPort;
  favorites?: FavoritesPort;
  proxyExplainer?: ProxyExplainerPort;
  // Чат медиа ботов включён (PER-774): корень аукциона с видео ставит
  // «🎬 Промо». Нет — кнопки нет, а подделанная кнопка отвечает «видео
  // недоступно». Показ поста — вызов Telegram, его делает поверхность.
  media?: true;
};
