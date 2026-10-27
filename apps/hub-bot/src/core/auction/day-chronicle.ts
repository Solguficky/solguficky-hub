import type {
  GetAuctionChronicleResponse,
  GetAuctionDayChronicleResponse,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  AuctionChronicleView,
  DayChronicleView,
} from "../../auction-ui/index.js";
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

// Статистика аукциона (PER-770): перевод `GetAuctionChronicleResponse` тем же
// словарём. Момент ответа экрану не нужен — окно «всё время торгов», — а рекорд
// роста без суммы — нарушение контракта: Auction ставит его только росту.
export function auctionChronicleOf(
  response: GetAuctionChronicleResponse,
): AuctionChronicleView {
  const record = response.growthRecord;
  if (record !== undefined && record.growth === undefined) {
    throw new Error("auction chronicle growth record without growth");
  }
  return {
    bidCount: countOf(response.bidCount, "auction chronicle bid count"),
    participantCount: countOf(
      response.participantCount,
      "auction chronicle participant count",
    ),
    tradedLotCount: countOf(
      response.tradedLotCount,
      "auction chronicle traded lot count",
    ),
    ...(record?.growth === undefined
      ? {}
      : {
          growthRecord: {
            lotId: record.lotId,
            growth: moneyOf(record.growth),
          },
        }),
    lots: response.lots.map((lot) => ({
      lotId: lot.lotId,
      bidCount: countOf(lot.bidCount, "auction chronicle lot bid count"),
      leaderChanges: countOf(
        lot.leaderChangeCount,
        "auction chronicle leader change count",
      ),
      longestDuel: countOf(lot.longestDuel, "auction chronicle longest duel"),
    })),
  };
}

function countOf(value: bigint, field: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${field} out of range`);
  }
  return count;
}
