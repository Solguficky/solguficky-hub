import { Code, ConnectError } from "@connectrpc/connect";
import {
  LotPhase,
  type Money as WireMoney,
} from "../../../gen/auction/v1/auction_pb.js";
import type {
  LotSnapshot,
  LotStepWindow,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  LotStatusView,
  LotView,
  Money,
  StepWindowView,
} from "../../auction-ui/index.js";

// Перевод `auction.v1.LotSnapshot` в срез аукционного дерева — общий у обеих
// поверхностей: дерево gRPC не знает (ADR-044), а адаптер у пакета один.
//
// Формат сообщения уже проверил рантайм `@bufbuild/protobuf`; здесь — то, чего
// схема не выражает: `status` выставлен всегда, а сумма помещается в
// безопасное целое. Нарушение — дефект соседа: перевод бросает, и человек
// видит «недоступно», а не карточку с нулём вместо цены.
// `FindLot` порта дерева: NOT_FOUND у `GetLot` — «лота нет или он не виден»,
// ответ, а не сбой. Прочие отказы бросаются как есть.
export async function lotOrMissing(
  read: () => Promise<LotSnapshot>,
): Promise<LotView | undefined> {
  try {
    return lotViewOf(await read());
  } catch (cause) {
    if (cause instanceof ConnectError && cause.code === Code.NotFound) {
      return undefined;
    }
    throw cause;
  }
}

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
    ...(snapshot.baseStep === undefined
      ? {}
      : { baseStep: moneyOf(snapshot.baseStep) }),
    ...(snapshot.activeWindow === undefined
      ? {}
      : { activeWindow: windowOf(snapshot.activeWindow) }),
    ...(snapshot.nextWindow === undefined
      ? {}
      : { nextWindow: windowOf(snapshot.nextWindow) }),
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

// Окно без шага — дефект соседа: показать сниженный шаг без суммы нельзя.
function windowOf(window: LotStepWindow): StepWindowView {
  return {
    from: window.from,
    until: window.until,
    step: required(window.step),
  };
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
