import { PredictionNomination as WireNomination } from "../../../gen/auction/v1/auction_pb.js";
import {
  type GetMyPredictionsResponse,
  type SubmitPredictionResponse,
  PredictionRound as WireRound,
  PredictionRoundStatus as WireStatus,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  Prediction,
  PredictionAnswer,
  PredictionOutcome,
  PredictionRefusal,
  PredictionRoundStatus,
  PredictionRoundView,
  PredictionRound as Round,
} from "../../auction-ui/index.js";
import {
  type PredictionNomination,
  predictionNominationsFor,
  predictionSpec,
} from "../../auction-ui/index.js";

const ROUND_FROM_WIRE: Readonly<Record<number, Round>> = {
  [WireRound.CATALOG]: "catalog",
  [WireRound.FINAL]: "final",
};

const ROUND_TO_WIRE: Readonly<Record<Round, WireRound>> = {
  catalog: WireRound.CATALOG,
  final: WireRound.FINAL,
};

const STATUS_FROM_WIRE: Readonly<Record<number, PredictionRoundStatus>> = {
  [WireStatus.NOT_OPEN]: "not-open",
  [WireStatus.OPEN]: "open",
  [WireStatus.CLOSED]: "closed",
  [WireStatus.CANCELLED]: "cancelled",
};

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

const NOMINATION_TO_WIRE: Readonly<
  Record<PredictionNomination, WireNomination>
> = {
  "catalog-most-expensive-lot": WireNomination.MOST_EXPENSIVE_LOT,
  "catalog-total-sales": WireNomination.TOTAL_SALES,
  "catalog-most-bids-lot": WireNomination.MOST_BIDS_LOT,
  "catalog-biggest-growth-lot": WireNomination.BIGGEST_GROWTH_LOT,
  "catalog-most-bidders-lot": WireNomination.MOST_BIDDERS_LOT,
  "catalog-total-bids": WireNomination.TOTAL_BIDS,
  "final-most-expensive-lot": WireNomination.FINAL_MOST_EXPENSIVE_LOT,
  "final-total-sales": WireNomination.FINAL_TOTAL_SALES,
  "final-biggest-growth-lot": WireNomination.FINAL_BIGGEST_GROWTH_LOT,
  "final-total-bids": WireNomination.FINAL_TOTAL_BIDS,
};

const NOMINATION_ORDER = new Map(
  predictionNominationsFor("catalog")
    .concat(predictionNominationsFor("final"))
    .map((spec, index) => [spec.id, index]),
);

export function wirePredictionRound(round: Round): WireRound {
  return ROUND_TO_WIRE[round];
}

export function wirePredictionAnswers(answers: readonly PredictionAnswer[]): {
  nomination: WireNomination;
  answer: { case: "lotId"; value: string } | { case: "number"; value: bigint };
}[] {
  return answers.map(({ nomination, answer }) => ({
    nomination: NOMINATION_TO_WIRE[nomination],
    answer:
      answer.kind === "lot"
        ? { case: "lotId", value: answer.lotId }
        : { case: "number", value: BigInt(answer.value) },
  }));
}

export function myPredictionsOf(
  response: GetMyPredictionsResponse,
): readonly PredictionRoundView[] {
  const rounds = response.rounds.map((round) => predictionRoundViewOf(round));
  if (
    rounds.length !== 2 ||
    new Set(rounds.map((round) => round.round)).size !== 2
  ) {
    throw new Error("GetMyPredictions did not return both rounds exactly once");
  }
  return [...rounds].sort((a, b) =>
    a.round === b.round ? 0 : a.round === "catalog" ? -1 : 1,
  );
}

