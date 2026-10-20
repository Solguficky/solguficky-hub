import type { AuctionStageView } from "../../../auction-ui/index.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { MeetupAuctions } from "../auction/port.js";
import { admittedToHub } from "./hub-access.js";
import type {
  AuctionCancelConsequence,
  ExecuteRequest,
  ExecuteResult,
  MeetupAuctionView,
  Person,
} from "./types.js";

// Торги идут от открытия онлайн-недели до конца финала: такой аукцион отмена
// сходки отменяет (ADR-047, дополнение 2026-10-12). До торгов он удаляется, и
// продаж там нет, — подтверждение тогда прежнее.
const tradingStages: ReadonlySet<AuctionStageView> = new Set([
  "prebidding",
  "settling",
  "on-break",
  "lineup-frozen",
  "in-final",
]);

// Результат со сходкой, к которому дописывается аукцион: карточка и результаты
// формы, которые бот показывает карточкой.
type WithMeetup = { meetup: { id: string }; auction?: MeetupAuctionView };

// Аукцион у сходки (PER-307; ADR-047, дополнение 2026-10-03). Аукцион —
// расширение сходки: меню «Расширения» сходки показывает его вход, и там же
// администратор его включает (PER-605). Решения о праве здесь нет — его
// принимает Auction, спрашивая Meetups; край лишь не зовёт Auction за
// человека без права хаба.
export function createMeetupAuction(auctions: MeetupAuctions) {
  // Аукцион сходки в её меню. Отказ Auction меню не роняет: сходка читается
  // из Meetups и остаётся верной, а аукцион помечен недоступным.
  async function withAuction<T extends WithMeetup>(
    card: T,
    request: { identity: Person; requestId?: string; deadlineAt?: number },
  ): Promise<T> {
    if (!admittedToHub(request.identity)) return card;
    const result = await auctions.getMeetupAuction(
      request.identity,
      card.meetup.id,
      rpcMeta(request),
    );
    if (result.kind !== "ok")
      return { ...card, auction: { kind: "unavailable" } };
    const auctionId = result.auctionId ?? result.auction?.auctionId;
    return {
      ...card,
      auction:
        auctionId === undefined
          ? { kind: "none" }
          : {
              kind: "open",
              auctionId,
              ...(result.auction === undefined
                ? {}
                : { auction: result.auction }),
            },
    };
  }

  async function enable(
    request: Extract<ExecuteRequest, { intent: "enable-auction" }>,
  ): Promise<ExecuteResult> {
    if (!admittedToHub(request.identity)) {
      return { kind: "dependency-rejected", reason: "forbidden" };
    }
    const enabled = await auctions.enableAuction(
      request.identity,
      request.meetupId,
      request.opId,
      rpcMeta(request),
    );
    switch (enabled.kind) {
      // Аукцион берётся из ответа команды: чтение read model Auction могло бы
      // его ещё не увидеть.
      case "enabled":
        return {
          kind: "auction-enabled",
          alreadyExisted: enabled.alreadyExisted,
          meetupId: request.meetupId,
          auctionId: enabled.auctionId,
        };
      case "not-administrator":
        return { kind: "auction-refused", reason: "not-administrator" };
      case "meetup-cancelled":
        return { kind: "auction-refused", reason: "meetup-cancelled" };
      case "meetup-not-found":
        return { kind: "meetup-not-found" };
      case "invalid":
        return {
          kind: "dependency-rejected",
          reason: "invalid",
          cause: enabled.cause,
        };
      case "forbidden":
      case "timeout":
      case "unavailable":
        return { kind: "dependency-rejected", reason: enabled.kind };
      default: {
        const _exhaustive: never = enabled;
        return _exhaustive;
      }
    }
  }

  // Последствие отмены сходки для её аукциона (ADR-064, дополнение
  // 2026-10-12): идущие торги отмена сходки обрывает, проданное остаётся. Сама
  // отмена идёт в Meetups и Auction не ждёт, поэтому сбой чтения не закрывает
  // её, а даёт условное последствие.
  async function cancelConsequence(
    auction: MeetupAuctionView | undefined,
    request: { identity: Person; requestId?: string; deadlineAt?: number },
  ): Promise<AuctionCancelConsequence | undefined> {
    if (auction === undefined || auction.kind === "none") return undefined;
    if (auction.kind === "unavailable" || auction.auction === undefined) {
      return { kind: "unknown" };
    }
    if (!tradingStages.has(auction.auction.stage)) return undefined;
    const sold = await auctions.soldLots(
      request.identity,
      auction.auctionId,
      rpcMeta(request),
    );
    return sold.kind === "ok"
      ? { kind: "trading", sold: sold.sold }
      : { kind: "unknown" };
  }

  return { withAuction, enable, cancelConsequence };
}
