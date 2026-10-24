import type {
  AuctionPort,
  AuctionSummaryView,
  LotImagePort,
  LotPhotoView,
  LotView,
  Money,
  OperationIdPort,
  RaffleView,
  Viewer,
} from "../../../auction-ui/index.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoleSnapshot,
  Invoice,
  InvoiceMark,
  Person,
  RemovalRefusal,
  StepWindow,
} from "../application/types.js";

// Аукцион у сходки (ADR-047, дополнение 2026-10-03; PER-307). Бот хаба зовёт
// Auction в двух ролях. Оболочка сходки — эти два метода: аукцион сходки на
// карточке и его включение. Торговые экраны — порты аукционного дерева ниже: их
// юзкейсы живут в пакете, и бот только даёт им транспорт.

export type AuctionFailure =
  | { kind: "timeout"; cause: unknown }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "forbidden" }
  | { kind: "invalid"; cause: unknown };

// `auctionId` нет — у сходки нет аукциона. Это ответ, а не отказ: Auction
// отвечает пустым снимком, и черновик аукциона тоже считается аукционом.
// `auction` — стадия и сроки для строки аукциона на карточке сходки (PER-594);
// нет её — снимок не разобрался, и строки не будет.
export type MeetupAuctionResult =
  | { kind: "ok"; auctionId?: string; auction?: AuctionSummaryView }
  | AuctionFailure;

// Повторное включение не отказ: Auction отвечает существующим аукционом и
// `alreadyExisted`. Отказы — значения ответа, их бот не повторяет.
export type EnableAuctionResult =
  | { kind: "enabled"; auctionId: string; alreadyExisted: boolean }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | AuctionFailure;

// Сколько лотов аукциона продано: их называет подтверждение отмены сходки с
// идущими торгами (ADR-064, дополнение 2026-10-12). Счётчика в контракте нет —
// продажа живёт на снимке лота, и край считает её по реестру аукциона.
export type SoldLotsResult = { kind: "ok"; sold: number } | AuctionFailure;

export type MeetupAuctions = {
  getMeetupAuction(
    person: Person,
    meetupId: string,
    meta?: RpcMetadata,
  ): Promise<MeetupAuctionResult>;
  soldLots(
    person: Person,
    auctionId: string,
    meta?: RpcMetadata,
  ): Promise<SoldLotsResult>;
  // `opId` рождает край на каждое нажатие: ключ аукциона выводит сервер из
  // сходки, поэтому второй аукцион не родится ни от какого повтора.
  enableAuction(
    person: Person,
    meetupId: string,
    opId: string,
    meta?: RpcMetadata,
  ): Promise<EnableAuctionResult>;
};

// Форма лота администратора (PER-319; ADR-057, дополнение 2026-10-05): команды
// каталога, реестра и условий торгов и чтение лота для экрана правки. Третья
// роль бота хаба перед Auction, и только его: аукционное дерево формы не несёт.
// Именованный отказ Auction — значение ответа, и бот его не повторяет.

// `card-conflict` бывает только у создания: карточка с этим `lot_id` уже есть
// с другим текстом. `card-not-found` — только у правки. Отказы изображения —
// только у правки, которая его заменяет (PER-452): предел размера и тип файла
// решает Auction, а `maxBytes` — его предел, как он его назвал.
export type LotCardResult =
  | { kind: "ok" }
  | { kind: "not-admin" }
  | { kind: "empty-title" }
  | { kind: "card-conflict" }
  | { kind: "card-not-found" }
  | { kind: "card-closed" }
  | { kind: "image-too-large"; maxBytes: number }
  | { kind: "unsupported-image" }
  | AuctionFailure;

