import { Code, ConnectError } from "@connectrpc/connect";
import type { Money as WireMoney } from "../../../../gen/auction/v1/auction_pb.js";
import type {
  ChooseDisplayNameResponse,
  PlaceBidResponse,
  SetProxyLimitResponse,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import type {
  BidRefusal,
  CommandOutcome,
  DisplayNameOutcome,
  DisplayNameRefusal,
  Money,
  ProxyLimitRefusal,
} from "../../../auction-ui/index.js";
import { moneyOf } from "./snapshot.js";

// Ответы команд участника в словаре пакета (PER-317). Отказ — значение ответа,
// а не статус (integration.md, «Auction gRPC»); цену отказ несёт сам, и её
// отсутствие — дефект соседа: перевод бросает, а не показывает отказ без цены.
// Тот же перевод есть у бота аукциона: код ботов не делится (ADR-044).

export function bidOutcomeOf(
  response: PlaceBidResponse,
): CommandOutcome<BidRefusal> {
  const { outcome } = response;
  switch (outcome.case) {
    case "accepted":
      return { kind: "accepted" };
    case "refused": {
      const { reason } = outcome.value;
      switch (reason.case) {
        case "lotNotOpen":
          return refused({ kind: "lot-not-open" });
        case "lotOnHold":
          return refused({
            kind: "lot-on-hold",
            currentPrice: priced(reason.value.currentPrice),
          });
        case "bidBelowMinimum":
          return refused({
            kind: "bid-below-minimum",
            minRequired: priced(reason.value.minRequired),
          });
        case "bidNotAtNextPrice":
          return refused({
            kind: "bid-not-at-next-price",
            expected: priced(reason.value.expected),
          });
        case "bidderIsLeader":
          return refused({
            kind: "bidder-is-leader",
            currentPrice: priced(reason.value.currentPrice),
          });
        case "currencyMismatch":
          return refused({ kind: "currency-mismatch" });
        case "displayNameNotChosen":
          return refused({ kind: "display-name-not-chosen" });
        case undefined:
          throw new Error("bid refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      throw new Error("bid response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function limitOutcomeOf(
  response: SetProxyLimitResponse,
): CommandOutcome<ProxyLimitRefusal> {
  const { outcome } = response;
  switch (outcome.case) {
    case "accepted":
      return { kind: "accepted" };
    case "refused": {
      const { reason } = outcome.value;
      switch (reason.case) {
        case "lotNotOpen":
          return refused({ kind: "lot-not-open" });
        case "proxyBelowCurrentPrice":
          return refused({
            kind: "proxy-below-current-price",
            minLimit: priced(reason.value.minLimit),
          });
        case "proxyDisabledForLot":
          return refused({ kind: "proxy-disabled" });
        case "currencyMismatch":
          return refused({ kind: "currency-mismatch" });
        case "displayNameNotChosen":
          return refused({ kind: "display-name-not-chosen" });
        case undefined:
          throw new Error("proxy limit refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      throw new Error("proxy limit response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export function displayNameOutcomeOf(
  response: ChooseDisplayNameResponse,
): DisplayNameOutcome {
  const { outcome } = response;
  switch (outcome.case) {
    case "accepted":
      return { kind: "accepted", name: outcome.value.text };
    case "refused": {
      const refusal = displayNameRefusalOf(outcome.value.reason.case);
      if (refusal === undefined) {
        throw new Error("display name refusal without a reason");
      }
      return { kind: "refused", refusal };
    }
    case undefined:
      throw new Error("display name response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function displayNameRefusalOf(
  reason:
    | "usernameMissing"
    | "aliasInvalid"
    | "aliasTaken"
    | "nameFrozen"
    | undefined,
): DisplayNameRefusal | undefined {
  switch (reason) {
    case "usernameMissing":
      return "username-missing";
    case "aliasInvalid":
      return "alias-invalid";
    case "aliasTaken":
      return "alias-taken";
    case "nameFrozen":
      return "name-frozen";
    case undefined:
      return undefined;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function refused<Refusal>(refusal: Refusal): CommandOutcome<Refusal> {
  return { kind: "refused", refusal };
}

function priced(money: WireMoney | undefined): Money {
  if (money === undefined) throw new Error("refusal without its price");
  return moneyOf(money);
}

// Ответа не было вовсе: дедлайн истёк или связь оборвалась до ответа. Только
// такой вызов пакет повторяет тем же `op_id`; остальные статусы — отказ
// транспорта, и он уходит выше исключением.
export async function unansweredOn<Outcome>(
  call: () => Promise<Outcome>,
): Promise<Outcome | { kind: "unanswered" }> {
  try {
    return await call();
  } catch (cause) {
    if (
      cause instanceof ConnectError &&
      (cause.code === Code.DeadlineExceeded || cause.code === Code.Unavailable)
    ) {
      return { kind: "unanswered" };
    }
    throw cause;
  }
}
