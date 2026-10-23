import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PredictionNomination } from "../../../gen/auction/v1/auction_pb.js";
import {
  GetMyPredictionsResponseSchema,
  PredictionRound,
  PredictionRoundStatus,
  SubmitPredictionResponseSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import {
  myPredictionsOf,
  predictionOutcomeOf,
  wirePredictionAnswers,
  wirePredictionRound,
} from "./predictions.js";

const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";

describe("prediction translation", () => {
  it("reads only the viewer's two round states and maps lot and number answers", () => {
    expect(
      myPredictionsOf(
        create(GetMyPredictionsResponseSchema, {
          rounds: [
            {
              round: PredictionRound.FINAL,
              status: PredictionRoundStatus.CLOSED,
              answers: [
                {
                  nomination: PredictionNomination.FINAL_TOTAL_SALES,
                  answer: { case: "number", value: 1_250_050n },
                },
              ],
            },
            {
              round: PredictionRound.CATALOG,
              status: PredictionRoundStatus.OPEN,
              answers: [
                {
                  nomination: PredictionNomination.MOST_EXPENSIVE_LOT,
                  answer: { case: "lotId", value: LOT_ID },
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([
      {
        round: "catalog",
        status: "open",
        answers: [
          {
            nomination: "catalog-most-expensive-lot",
            answer: { kind: "lot", lotId: LOT_ID },
          },
        ],
      },
      {
        round: "final",
        status: "closed",
        answers: [
          {
            nomination: "final-total-sales",
            answer: { kind: "number", value: 1_250_050 },
          },
        ],
      },
    ]);
  });

  it("rejects a response that omits one of its two rounds", () => {
    expect(() =>
      myPredictionsOf(
        create(GetMyPredictionsResponseSchema, {
          rounds: [
            {
              round: PredictionRound.CATALOG,
              status: PredictionRoundStatus.NOT_OPEN,
            },
          ],
        }),
      ),
    ).toThrow(/both rounds/);
  });

  it("maps an accepted submission without inventing a status", () => {
    const response = create(SubmitPredictionResponseSchema, {
      outcome: {
        case: "accepted",
        value: {
          round: PredictionRound.CATALOG,
          answers: [
            {
              nomination: PredictionNomination.TOTAL_BIDS,
              answer: { case: "number", value: 42n },
            },
          ],
        },
      },
    });
    expect(predictionOutcomeOf(response)).toEqual({
      kind: "accepted",
      prediction: {
        round: "catalog",
        answers: [
          {
            nomination: "catalog-total-bids",
            answer: { kind: "number", value: 42 },
          },
        ],
      },
    });
  });

  it("maps named refusals and preserves the rejected lot", () => {
    expect(
      predictionOutcomeOf(
        create(SubmitPredictionResponseSchema, {
          outcome: {
            case: "refused",
            value: {
              reason: {
                case: "lotNotInRound",
                value: {
                  nomination: PredictionNomination.FINAL_MOST_EXPENSIVE_LOT,
                  lotId: LOT_ID,
                },
              },
            },
          },
        }),
      ),
    ).toEqual({
      kind: "refused",
      refusal: {
        kind: "lot-not-in-round",
        nomination: "final-most-expensive-lot",
        lotId: LOT_ID,
      },
    });
  });

  it("writes number answers in minor units and maps domain rounds", () => {
    expect(wirePredictionRound("final")).toBe(PredictionRound.FINAL);
    expect(
      wirePredictionAnswers([
        {
          nomination: "catalog-total-sales",
          answer: { kind: "number", value: 1_234_500 },
        },
        {
          nomination: "catalog-most-expensive-lot",
          answer: { kind: "lot", lotId: LOT_ID },
        },
      ]),
    ).toEqual([
      {
        nomination: PredictionNomination.TOTAL_SALES,
        answer: { case: "number", value: 1_234_500n },
      },
      {
        nomination: PredictionNomination.MOST_EXPENSIVE_LOT,
        answer: { case: "lotId", value: LOT_ID },
      },
    ]);
  });
});
