import type { LotStatusView, LotView, Money } from "@solguficky/auction-bot-ui";
import type { Money as WireMoney } from "../../gen/auction/v1/auction_pb.js";
import type { LotSnapshot } from "../../gen/auction/v1/auction_service_pb.js";

// Перевод `auction.v1.LotSnapshot` в срез общего пакета. Тот же перевод
// держит бот аукциона (`apps/auction-bot/src/snapshot.ts`): адаптер
// сгенерированного клиента — у каждого приложения свой, пакет gRPC не знает
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

function moneyOf(money: WireMoney): Money {
  const minorUnits = Number(money.minorUnits);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new Error("lot amount out of the safe integer range");
  }
  return { minorUnits, currency: money.currency };
}
