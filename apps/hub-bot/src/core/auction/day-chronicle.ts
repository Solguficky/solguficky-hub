import type { GetAuctionDayChronicleResponse } from "../../../gen/auction/v1/auction_service_pb.js";
import type { DayChronicleView } from "../../auction-ui/index.js";
import { moneyOf } from "./snapshot.js";

// Хроники дня (PER-725): перевод `GetAuctionDayChronicleResponse` в словарь
// дерева, один у обоих ботов. Окно ответа экрану не нужно — сутки назвал
// Auction, — и в срез не попадает. Лот без агрегатов окна — нарушение
// контракта, а не лот без ставок.
export function dayChronicleOf(
  response: GetAuctionDayChronicleResponse,
): DayChronicleView {
  return {
    lots: response.lots.map((lot) => {
      const { day } = lot;
      if (day === undefined) {
        throw new Error("day chronicle lot without window aggregates");
      }
      return {
        lotId: day.lotId,
        bidCount: countOf(day.bidCount, "day chronicle bid count"),
        leaderChanges: countOf(
          day.leaderChangeCount,
          "day chronicle leader change count",
        ),
        longestDuel: countOf(day.longestDuel, "day chronicle longest duel"),
        totalBidCount: countOf(lot.bidCount, "day chronicle total bid count"),
        ...(lot.priceGrowth === undefined
          ? {}
          : { priceGrowth: moneyOf(lot.priceGrowth) }),
      };
    }),
  };
}

function countOf(value: bigint, field: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${field} out of range`);
  }
  return count;
}
