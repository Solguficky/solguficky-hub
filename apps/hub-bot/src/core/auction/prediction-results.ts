import type { NominationOutcome } from "../../../gen/auction/v1/auction_events_pb.js";
import { PredictionNomination as WireNomination } from "../../../gen/auction/v1/auction_pb.js";
import type {
  GetPredictionResultsResponse,
  OwnNominationResult,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  PredictionNomination,
  PredictionNominationResult,
  PredictionOwnResult,
  PredictionResultsView,
} from "../../auction-ui/index.js";

const NOMINATION_FROM_WIRE: Readonly<Record<number, PredictionNomination>> = {
  [WireNomination.MOST_EXPENSIVE_LOT]: "catalog-most-expensive-lot",
  [WireNomination.TOTAL_SALES]: "catalog-total-sales",
  [WireNomination.MOST_BIDS_LOT]: "catalog-most-bids-lot",
  [WireNomination.BIGGEST_GROWTH_LOT]: "catalog-biggest-growth-lot",
  [WireNomination.MOST_BIDDERS_LOT]: "catalog-most-bidders-lot",
  [WireNomination.TOTAL_BIDS]: "catalog-total-bids",
  [WireNomination.FINAL_MOST_EXPENSIVE_LOT]: "final-most-expensive-lot",
  [WireNomination.FINAL_TOTAL_SALES]: "final-total-sales",
  [WireNomination.FINAL_BIGGEST_GROWTH_LOT]: "final-biggest-growth-lot",
  [WireNomination.FINAL_TOTAL_BIDS]: "final-total-bids",
};

export function predictionResultsOf(
  response: GetPredictionResultsResponse,
): PredictionResultsView {
  const { outcome } = response;
  switch (outcome.case) {
    case "counted":
      return {
        kind: "counted",
        nominations: outcome.value.nominations.map((nomination, index) =>
          nominationOf(nomination, outcome.value.mine, index),
        ),
      };
    case "afterFinal":
      return { kind: "after-final" };
    case "byHand":
      return { kind: "by-hand" };
    case "cancelled":
      return { kind: "cancelled" };
    case undefined:
      throw new Error("GetPredictionResults response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function nominationOf(
  nomination: NominationOutcome,
  mine: readonly OwnNominationResult[],
  index: number,
): PredictionNominationResult {
  const id = NOMINATION_FROM_WIRE[nomination.nomination];
  if (id === undefined) {
    throw new Error(
      `prediction results nomination ${index} has an unknown value`,
    );
  }
  const own = mine.find((each) => each.nomination === nomination.nomination);
  return {
    nomination: id,
    value: outcomeValue(nomination, id, index),
    winnerNames: nomination.winnerNames.map((winner) => winner.name),
    winnerCount: nomination.winners,
    ...(own === undefined ? {} : { mine: ownOf(own, index) }),
  };
}

function outcomeValue(
  nomination: NominationOutcome,
  id: PredictionNomination,
  index: number,
): PredictionNominationResult["value"] {
  const { value } = nomination;
  switch (value.case) {
    case "lots":
      return { kind: "lots", lotIds: value.value.lotIds };
    case "number":
      return { kind: "number", value: safeNumber(value.value, id, index) };
    case undefined:
      throw new Error(`prediction results nomination ${id} has no value`);
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

function ownOf(own: OwnNominationResult, index: number): PredictionOwnResult {
  switch (own.result.case) {
    case "guessed":
      return { kind: "guessed" };
    case "missed": {
      const deviation = own.result.value.deviation;
      return deviation === undefined
        ? { kind: "missed" }
        : {
            kind: "missed",
            deviation: safeNumber(deviation, "deviation", index),
          };
    }
    case undefined:
      throw new Error(`prediction results own result ${index} is empty`);
    default: {
      const _exhaustive: never = own.result;
      return _exhaustive;
    }
  }
}

function safeNumber(value: bigint, label: string, index: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(
      `prediction results ${label} at ${index} is not a safe integer`,
    );
  }
  return number;
}