export function predictionOutcomeOf(
  response: SubmitPredictionResponse,
): PredictionOutcome {
  const { outcome } = response;
  switch (outcome.case) {
    case "accepted":
      return { kind: "accepted", prediction: predictionOf(outcome.value) };
    case "refused":
      return { kind: "refused", refusal: refusalOf(outcome.value.reason) };
    case undefined:
      throw new Error("SubmitPrediction response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function predictionRoundViewOf(
  round: GetMyPredictionsResponse["rounds"][number],
): PredictionRoundView {
  const roundName = ROUND_FROM_WIRE[round.round];
  if (roundName === undefined) {
    throw new Error(`prediction round with an unknown value: ${round.round}`);
  }
  const status = STATUS_FROM_WIRE[round.status];
  if (status === undefined) {
    throw new Error(`prediction round with an unknown status: ${round.status}`);
  }
  return {
    round: roundName,
    status,
    answers: sortedAnswersOf(round.answers, roundName),
  };
}

function predictionOf(prediction: {
  round: WireRound;
  answers: GetMyPredictionsResponse["rounds"][number]["answers"];
}): Prediction {
  const round = ROUND_FROM_WIRE[prediction.round];
  if (round === undefined) {
    throw new Error(`prediction with an unknown round: ${prediction.round}`);
  }
  return { round, answers: sortedAnswersOf(prediction.answers, round) };
}

function sortedAnswersOf(
  answers: GetMyPredictionsResponse["rounds"][number]["answers"],
  round: Round,
): readonly PredictionAnswer[] {
  return answers
    .map((answer) => answerOf(answer, round))
    .sort(
      (a, b) =>
        (NOMINATION_ORDER.get(a.nomination) ?? 0) -
        (NOMINATION_ORDER.get(b.nomination) ?? 0),
    );
}

function answerOf(
  answer: GetMyPredictionsResponse["rounds"][number]["answers"][number],
  round: Round,
): PredictionAnswer {
  const nomination = NOMINATION_FROM_WIRE[answer.nomination];
  if (nomination === undefined) {
    throw new Error(
      `prediction with an unknown nomination: ${answer.nomination}`,
    );
  }
  const spec = predictionSpec(nomination);
  if (spec.round !== round) {
    throw new Error(
      `prediction nomination ${spec.number} is in the wrong round`,
    );
  }
  switch (answer.answer.case) {
    case "lotId":
      if (spec.answer !== "lot") {
        throw new Error(
          `prediction nomination ${spec.number} requires a number`,
        );
      }
      return {
        nomination,
        answer: { kind: "lot", lotId: answer.answer.value },
      };
    case "number": {
      if (spec.answer === "lot") {
        throw new Error(`prediction nomination ${spec.number} requires a lot`);
      }
      const value = Number(answer.answer.value);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(
          `prediction nomination ${spec.number} has an unsafe number`,
        );
      }
      return { nomination, answer: { kind: "number", value } };
    }
    case undefined:
      throw new Error(`prediction nomination ${spec.number} has no answer`);
    default: {
      const _exhaustive: never = answer.answer;
      return _exhaustive;
    }
  }
}

function refusalOf(reason: {
  case: string | undefined;
  value?: unknown;
}): PredictionRefusal {
  switch (reason.case) {
    case "roundNotOpen":
      return { kind: "round-not-open" };
    case "roundClosed":
      return { kind: "round-closed" };
    case "predictionsCancelled":
      return { kind: "cancelled" };
    case "displayNameNotChosen":
      return { kind: "display-name-not-chosen" };
    case "lotNotInRound": {
      const value = reason.value;
      if (
        typeof value !== "object" ||
        value === null ||
        !("nomination" in value) ||
        !("lotId" in value)
      ) {
        throw new Error("prediction refusal without lot details");
      }
      const nomination = NOMINATION_FROM_WIRE[Number(value.nomination)];
      if (nomination === undefined || typeof value.lotId !== "string") {
        throw new Error("prediction refusal with invalid lot details");
      }
      return { kind: "lot-not-in-round", nomination, lotId: value.lotId };
    }
    case undefined:
      throw new Error("prediction refusal without a reason");
    default:
      throw new Error(
        `prediction refusal with an unknown reason: ${reason.case}`,
      );
  }
}
