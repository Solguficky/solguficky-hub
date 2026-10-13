import type { AuctionSnapshot } from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  AuctionStageView,
  AuctionSummaryView,
} from "../../auction-ui/index.js";

// Снимок аукциона для его корня (PER-605) в словаре пакета. Перевод общий у
// обеих поверхностей. Снимок без статуса, неканонический идентификатор и
// момент, который не разбирается, — дефект соседа: перевод бросает, и человек
// видит «недоступно», а не корень с выдуманной стадией.
export function auctionSummaryViewOf(
  snapshot: AuctionSnapshot,
): AuctionSummaryView {
  if (!CANONICAL_UUID.test(snapshot.id)) {
    throw new Error("auction id is not a canonical UUID");
  }
  const phase = snapshot.config?.onlinePhase;
  const opensAt = instantOf(phase?.opensAt, "online phase start");
  const closesAt = instantOf(phase?.closesAt, "online phase end");
  return {
    auctionId: snapshot.id,
    stage: stageOf(snapshot.status),
    ...(opensAt === undefined ? {} : { opensAt }),
    ...(closesAt === undefined ? {} : { closesAt }),
    final: (snapshot.config?.finalBlocks ?? 0) > 0,
  };
}

function instantOf(
  value: string | undefined,
  what: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`auction ${what} is not an instant`);
  }
  return value;
}

function stageOf(status: AuctionSnapshot["status"]): AuctionStageView {
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
      return "on-break";
    case "lineupFrozen":
      return "lineup-frozen";
    case "inFinal":
      return "in-final";
    case "finished":
      return "finished";
    // Отменённый аукцион (ADR-047, дополнение 2026-10-12) экраны ещё не
    // показывают — это PER-606; до него бот не отменяет аукцион сам, и
    // перевод бросает, как на любом статусе, которого бот не знает.
    case "cancelled":
      throw new Error("auction snapshot is cancelled, not shown yet");
    case undefined:
      throw new Error("auction snapshot without status");
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
