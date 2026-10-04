import type {
  AuctionPort,
  GlobalRole,
  LotImagePort,
  Viewer,
} from "@solguficky/auction-bot-ui";
import type { Person } from "../application/types.js";
import type { RpcMetadata } from "../rpc-metadata.js";

// Аукцион у сходки (ADR-047, дополнение 2026-10-03; PER-307). Бот хаба зовёт
// Auction в двух ролях. Оболочка сходки — эти два метода: аукцион сходки на
// карточке и его включение. Торговые экраны — порты общего пакета ниже: их
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

// Порты пакета метаданных вызова не несут, поэтому собираются на каждый
// update: `request_id` и бюджет действия уезжают в каждый вызов цепочки.
export type AuctionScreenPorts = {
  auction: AuctionPort;
  image: LotImagePort;
};

export type AuctionScreens = {
  screenPorts(meta?: RpcMetadata): AuctionScreenPorts;
};

const globalRoles: readonly GlobalRole[] = [
  "admin",
  "maintainer",
  "member",
  "public",
];

// Смотрящий пакета: роли Identity, которых словарь пакета не знает, не
// передаются — Auction их тоже не знает и решает по известным.
export function viewerOf(person: Person): Viewer {
  return {
    identityId: person.identityId,
    globalRoles: globalRoles.filter((role) =>
      person.globalRoles.includes(role),
    ),
  };
}
