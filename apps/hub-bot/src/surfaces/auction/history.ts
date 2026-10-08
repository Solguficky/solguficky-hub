import { BidSource } from "../../../gen/auction/v1/auction_pb.js";
import type {
  HistoryBid,
  ListLotHistoryResponse,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  BidOriginView,
  LotHistoryEntryView,
  LotHistoryPage,
} from "../../auction-ui/index.js";
import { moneyOf } from "./snapshot.js";

// Перевод страницы `auction.v1.ListLotHistory` в срез общего пакета. Запись
// вида, которого этот бот не знает, пропускается: контракт разрешает Auction
// добавлять виды записей, и старый бот обязан показать остальную хронологию.
// Ставка без суммы, способа или с неизвестным каналом — дефект соседа: перевод
// бросает, как и перевод снимка лота.
export function historyPageOf(page: ListLotHistoryResponse): LotHistoryPage {
  return {
    entries: page.entries.flatMap((entry): LotHistoryEntryView[] => {
      switch (entry.kind.case) {
        case "bid":
          return [bidOf(entry.sequence, entry.occurredAt, entry.kind.value)];
        case undefined:
          return [];
        default: {
          const _exhaustive: never = entry.kind;
          return _exhaustive;
        }
      }
    }),
    nextPageToken: page.nextPageToken,
  };
}

function bidOf(
  sequence: bigint,
  occurredAt: string,
  bid: HistoryBid,
): LotHistoryEntryView {
  if (bid.amount === undefined) throw new Error("history bid without amount");
  return {
    kind: "bid",
    sequence: Number(sequence),
    occurredAt,
    bidId: bid.bidId,
    participantId: bid.participantId,
    amount: moneyOf(bid.amount),
    origin: originOf(bid.origin),
  };
}

function originOf(origin: HistoryBid["origin"]): BidOriginView {
  switch (origin.case) {
    case "manual":
      return { kind: "manual", source: sourceOf(origin.value.source) };
    case "proxy":
      return { kind: "proxy" };
    case undefined:
      throw new Error("history bid without origin");
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

function sourceOf(source: BidSource): "bot" | "floor" {
  switch (source) {
    case BidSource.BOT:
      return "bot";
    case BidSource.FLOOR:
      return "floor";
    default:
      throw new Error(`history bid with bid source ${source}`);
  }
}
