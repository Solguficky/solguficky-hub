import type { RpcMetadata } from "../../../core/rpc-metadata.js";
import type { Person } from "../application/types.js";
import type { AuctionScreens } from "../auction/port.js";
import { type HubEvent, isAuctionEvent } from "./screens/events.js";

export type CurrentEvents =
  | { kind: "ok"; events: HubEvent[] }
  | { kind: "unavailable" };

/**
 * Идущие события расширений (PER-669): сегодня — аукцион сообщества от
 * публикации до конца финала. Торги открыты не больше чем у одного аукциона
 * (PER-603), поэтому событие аукциона — одно. Одно чтение у раздела «События»,
 * меню и шёпота `/events` в чате сообщества (PER-884): отбор, который
 * разошёлся бы между личкой и чатом, живёт только здесь. Скрытый аукцион
 * событием не бывает ни у кого — и в шёпот не идёт (ADR-078, п. 4).
 * Бот без Auction событий не знает: список пуст, а не отказ.
 */
export async function readCurrentEvents(
  auction: AuctionScreens | undefined,
  person: Person,
  meta: RpcMetadata,
): Promise<CurrentEvents> {
  if (auction === undefined) return { kind: "ok", events: [] };
  const current = await auction.currentAuction(person, meta);
  if (current.kind !== "ok") return { kind: "unavailable" };
  const { auctionId, auction: summary } = current;
  return auctionId === undefined ||
    summary === undefined ||
    !isAuctionEvent(summary)
    ? { kind: "ok", events: [] }
    : {
        kind: "ok",
        events: [{ kind: "auction", auctionId, auction: summary }],
      };
}
