import type {
  AuctionPort,
  LotImagePort,
  LotView,
  Money,
  OperationIdPort,
  Viewer,
} from "../../../auction-ui/index.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import type { AuctionConsoleSnapshot, Person } from "../application/types.js";

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
export type MeetupAuctionResult =
  | { kind: "ok"; auctionId?: string }
  | AuctionFailure;

// Повторное включение не отказ: Auction отвечает существующим аукционом и
// `alreadyExisted`. Отказы — значения ответа, их бот не повторяет.
export type EnableAuctionResult =
  | { kind: "enabled"; auctionId: string; alreadyExisted: boolean }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | AuctionFailure;

export type MeetupAuctions = {
  getMeetupAuction(
    person: Person,
    meetupId: string,
    meta?: RpcMetadata,
  ): Promise<MeetupAuctionResult>;
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
  | { kind: "image-too-large"; maxBytes: number }
  | { kind: "unsupported-image" }
  | AuctionFailure;

export type AddLotResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "lots-frozen" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// `lots-frozen` — аукцион в торгах, `scheduling-closed` — лот уже открыт: для
// человека это один ответ, но называет их Auction раздельно.
export type ScheduleLotResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
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

export type LotCardText = { lotId: string; title: string; description: string };

// Правка карточки. Без `image` изображение остаётся как есть: `image_change` не
// выставляется. С ним — заменяется файлом, скачанным у Telegram.
export type LotCardEdit = LotCardText & { image?: Uint8Array };

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
      step: Money;
    },
    meta?: RpcMetadata,
  ): Promise<ScheduleLotResult>;
  getLot(
    person: Person,
    lotId: string,
    meta?: RpcMetadata,
  ): Promise<LotReadResult>;
};

// Пульт аукциона администратора (PER-320): чтение пульта, сроки недели и
// финал, открытие онлайн-торгов и отметка лотов для финала. Четвёртая роль
// бота хаба перед Auction, и тоже только его. Право решает Auction, спрашивая
// Meetups; именованный отказ — значение ответа, и бот его не повторяет.
// `auction-not-found` — `NOT_FOUND`: аукциона нет, кнопка устарела.

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

// Из отказов конфигурации человек может вызвать только «конец не позже
// начала»: остальные бот не собирает, и они — дефект.
export type ScheduleAuctionResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "closes-not-after-opens" }
  | { kind: "already-started" }
  | { kind: "auction-not-found" }
  | AuctionFailure;

export type StartPrebiddingResult =
  | { kind: "ok" }
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "not-scheduled" }
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
  | { kind: "refused"; reason: FinalistRefusal }
  | { kind: "auction-not-found" }
  | AuctionFailure;

// Сроки недели целиком: Auction заменяет конфигурацию, а не правит её.
// `lot_defaults` бот не шлёт — их подставляет Auction; правило закрытия
// выводится из финала.
export type AuctionWeekConfig = {
  auctionId: string;
  opId: string;
  opensAt: string;
  closesAt: string;
  final: boolean;
};

export type FinalistMark = { auctionId: string; lotId: string; opId: string };

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
  scheduleAuction(
    person: Person,
    config: AuctionWeekConfig,
    meta?: RpcMetadata,
  ): Promise<ScheduleAuctionResult>;
  // Повтор того же `opId` Auction принимает; новый ключ на открытом
  // аукционе — `not-scheduled`.
  startPrebidding(
    person: Person,
    start: { auctionId: string; opId: string },
    meta?: RpcMetadata,
  ): Promise<StartPrebiddingResult>;
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
};

// Смотрящий пакета — права, которые Identity вывел этому человеку (ADR-064,
// пункт 6): роли в Auction не едут, он решает по правам.
export function viewerOf(person: Person): Viewer {
  return { identityId: person.identityId, rights: person.rights };
}