// Исход команды фото лота (PER-721). `ok` несёт фото лота после команды:
// чтение Auction её ещё могло не увидеть, а форма называет их число.
// `photo-limit` — у лота уже предел фото, `maxPhotos` — предел, как его назвал
// Auction. Отказы изображения бывают только у добавления.
export type LotPhotoResult =
  | { kind: "ok"; photos: readonly LotPhotoView[] }
  | { kind: "not-admin" }
  | { kind: "card-not-found" }
  | { kind: "card-closed" }
  | { kind: "image-too-large"; maxBytes: number }
  | { kind: "unsupported-image" }
  | { kind: "photo-limit"; maxPhotos: number }
  | { kind: "photo-conflict" }
  | AuctionFailure;

export type AddLotResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lots-frozen" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// `lots-frozen` — аукцион в торгах, `scheduling-closed` — лот уже открыт: для
// человека это один ответ, но называет их Auction раздельно.
export type ScheduleLotResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lots-frozen" }
  | { kind: "lot-not-in-auction" }
  | { kind: "scheduling-closed" }
  | { kind: "step-policy-invalid" }
  | { kind: "currency-mismatch" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type LotReadResult =
  | { kind: "ok"; lot: LotView }
  | { kind: "not-found" }
  | AuctionFailure;

// Снятие лота из реестра до онлайн-торгов (PER-716). `lot-not-in-auction` —
// лота в реестре уже нет: снятие прошло раньше.
export type RemoveLotResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lots-frozen" }
  | { kind: "lot-not-in-auction" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Байты фото лота для копий (PER-716, PER-721): копия получает те же фото, а
// Auction держит каждое версией содержимого.
export type LotImageResult =
  | { kind: "ok"; content: Uint8Array; version: string }
  | { kind: "not-found" }
  | AuctionFailure;

export type LotCardText = { lotId: string; title: string; description: string };

// Шаг ставки условий лота (PER-491): один на все цены либо по ценовым порогам.
// У порогов первая граница — ноль, границы возрастают (И-15 RFC-011).
export type LotTierInput = { lowerBound: Money; step: Money };
export type LotStepPolicyInput =
  | { kind: "fixed"; step: Money }
  | { kind: "tiered"; tiers: readonly LotTierInput[] };

// Правка карточки. Без `image` изображение остаётся как есть: `image_change` не
// выставляется. С ним — заменяется файлом, скачанным у Telegram. С
// `removeImage` — снимается (PER-715); заменить и снять одной правкой нельзя.
export type LotCardEdit = LotCardText &
  (
    | { image?: Uint8Array; removeImage?: never }
    | { image?: never; removeImage: true }
  );

export type LotAdministration = {
  createLotCard(
    person: Person,
    card: LotCardText,
    meta?: RpcMetadata,
  ): Promise<LotCardResult>;
  editLotCard(
    person: Person,
    card: LotCardEdit,
    meta?: RpcMetadata,
  ): Promise<LotCardResult>;
  // Фото в конец списка (PER-721). `photoId` рождает вызывающий: повтор с ним
  // Auction узнаёт и второго фото не заводит.
  addLotPhoto(
    person: Person,
    photo: { lotId: string; photoId: string; image: Uint8Array },
    meta?: RpcMetadata,
  ): Promise<LotPhotoResult>;
  // Снятое уже фото — тоже `ok`: снятие идемпотентно.
  removeLotPhoto(
    person: Person,
    photo: { lotId: string; photoId: string },
    meta?: RpcMetadata,
  ): Promise<LotPhotoResult>;
  addLot(
    person: Person,
    lot: { auctionId: string; lotId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<AddLotResult>;
  // Условия целиком: Auction заменяет прежние, поэтому цена и шаг идут парой.
  scheduleLot(
    person: Person,
    terms: {
      auctionId: string;
      lotId: string;
      opId: string;
      startingPrice: Money;
      stepPolicy: LotStepPolicyInput;
    },
    meta?: RpcMetadata,
  ): Promise<ScheduleLotResult>;
  getLot(
    person: Person,
    lotId: string,
    meta?: RpcMetadata,
  ): Promise<LotReadResult>;
  removeLot(
    person: Person,
    lot: { auctionId: string; lotId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<RemoveLotResult>;
  getLotImage(
    person: Person,
    lotId: string,
    meta?: RpcMetadata,
  ): Promise<LotImageResult>;
  // Одно фото галереи лота (PER-721): копии и правка сета берут его байты.
  getLotPhoto(
    person: Person,
    photo: { lotId: string; photoId: string },
    meta?: RpcMetadata,
  ): Promise<LotImageResult>;
};

// Пульт аукциона администратора (PER-320): чтение пульта, сроки недели и
// финал, открытие онлайн-торгов и отметка лотов для финала. Четвёртая роль
// бота хаба перед Auction, и тоже только его. Право решает Auction, спрашивая
// Meetups; именованный отказ — значение ответа, и бот его не повторяет.
// `auction-not-found` — `NOT_FOUND`: аукциона нет, кнопка устарела.
// `meetup-cancelled` — сходка отменена, и аукцион наследует это: команды
// администратора у неё закрыты, кроме удаления и отмены аукциона;
// `meetup-hidden` — сходка скрыта, и онлайн-торги не открываются (ADR-047,
// дополнение 2026-10-12). Чтение пульта их не получает.

export type ConsoleReadResult =
  | { kind: "ok"; console: AuctionConsoleSnapshot }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type LotStatistics = {
  lotId: string;
  bidCount: number;
  uniqueParticipantCount: number;
  priceGrowth?: Money;
};

export type LotStatisticsReadResult =
  | { kind: "ok"; lots: readonly LotStatistics[] }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Сводка дня торгов (PER-492): агрегаты лота за окно, которое называет бот.
// Лот без ставок в окне приходит с нулём и без цены, а не пропускается, —
// «ставок не было» бот читает по всему реестру, а не по отсутствию строк.
// Смены лидера и самая длинная дуэль — тоже окна (PER-511).
export type DayLotStatistics = {
  lotId: string;
  bidCount: number;
  maxPrice?: Money;
  growth?: Money;
  leaderChangeCount: number;
  longestDuel: number;
};

/** Окно сводки дня: аукцион и границы суток, которые называет бот (PER-492). */
export type DayWindow = {
  auctionId: string;
  /** RFC 3339 в UTC: первый миг окна. */
  from: string;
  /** RFC 3339 в UTC: первый миг после окна; строго позже `from`. */
  until: string;
};

export type DaySummaryReadResult =
  | { kind: "ok"; lots: readonly DayLotStatistics[] }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Из отказов конфигурации человек может вызвать «конец не позже начала» и
// отказы окон «Счастливых часов» (PER-504): окно вне недели, пересечение двух
// окон по общему лоту, шаг окна и окно без лотов, — а также момент закрытия
// регистрации в розыгрыше вне недели (PER-593). Остальные бот не собирает,
// и они — дефект. Окна названы номером в конфигурации с нуля.
export type ScheduleAuctionResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "closes-not-after-opens" }
  | { kind: "window-outside-week"; window: number }
  | { kind: "windows-overlap"; first: number; second: number }
  | { kind: "window-step-invalid"; window: number }
  | { kind: "window-lots-empty"; window: number }
  | { kind: "raffle-not-after-opens" }
  | { kind: "raffle-not-before-closes" }
  // Приз розыгрыша (PER-649): без розыгрыша приза нет, приз — непустая строка
  // не длиннее 200 знаков.
  | { kind: "raffle-prize-without-raffle" }
  | { kind: "raffle-prize-blank" }
  | { kind: "raffle-prize-too-long" }
  | { kind: "already-started" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// `another-auction-active` — торги идут у другого аукциона сообщества: слот
// торгов один (ADR-047, дополнение 2026-10-12).
export type StartPrebiddingResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "meetup-hidden" }
  | { kind: "not-scheduled" }
  | { kind: "another-auction-active"; auctionId: string }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type DiscardAuctionResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "already-started" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Отмена после старта торгов (ADR-047, дополнение 2026-10-12): до торгов
// Auction отвечает `not-started` — там действует удаление.
export type CancelAuctionResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "not-started" }
  | { kind: "already-finished" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Ориентировочное время финала (PER-663): выставить, изменить и снять одной
// командой. Момент без — снятие. Ответ не несёт времени, его показывает
// перечитанный снимок `final_at`.
export type FinalTimeResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "auction-not-found" }
  // Финал уже начался: время больше не меняется (ADR-040, дополнение
  // 2026-10-19).
  | { kind: "final-already-started" }
  | { kind: "auction-already-finished" }
  | { kind: "auction-already-cancelled" }
  | AuctionFailure;

// Публикация и снятие с публикации (ADR-047, дополнение 2026-10-20, PER-673):
// ответ видимости не несёт, её показывает перечитанный снимок `hidden`.
export type AuctionVisibilityResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "already-started" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Команды сета лотов (ADR-073, PER-509): создание и правка одной командой —
// Auction заменяет название и состав целиком, — и удаление. `lots-frozen` —
// онлайн-торги открыты, сеты заморожены вместе с реестром. Отказ лота называет
// первый такой лот запроса, а `lot-in-another-set` — ещё сет, где он лежит.
export type SaveLotSetResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lots-frozen" }
  | { kind: "name-empty" }
  | { kind: "lot-not-in-auction"; lotId: string }
  | { kind: "lot-in-another-set"; lotId: string; lotSetId: string }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type DeleteLotSetResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lots-frozen" }
  | { kind: "lot-set-not-found" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type FinalistRefusal =
  | "not-in-prebidding"
  | "lot-not-in-auction"
  | "lot-not-open"
  | "not-in-online-phase"
  | "already-marked"
  | "not-marked"
  | "deadline-passed"
  // Отбирать некуда: у аукциона нет финала или лоты не получают дедлайна.
  | "selection-not-applicable";

export type FinalistResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "refused"; reason: FinalistRefusal }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Сроки недели целиком: Auction заменяет конфигурацию, а не правит её, поэтому
// окна «Счастливых часов» и момент закрытия регистрации в розыгрыше едут в
// каждой команде — без них правка сроков или финала стёрла бы их молча.
// Ключ `raffleClosesAt` обязателен по той же причине; `undefined` — неделя без
// розыгрыша (ADR-066, п. 5). Так же обязателен `rafflePrize` (PER-649): приз
// лежит рядом с моментом розыгрыша, и команда без него стёрла бы приз молча.
// `lot_defaults` бот не шлёт — их подставляет Auction; правило закрытия
// выводится из финала.
export type AuctionWeekConfig = {
  auctionId: string;
  opId: string;
  opensAt: string;
  closesAt: string;
  final: boolean;
  windows: readonly StepWindow[];
  raffleClosesAt: string | undefined;
  rafflePrize: string | undefined;
};

// Запуск окна сниженного шага по ходу торгов (PER-615; ADR-047, дополнение
// 2026-10-12). `from` нет — окно начинается с момента, в который сервис решил
// команду. `window-in-past` — заданное начало раньше момента команды;
// `windows-overlap` несёт лот и границы окна, с которым пересеклось запущенное:
// номер окна у запуска нет, окно одно.
export type LaunchStepWindowResult =
  | { kind: "ok"; from: string; until: string }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "not-in-prebidding" }
  | { kind: "window-in-past" }
  | { kind: "window-outside-phase" }
  | { kind: "window-step-invalid" }
  | { kind: "window-lots-empty" }
  | { kind: "lot-not-in-auction"; lotId: string }
  | { kind: "lot-not-open"; lotId: string }
  | { kind: "windows-overlap"; lotId: string; from: string; until: string }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Запускаемое окно: та же форма, что элемент `step_windows` конфигурации.
export type LaunchStepWindowCommand = {
  auctionId: string;
  opId: string;
  from?: string;
  until: string;
  step: Money;
  lotIds: readonly string[];
};

export type FinalistMark = { auctionId: string; lotId: string; opId: string };

// Финал ведущего (PER-337; контракт — PER-475). Ведущий — администратор
// сходки, право решает Auction у Meetups. Ключ команды рождает край: повтор
// того же `opId` Auction отвечает исходным ответом, поэтому второе нажатие
// «Да, продать» не создаёт второй продажи.

// Объявление состава финала (PER-619). `lineup-mismatch` — порядок назвал не
// тот набор удержанных лотов, что знает Auction: состав изменился после чтения
// или чтение лотов отстаёт.
export type FreezeFinalLineupResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "not-in-break" }
  | { kind: "lineup-empty" }
  | { kind: "lineup-mismatch" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type StartFinalResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lineup-not-frozen" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type StartNextLotResult =
  | { kind: "ok"; lotId: string }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "not-in-final" }
  | { kind: "another-lot-active"; lotId: string }
  | { kind: "lineup-exhausted" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// `ask-below-current-price` несёт порог, который ask обязан превысить, как
// Auction его назвал в момент решения.
export type AdvanceAskResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lot-not-in-auction" }
  | { kind: "lot-not-open" }
  | { kind: "ask-below-current-price"; mustExceed: Money }
  | { kind: "currency-mismatch" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Закрытие лота: продажа лидеру либо закрытие без ставок.
export type LotClosure =
  | { kind: "sold"; winnerId: string; price: Money }
  | { kind: "unsold" };

export type CloseLotResult =
  | { kind: "ok"; closure: LotClosure }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "lot-not-in-auction" }
  | { kind: "lot-not-open" }
  | { kind: "deadline-not-reached" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type FinalLotCommand = {
  auctionId: string;
  lotId: string;
  opId: string;
};

export type DisplayNamesResult =
  | { kind: "ok"; names: Readonly<Record<string, string>> }
  | AuctionFailure;

// Последние ставки лота, новые первыми, и имена их авторов и лидера, как их
// ставит Auction (ADR-059). Имени нет — Auction его не назвал.
export type FinalBidsResult =
  | {
      kind: "ok";
      bids: readonly { amount: Money; participantId: string }[];
      names: Readonly<Record<string, string>>;
    }
  | AuctionFailure;

// Имена аукциона для «Ставок зала» (PER-565, ADR-070 п. 3): все, кто выбрал
// имя в этом аукционе и держит `place_bids`. Пустой список — ответ, а не отказ.
export type AuctionNamesResult =
  | {
      kind: "ok";
      names: readonly { participantId: string; name: string }[];
    }
  | AuctionFailure;

// Ставка зала (PER-565, ADR-070 п. 5): помощник ставит за человека зала
// объявленную цену. Отказ — значение ответа, и бот его не повторяет; ответа не
// было — сбой транспорта, и ставка могла пройти.
export type FloorBidResult =
  | { kind: "accepted"; lotVersion: number }
  | { kind: "bid-not-at-next-price"; expected: Money }
  | { kind: "bidder-is-leader" }
  | { kind: "lot-not-open" }
  | { kind: "display-name-not-chosen" }
  | { kind: "participant-cannot-bid" }
  | { kind: "removed-from-lot" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | AuctionFailure;

export type FloorBid = {
  lotId: string;
  participantId: string;
  amount: Money;
  opId: string;
};

// Снятие участника с лота администратором (ADR-072, PER-659). Участник — тот,
// у кого на лоте есть ставка: порядок — первой ставки в журнале, снятые
// остаются с пометкой. Имени нет — Auction его не назвал.
export type LotParticipant = {
  participantId: string;
  name?: string;
  removed: boolean;
};

export type LotParticipantsResult =
  | { kind: "ok"; participants: readonly LotParticipant[] }
  | AuctionFailure;

export type RemovalTarget = {
  auctionId: string;
  lotId: string;
  participantId: string;
};

// Лот после снятия, без записи: цена уже ограничена ценой до снятия
// (ADR-072, дополнение 2026-10-20), `version` — номер лота, на котором
// предпросмотр решён.
export type RemovalPreview = {
  price: Money;
  leaderId?: string;
  extendedDeadline?: string;
  version: number;
};

type RemovalAuthority =
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" };

export type RemovalPreviewResult =
  | { kind: "ok"; preview: RemovalPreview }
  | { kind: "refused"; reason: RemovalRefusal }
  | RemovalAuthority
  | AuctionFailure;

// `lot-changed` — лот ушёл от номера предпросмотра: снятия не было, и пульт
// показывает предпросмотр заново (ADR-072, дополнение 2026-10-21).
export type RemoveParticipantResult =
  | { kind: "ok"; lotVersion: number }
  | { kind: "lot-changed" }
  | { kind: "refused"; reason: RemovalRefusal }
  | RemovalAuthority
  | AuctionFailure;

// Счета аукциона (PER-321): право — то же, что у пульта, Auction спрашивает
// его у Meetups. `auction-not-found` у чтения — аукциона нет, кнопка устарела.
// `paymentInstructions` — текст «Как оплатить и получить» аукциона, как его
// читают победители; нет — администратор его ещё не задал.
export type InvoicesReadResult =
  | { kind: "ok"; invoices: readonly Invoice[]; paymentInstructions?: string }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Отметка уже отмеченного счёта — `ok`: второго перехода Auction не пишет.
// `invoice-not-found` — счёта нет, в том числе у тестового аукциона без
// сходки; `invoice-not-paid` — выдача раньше оплаты.
export type InvoiceMarkResult =
  | { kind: "ok" }
  | { kind: "invoice-not-paid" }
  | { kind: "invoice-not-found" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | AuctionFailure;

// Текст «Как оплатить и получить» (PER-322): задать, изменить и снять одной
// командой. Ворот по сходке нет — счета переживают отмену, — поэтому отказов
// только два.
export type PaymentInstructionsResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Розыгрыш аукциона для строки пульта (PER-618): `raffle` нет — у аукциона
// розыгрыша нет.
export type ConsoleRaffleResult =
  | { kind: "ok"; raffle?: RaffleView }
  | AuctionFailure;

// Аукционы сообщества от запланированного до финала (`ListAuctions` ACTIVE):
// по ним пульт узнаёт, у кого идут торги, до подтверждения открытия недели.
export type ActiveAuctionsResult =
  | { kind: "ok"; auctions: readonly AuctionSummaryView[] }
  | AuctionFailure;

export type AuctionConsoles = {
  getAuctionConsole(
    person: Person,
    auctionId: string,
    meta?: RpcMetadata,
  ): Promise<ConsoleReadResult>;
  getAuctionLotStatistics(
    person: Person,
    auctionId: string,
    meta?: RpcMetadata,
  ): Promise<LotStatisticsReadResult>;
  // Сводка дня (PER-492): окно называет бот — часового пояса сообщества
  // Auction не знает, и сутки считает край.
  getAuctionDaySummary(
    person: Person,
    day: DayWindow,
    meta?: RpcMetadata,
  ): Promise<DaySummaryReadResult>;
  scheduleAuction(
    person: Person,
    config: AuctionWeekConfig,
    meta?: RpcMetadata,
  ): Promise<ScheduleAuctionResult>;
  // Запуск окна сниженного шага по ходу торгов (PER-615): окно дописывается
  // к списку аукциона, а не заменяет конфигурацию.
  launchStepWindow(
    person: Person,
    launch: LaunchStepWindowCommand,
    meta?: RpcMetadata,
  ): Promise<LaunchStepWindowResult>;
  // Повтор того же `opId` Auction принимает; новый ключ на открытом
  // аукционе — `not-scheduled`.
  startPrebidding(
    person: Person,
    start: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<StartPrebiddingResult>;
  // Удаление до торгов: аукцион сходки пропадает, и «Включить аукцион»
  // рождает его заново пустым. Повтор того же `opId` Auction принимает.
  discardAuction(
    person: Person,
    discard: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<DiscardAuctionResult>;
  // Отмена после старта торгов: проданные лоты остаются проданными, остальные
  // снимаются, нового аукциона у сходки не будет. Повтор Auction принимает.
  cancelAuction(
    person: Person,
    cancel: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<CancelAuctionResult>;
  // Видимость до торгов (PER-673): аукцион рождается скрытым от участников.
  // Повтор того же `opId` Auction принимает; после открытия онлайн-торгов —
  // `already-started`.
  publishAuction(
    person: Person,
    publish: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<AuctionVisibilityResult>;
  hideAuction(
    person: Person,
    hide: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<AuctionVisibilityResult>;
  // Ориентировочное время финала (PER-663): подпись анонса трансляции, а не
  // условие торгов. Выставить, изменить и снять — одна команда; момент без —
  // снять. Повтор того же `opId` Auction принимает, а выставление и снятие под
  // одним `opId` — разные события, и второе он отвергает.
  setFinalTime(
    person: Person,
    command: { auctionId: string; opId: string; finalAt?: string },
    meta?: RpcMetadata,
  ): Promise<FinalTimeResult>;
  // Сет лотов (ADR-073, PER-509): тот же `lotSetId` заменяет название и
  // состав целиком, поэтому команда несёт весь состав. Повтор того же `opId`
  // Auction принимает.
  saveLotSet(
    person: Person,
    set: {
      auctionId: string;
      lotSetId: string;
      name: string;
      lotIds: readonly string[];
      opId: string;
    },
    meta?: RpcMetadata,
  ): Promise<SaveLotSetResult>;
  deleteLotSet(
    person: Person,
    set: { auctionId: string; lotSetId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<DeleteLotSetResult>;
  selectForFinal(
    person: Person,
    mark: FinalistMark,
    meta?: RpcMetadata,
  ): Promise<FinalistResult>;
  deselectForFinal(
    person: Person,
    mark: FinalistMark,
    meta?: RpcMetadata,
  ): Promise<FinalistResult>;
  // `lotIds` — удержанные лоты в порядке выхода. Auction сверяет набор, а
  // порядок берёт как есть.
  freezeFinalLineup(
    person: Person,
    freeze: { auctionId: string; opId: string; lotIds: readonly string[] },
    meta?: RpcMetadata,
  ): Promise<FreezeFinalLineupResult>;
  startFinal(
    person: Person,
    start: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<StartFinalResult>;
  startNextLot(
    person: Person,
    start: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<StartNextLotResult>;
  advanceAsk(
    person: Person,
    ask: FinalLotCommand & { newAsk: Money },
    meta?: RpcMetadata,
  ): Promise<AdvanceAskResult>;
  closeLot(
    person: Person,
    close: FinalLotCommand,
    meta?: RpcMetadata,
  ): Promise<CloseLotResult>;
  // Имена участников в аукционе, как их ставит Auction (ADR-059).
  displayNames(
    person: Person,
    read: { auctionId: string; participantIds: readonly string[] },
    meta?: RpcMetadata,
  ): Promise<DisplayNamesResult>;
  // Розыгрыш аукциона, как его видит администратор: после закрытия
  // регистрации пульт показывает его статус и итог (PER-618).
  consoleRaffle(
    person: Person,
    auctionId: string,
    meta?: RpcMetadata,
  ): Promise<ConsoleRaffleResult>;
  // Активные аукционы сообщества: слот торгов один (PER-603), и пульт
  // предупреждает об идущих торгах до подтверждения открытия (PER-618).
  activeAuctions(
    person: Person,
    meta?: RpcMetadata,
  ): Promise<ActiveAuctionsResult>;
  // `limit` последних ставок лота и имена их авторов и `extraIds` — лидера.
  recentBids(
    person: Person,
    read: {
      auctionId: string;
      lotId: string;
      limit: number;
      extraIds: readonly string[];
    },
    meta?: RpcMetadata,
  ): Promise<FinalBidsResult>;
  // «Ставки зала» помощника (PER-565, ADR-070): имена аукциона и ставка
  // `source = FLOOR` за человека зала.
  listAuctionNames(
    person: Person,
    auctionId: string,
    meta?: RpcMetadata,
  ): Promise<AuctionNamesResult>;
  placeFloorBid(
    person: Person,
    bid: FloorBid,
    meta?: RpcMetadata,
  ): Promise<FloorBidResult>;
  // Лот по снимку: «Ставки зала» сверяют лот и цену кнопки с ним, а после
  // принятой ставки дочитывают его до версии из ответа (PER-470).
  floorLot(
    person: Person,
    read: { lotId: string; atLeastVersion?: number },
    meta?: RpcMetadata,
  ): Promise<LotReadResult>;
  // Снятие участника с лота (ADR-072, PER-659): участники по хронологии лота
  // с именами, предпросмотр без записи и снятие на номере предпросмотра.
  lotParticipants(
    person: Person,
    read: { auctionId: string; lotId: string },
    meta?: RpcMetadata,
  ): Promise<LotParticipantsResult>;
  previewParticipantRemoval(
    person: Person,
    target: RemovalTarget,
    meta?: RpcMetadata,
  ): Promise<RemovalPreviewResult>;
  removeParticipant(
    person: Person,
    removal: RemovalTarget & { expectedVersion: number; opId: string },
    meta?: RpcMetadata,
  ): Promise<RemoveParticipantResult>;
  // Счета проданных лотов (PER-321): сводка организатора и отметки оплаты и
  // выдачи. Ключ отметки рождает край на нажатие «Да».
  listAuctionInvoices(
    person: Person,
    auctionId: string,
    meta?: RpcMetadata,
  ): Promise<InvoicesReadResult>;
  markInvoice(
    person: Person,
    mark: { invoiceId: string; mark: InvoiceMark; opId: string },
    meta?: RpcMetadata,
  ): Promise<InvoiceMarkResult>;
  // Текст «Как оплатить и получить» (PER-322): свободный текст победителям
  // всего аукциона. Текст без — снять. Повтор того же `opId` Auction принимает.
  setPaymentInstructions(
    person: Person,
    command: { auctionId: string; opId: string; text?: string },
    meta?: RpcMetadata,
  ): Promise<PaymentInstructionsResult>;
};

// Порты пакета метаданных вызова не несут, поэтому собираются на каждый
// update: `request_id` и бюджет действия уезжают в каждый вызов цепочки.
export type AuctionScreenPorts = {
  auction: AuctionPort;
  image: LotImagePort;
  operations: OperationIdPort;
};

export type AuctionScreens = {
  screenPorts(meta?: RpcMetadata): AuctionScreenPorts;
  // Идущий аукцион — ближайший активный (PER-595): в нём человек выбирает имя
  // из «Настроек», а по его стадии меню показывает событие (PER-669). Торги
  // открыты у одного аукциона (RFC-017); нет активного — `auctionId` нет.
  currentAuction(
    person: Person,
    meta?: RpcMetadata,
  ): Promise<MeetupAuctionResult>;
};

// Смотрящий пакета — права, которые Identity вывел этому человеку (RFC-016):
// Auction решает по правам.
export function viewerOf(person: Person): Viewer {
  return { identityId: person.identityId, rights: person.rights };
}
