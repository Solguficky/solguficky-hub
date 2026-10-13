import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { MeetupAuctions } from "../auction/port.js";
import { admittedToHub } from "./hub-access.js";
import type {
  ExecuteRequest,
  ExecuteResult,
  MeetupAuctionView,
  Person,
} from "./types.js";

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
    return {
      ...card,
      auction:
        result.auction === undefined
          ? { kind: "none" }
          : {
              kind: "open",
              auctionId: result.auction.auctionId,
              auction: result.auction,
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

  return { withAuction, enable };
}
