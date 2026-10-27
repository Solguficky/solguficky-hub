import type { AuctionSnapshot } from "../../../gen/auction/v1/auction_service_pb.js";
import type { AuctionWeekFacts } from "../../auction-programme.js";
import { auctionSummaryViewOf } from "../../core/auction/auction.js";
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
  const opensAt = instantOf(
    snapshot.config?.onlinePhase?.opensAt,
    "auction online phase start is not an instant",
  );
  // Отсчёт до финала идёт от общего дедлайна лотов, и только у аукциона с
  // финалом (PER-518): `final_blocks = 0` — настоящее «финала нет», а конец
  // фазы без `closes_lots` дедлайном лотов не становится.
  const config = snapshot.config;
  const closesAt =
    config !== undefined &&
    config.finalBlocks > 0 &&
    config.onlinePhase?.closesLots === true
      ? instantOf(
          config.onlinePhase.closesAt,
          "auction online phase end is not an instant",
        )
      : undefined;
  return {
    auctionId: snapshot.id,
    stage: stageOf(snapshot.status),
    ...(opensAt === undefined ? {} : { opensAt }),
    ...(closesAt === undefined ? {} : { closesAt }),
    lotCount: snapshot.lotIds.length,
    ...withWeek(snapshot),
  };
}

// Строка состояния (PER-767) берёт сводку общим переводом, тем же, что у
// корня аукциона и меню хаба. Его отказ — дефект соседа в поле, которого
// список сам не показывает: пропадает строка, а не список.
function withWeek(snapshot: AuctionSnapshot): { week?: AuctionWeekFacts } {
  try {
    const { stage, opensAt, closesAt, stepWindows, raffleClosesAt } =
      auctionSummaryViewOf(snapshot);
    return {
      week: {
        stage,
        ...(opensAt === undefined ? {} : { opensAt }),
        ...(closesAt === undefined ? {} : { closesAt }),
        ...(stepWindows === undefined ? {} : { stepWindows }),
        ...(raffleClosesAt === undefined ? {} : { raffleClosesAt }),
      },
    };
  } catch {
    return {};
  }
}

// Момент онлайн-фазы — RFC 3339 в UTC, как обещает `auction.v1.OnlinePhase`:
// «2026-10-21T21:00:00Z» или с долями секунды. `Date.parse` берёт и
// «2026-10-21», и «Oct 21, 2026», а выдуманное время в тексте читалось бы как
// срок (PER-688).
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

// Дни начала и финала строка показывает, а по началу ещё и сортирует: битая
// дата уронила бы отрисовку уже после маршрута, и человек остался бы без
// ответа.
function instantOf(
  value: string | undefined,
  refusal: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(refusal);
  }
  return value;
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
    // Отменённый аукцион (ADR-047, дополнение 2026-10-12) — конечная стадия,
    // как завершённый, и статус отличает одно от другого (PER-606).
    case "cancelled":
      return "cancelled";
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
