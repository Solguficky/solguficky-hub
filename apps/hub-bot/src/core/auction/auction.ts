import type { AuctionSnapshot } from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  AuctionStageView,
  AuctionSummaryView,
  FinalLineupView,
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
    ...withLineup(snapshot.status),
    ...(snapshot.hidden ? { hidden: true as const } : {}),
  };
}

// Состав в сводке — подсказка ленте (PER-639), а сводку читают ещё список
// аукционов и корень. Кривой состав их не роняет: сводка остаётся без него, и
// лента показывает себя как вне финала. Строгим перевод остаётся у пульта.
function withLineup(status: AuctionSnapshot["status"]) {
  let lineup: FinalLineupView | undefined;
  try {
    lineup = finalLineupOf(status);
  } catch {
    lineup = undefined;
  }
  return lineup === undefined ? {} : { lineup };
}

/**
 * Состав финала из статуса снимка: есть у замороженного состава и у идущего
 * финала, и он никогда не пуст. Пустая строка активного лота — поле выставлено
 * пустым, а «между лотами» контракт выражает отсутствием поля.
 */
export function finalLineupOf(
  status: AuctionSnapshot["status"],
): FinalLineupView | undefined {
  if (status.case !== "lineupFrozen" && status.case !== "inFinal") {
    return undefined;
  }
  if (status.value.order.length === 0) {
    throw new Error("final lineup is empty");
  }
  const order = [...status.value.order];
  if (status.case === "lineupFrozen") return { order };
  const active = status.value.activeLotId;
  if (active === "") throw new Error("final active lot is empty");
  return active === undefined ? { order } : { order, activeLotId: active };
}

// Момент онлайн-фазы — RFC 3339 в UTC, как обещает `auction.v1.OnlinePhase`:
// «2026-10-21T21:00:00Z» или с долями секунды. `Date.parse` берёт и
// «2026-10-21», и «Oct 21, 2026», а выдуманное время в тексте читалось бы как
// срок (PER-688).
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

function instantOf(
  value: string | undefined,
  what: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
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
    // Отменённый аукцион (ADR-047, дополнение 2026-10-12) — конечная стадия,
    // как завершённый, и статус отличает одно от другого (PER-606).
    case "cancelled":
      return "cancelled";
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
