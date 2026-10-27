import type { Client } from "@connectrpc/connect";
import type { AuctionService } from "../../../../gen/auction/v1/auction_service_pb.js";
import { moneyOf } from "../../../core/auction/snapshot.js";
import { happyHourLotTermsOf, happyHourPeriodOf } from "./console.js";
import type {
  AuctionFailure,
  ClearHappyHourLotTermsResult,
  CreateHappyHourPeriodResult,
  DeleteHappyHourPeriodResult,
  SetHappyHourLotTermsResult,
} from "./port.js";

// Перевод ответов команд «Счастливых часов» (PER-787): именованный отказ
// Auction — значение ответа, а не сбой вызова; ответ без исхода или причины —
// дефект соседа.

type Rpc = Client<typeof AuctionService>;
type Outcome<M extends keyof Rpc> =
  Awaited<ReturnType<Rpc[M]>> extends {
    outcome: infer O;
  }
    ? O
    : never;

function defect(what: string): AuctionFailure {
  return { kind: "invalid", cause: new Error(what) };
}

// Отказы, общие у четырёх команд; `undefined` — причина своя у команды.
function common(reason: {
  case: string | undefined;
}):
  | { kind: "not-administrator" }
  | { kind: "meetup-not-found" }
  | { kind: "meetup-cancelled" }
  | { kind: "not-in-prebidding" }
  | undefined {
  switch (reason.case) {
    case "notMeetupAdministrator":
      return { kind: "not-administrator" };
    case "meetupNotFound":
      return { kind: "meetup-not-found" };
    case "meetupCancelled":
      return { kind: "meetup-cancelled" };
    case "notInPrebidding":
      return { kind: "not-in-prebidding" };
    default:
      return undefined;
  }
}

export function createHappyHourPeriodResult(
  outcome: Outcome<"createHappyHourPeriod">,
): CreateHappyHourPeriodResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok", period: happyHourPeriodOf(outcome.value) };
    case "refused": {
      const reason = outcome.value.reason;
      const shared = common(reason);
      if (shared !== undefined) return shared;
      switch (reason.case) {
        case "periodInPast":
          return { kind: "period-in-past" };
        case "periodEmpty":
          return { kind: "period-empty" };
        case "periodOutsideOnlinePhase":
          return { kind: "period-outside-phase" };
        default:
          return defect("happy hour period refusal without a known reason");
      }
    }
    default:
      return defect("happy hour period answer without an outcome");
  }
}

export function deleteHappyHourPeriodResult(
  outcome: Outcome<"deleteHappyHourPeriod">,
): DeleteHappyHourPeriodResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused": {
      const reason = outcome.value.reason;
      const shared = common(reason);
      if (shared !== undefined) return shared;
      switch (reason.case) {
        case "periodNotFound":
          return { kind: "period-not-found" };
        case "periodStarted":
          return { kind: "period-started" };
        default:
          return defect("happy hour deletion refusal without a known reason");
      }
    }
    default:
      return defect("happy hour deletion answer without an outcome");
  }
}

export function setHappyHourLotTermsResult(
  outcome: Outcome<"setHappyHourLotTerms">,
): SetHappyHourLotTermsResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok", terms: happyHourLotTermsOf(outcome.value) };
    case "refused": {
      const reason = outcome.value.reason;
      const shared = common(reason);
      if (shared !== undefined) return shared;
      switch (reason.case) {
        case "periodNotFound":
          return { kind: "period-not-found" };
        case "periodStarted":
          return { kind: "period-started" };
        case "termsEmpty":
          return { kind: "terms-empty" };
        case "lotNotInAuction":
          return { kind: "lot-not-in-auction" };
        case "lotNotOpen":
          return { kind: "lot-not-open" };
        case "amountInvalid":
          return { kind: "amount-invalid" };
        case "stepNotLower":
          return {
            kind: "step-not-lower",
            ...(reason.value.regularStep === undefined
              ? {}
              : { regularStep: moneyOf(reason.value.regularStep) }),
          };
        case "startNotLower":
          return {
            kind: "start-not-lower",
            ...(reason.value.regularStart === undefined
              ? {}
              : { regularStart: moneyOf(reason.value.regularStart) }),
          };
        case "windowsOverlap":
          return {
            kind: "windows-overlap",
            from: reason.value.from,
            until: reason.value.until,
          };
        default:
          return defect("happy hour terms refusal without a known reason");
      }
    }
    default:
      return defect("happy hour terms answer without an outcome");
  }
}

export function clearHappyHourLotTermsResult(
  outcome: Outcome<"clearHappyHourLotTerms">,
): ClearHappyHourLotTermsResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused": {
      const reason = outcome.value.reason;
      const shared = common(reason);
      if (shared !== undefined) return shared;
      switch (reason.case) {
        case "periodNotFound":
          return { kind: "period-not-found" };
        case "periodStarted":
          return { kind: "period-started" };
        case "lotNotInAuction":
          return { kind: "lot-not-in-auction" };
        default:
          return defect("happy hour clearing refusal without a known reason");
      }
    }
    default:
      return defect("happy hour clearing answer without an outcome");
  }
}
