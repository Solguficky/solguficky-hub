import {
  LotPhase,
  type Money as WireMoney,
} from "../../gen/auction/v1/auction_pb.js";
import type { LotSnapshot } from "../../gen/auction/v1/auction_service_pb.js";
import type { LotStatusView, LotView, Money } from "../auction-ui/index.js";

// Перевод `auction.v1.LotSnapshot` в срез аукционного дерева. Тот же перевод
// держит поверхность аукциона (`src/surfaces/auction/snapshot.ts`): адаптер
// сгенерированного клиента — у каждой поверхности свой, дерево gRPC не знает
// (ADR-044).
//
// Формат сообщения уже проверил рантайм `@bufbuild/protobuf`; здесь — то, чего
// схема не выражает: `status` выставлен всегда, а сумма помещается в
// безопасное целое. Нарушение — дефект соседа: перевод бросает, и человек
// видит «недоступно», а не карточку с нулём вместо цены.
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
    // Без условий торгов лот лимитов не принимает: им неоткуда взяться.
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

// Фаза торгов решает, предлагать ли ставку из бота. Нулевое значение enum —
// дефект соседа, а не онлайн по умолчанию.
function phaseOf(phase: LotPhase): "online" | "live" {
  switch (phase) {
    case LotPhase.ONLINE:
      return "online";
    case LotPhase.LIVE:
      return "live";
    default:
      throw new Error("lot snapshot without a trading phase");
  }
}
