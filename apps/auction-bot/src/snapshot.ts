import type {
  LotStatusView,
  LotView,
  Money,
  TradingPhase,
} from "@solguficky/auction-bot-ui";
import {
  LotPhase,
  type Money as WireMoney,
} from "../gen/auction/v1/auction_pb.js";
import type {
  AuctionSnapshot,
  LotSnapshot,
} from "../gen/auction/v1/auction_service_pb.js";
import type { AuctionStage, AuctionSummary } from "./auctions.js";

// Перевод `auction.v1.LotSnapshot` в срез общего пакета. Формат сообщения уже
// проверил рантайм `@bufbuild/protobuf`; здесь — то, чего схема не выражает:
// `status` выставлен всегда, а сумма помещается в безопасное целое. Нарушение —
// дефект соседа: перевод бросает, и человек видит «недоступно», а не карточку
// с нулём вместо цены.
export function lotViewOf(snapshot: LotSnapshot): LotView {
  const step = snapshot.config?.stepPolicy?.policy;
  return {
    lotId: snapshot.id,
    auctionId: snapshot.auctionId,
    version: Number(snapshot.version),
    ...(snapshot.card === undefined
      ? {}
      : {
          card: {
            title: snapshot.card.title,
            description: snapshot.card.description,
            ...(snapshot.card.image === undefined
              ? {}
              : { image: { version: snapshot.card.image.version } }),
          },
        }),
    ...(snapshot.nextPrice === undefined
      ? {}
      : { nextPrice: moneyOf(snapshot.nextPrice) }),
    ...(step?.case === "fixed" ? { fixedStep: moneyOf(step.value) } : {}),
    // Лот без условий торгов лимитов не принимает: принимать их нечему.
    proxyEnabled: snapshot.config?.proxyEnabled ?? false,
    ...(snapshot.viewerProxyLimit === undefined
      ? {}
      : { viewerProxyLimit: moneyOf(snapshot.viewerProxyLimit) }),
    status: statusOf(snapshot.status),
  };
}

function statusOf(status: LotSnapshot["status"]): LotStatusView {
  switch (status.case) {
    case "draft":
      return { kind: "draft" };
    case "scheduled":
      return {
        kind: "scheduled",
        startingPrice: required(status.value.startingPrice),
      };
    case "trading":
      return {
        kind: "trading",
        currentPrice: required(status.value.currentPrice),
        ...(status.value.leaderId === undefined
          ? {}
          : { leaderId: status.value.leaderId }),
        ...(status.value.deadline === undefined
          ? {}
          : { deadline: status.value.deadline }),
        phase: phaseOf(status.value.phase),
      };
    case "held":
      return {
        kind: "held",
        currentPrice: required(status.value.currentPrice),
        ...(status.value.leaderId === undefined
          ? {}
          : { leaderId: status.value.leaderId }),
      };
    case "sold":
      return {
        kind: "sold",
        winnerId: status.value.winnerId,
        price: required(status.value.price),
      };
    case "unsold":
      return { kind: "unsold" };
    case "withdrawn":
      return { kind: "withdrawn" };
    case undefined:
      throw new Error("lot snapshot without status");
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

// Фаза, которой край не знает, — дефект соседа: предложить ставку не в той
// фазе хуже, чем показать «недоступно».
function phaseOf(phase: LotPhase): TradingPhase {
  switch (phase) {
    case LotPhase.ONLINE:
      return "online";
    case LotPhase.LIVE:
      return "live";
    default:
      throw new Error("lot snapshot with an unknown trading phase");
  }
}

function required(money: WireMoney | undefined): Money {
  if (money === undefined) throw new Error("lot snapshot without an amount");
  return moneyOf(money);
}

export function moneyOf(money: WireMoney): Money {
  const minorUnits = Number(money.minorUnits);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new Error("lot amount out of the safe integer range");
  }
  return { minorUnits, currency: money.currency };
}

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
