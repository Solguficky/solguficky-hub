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
export type LotCardView = {
  title: string;
  // Пустая строка — описания нет.
  description: string;
  image?: { version: string };
};

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

// Окно сниженного шага — полуинтервал `[from, until)`, моменты RFC 3339 в UTC.
export type StepWindowView = {
  from: string;
  until: string;
  step: Money;
};

// Порог шага по цене (PER-491): шаг при цене не ниже `lowerBound` и ниже
// следующего порога. Первая граница — ноль, границы возрастают (И-15).
export type StepTierView = {
  lowerBound: Money;
  step: Money;
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
  status: LotStatusView;
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

// Запись хронологии лота — публичный факт его журнала. Сегодня это только
// ставка: серия автоставок уже свёрнута Auction в одну запись с итоговой
// ценой. Запись вида, которого пакет не знает, адаптер пропускает.
export type LotHistoryEntryView = {
  kind: "bid";
  // Позиция факта в журнале лота: монотонна, но не непрерывна.
  sequence: number;
  // Момент RFC 3339 в UTC.
  occurredAt: string;
  bidId: string;
  participantId: string;
  amount: Money;
  origin: BidOriginView;
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
}

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
// закрытия, и регистрация не открывалась.
export type RaffleStatusView =
  | "open"
  | "closing"
  | "awaiting-beacon"
  | "drawn"
  | "no-tickets"
  | "not-held";

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
  getLotImage(request: { viewer: Viewer; lotId: string }): Promise<LotImage>;
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
  identity: IdentityPort;
  auction: AuctionPort;
  operations: OperationIdPort;
  favorites?: FavoritesPort;
  proxyExplainer?: ProxyExplainerPort;
};
