import type { AuctionSnapshot } from "../../../gen/auction/v1/auction_service_pb.js";
import type { AuctionStage, AuctionSummary } from "./auctions.js";

// Перевод снимка лота — общий у поверхностей (`src/core/auction/snapshot.ts`);
// строка списка аукционов — только у этой поверхности: списки — её оболочка.
// Перевод `auction.v1.AuctionSnapshot` в строку списка. Черновик в списки не
// входит (ADR-047), и черновик или снимок без статуса — дефект соседа: перевод
// бросает, и человек видит «недоступно», а не список с выдуманным этапом.
// Идентификатор проверяется здесь же: из него оболочка собирает кнопку ленты,
// и неканоническая строка уронила бы отрисовку, а не чтение.
export function auctionSummaryOf(snapshot: AuctionSnapshot): AuctionSummary {
  if (!CANONICAL_UUID.test(snapshot.id)) {
    throw new Error("auction id is not a canonical UUID");
  }
  const opensAt = snapshot.config?.onlinePhase?.opensAt;
  // День начала строка показывает и по нему сортирует: битая дата уронила бы
  // отрисовку уже после маршрута, и человек остался бы без ответа.
  if (
    opensAt !== undefined &&
    opensAt !== "" &&
    Number.isNaN(Date.parse(opensAt))
  ) {
    throw new Error("auction online phase start is not an instant");
  }
  return {
    auctionId: snapshot.id,
    stage: stageOf(snapshot.status),
    ...(opensAt === undefined || opensAt === "" ? {} : { opensAt }),
    lotCount: snapshot.lotIds.length,
  };
}

function stageOf(status: AuctionSnapshot["status"]): AuctionStage {
  switch (status.case) {
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
    case "draft":
      throw new Error("auction list returned a draft");
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
