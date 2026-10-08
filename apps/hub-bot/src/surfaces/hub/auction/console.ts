import type {
  AuctionConsole,
  AuctionSnapshot,
  ConsoleLot as WireConsoleLot,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import type {
  AuctionConsoleView,
  AuctionWeek,
  ConsoleAuctionStatus,
  ConsoleLot,
} from "../application/types.js";
import { lotViewOf } from "./snapshot.js";

// Перевод `auction.v1.AuctionConsole` в пульт хаба (PER-320). Как и перевод
// лота, он держит то, чего схема не выражает: статус и лот выставлены всегда,
// число ставок помещается в безопасное целое. Нарушение — дефект соседа:
// перевод бросает, и человек видит «недоступно», а не пульт с выдумкой.
export function consoleOf(console: AuctionConsole): AuctionConsoleView {
  const auction = console.auction;
  if (auction === undefined) throw new Error("auction console without auction");
  const week = weekOf(auction);
  return {
    auctionId: auction.id,
    status: statusOf(auction.status),
    ...(week === undefined ? {} : { week }),
    lots: console.lots.map(consoleLotOf),
  };
}

function weekOf(auction: AuctionSnapshot): AuctionWeek | undefined {
  const config = auction.config;
  if (config === undefined) return undefined;
  const phase = config.onlinePhase;
  return {
    // Пустая строка — поле не выставлено: у онлайн-фазы начало обязательно,
    // а без фазы мгновений нет вовсе.
    ...(phase === undefined || phase.opensAt === ""
      ? {}
      : { opensAt: phase.opensAt }),
    ...(phase?.closesAt === undefined ? {} : { closesAt: phase.closesAt }),
    final: config.finalBlocks > 0,
  };
}

function statusOf(status: AuctionSnapshot["status"]): ConsoleAuctionStatus {
  switch (status.case) {
    case "draft":
      return "draft";
    case "scheduled":
      return "scheduled";
    case "prebidding":
      return "prebidding";
    case "settling":
      return "settling";
    case "onBreak":
      return "break";
    case "lineupFrozen":
      return "lineup-frozen";
    case "inFinal":
      return "final";
    case "finished":
      return "finished";
    case undefined:
      throw new Error("auction snapshot without status");
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function consoleLotOf(entry: WireConsoleLot): ConsoleLot {
  if (entry.lot === undefined) throw new Error("console lot without lot");
  const bidCount = Number(entry.lot.bidCount);
  if (!Number.isSafeInteger(bidCount) || bidCount < 0) {
    throw new Error("console lot bid count out of range");
  }
  return {
    lot: lotViewOf(entry.lot),
    bidCount,
    markedForFinal: entry.markedForFinal,
    overdue: entry.overdue,
  };
}
