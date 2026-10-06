import type { MeetupAuctions } from "../auction/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import { inMemberCircle } from "./hub-access.js";
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
// расширение сходки: карточка показывает его вход, администратор включает его
// с карточки. Решения о праве здесь нет — его принимает Auction, спрашивая
// Meetups; край лишь не зовёт Auction за человека вне круга `member`.
export function createMeetupAuction(auctions: MeetupAuctions) {
  // Аукцион сходки на карточке. Отказ Auction карточку не роняет: сходка
  // читается из Meetups и остаётся верной, а ряда аукциона в кадре нет.
  async function withAuction<T extends WithMeetup>(
    card: T,
    request: { identity: Person; requestId?: string; deadlineAt?: number },
  ): Promise<T> {
    if (!inMemberCircle(request.identity.globalRoles)) return card;
    const result = await auctions.getMeetupAuction(
      request.identity,
      card.meetup.id,
      rpcMeta(request),
    );
    if (result.kind !== "ok") return card;
    return {
      ...card,
      auction:
        result.auctionId === undefined
          ? { kind: "none" }
          : { kind: "open", auctionId: result.auctionId },
    };
  }

  async function enable(
    request: Extract<ExecuteRequest, { intent: "enable-auction" }>,
    viewCard: () => Promise<ExecuteResult>,
  ): Promise<ExecuteResult> {
    if (!inMemberCircle(request.identity.globalRoles)) {
      return { kind: "dependency-rejected", reason: "forbidden" };
    }
    const enabled = await auctions.enableAuction(
      request.identity,
      request.meetupId,
      request.opId,
      rpcMeta(request),
    );
    switch (enabled.kind) {
      case "enabled": {
        // Карточка перечитывается тем же путём, что и при просмотре: аукцион
        // включают с неё, и после команды человек видит её же, уже со входом.
        // Аукцион берётся из ответа команды — чтение read model Auction могло
        // бы его ещё не увидеть.
        const current = await viewCard();
        // Аукцион уже родился: отказ перечитать карточку — не отказ команды.
        // Человек узнаёт, что аукцион включён, и открывает карточку сам.
        if (current.kind !== "meetup-card") {
          return {
            kind: "auction-enabled",
            alreadyExisted: enabled.alreadyExisted,
            meetupId: request.meetupId,
            auctionId: enabled.auctionId,
          };
        }
        return {
          kind: "auction-enabled",
          alreadyExisted: enabled.alreadyExisted,
          meetupId: request.meetupId,
          auctionId: enabled.auctionId,
          card: {
            ...current,
            auction: { kind: "open", auctionId: enabled.auctionId },
          },
        };
      }
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
