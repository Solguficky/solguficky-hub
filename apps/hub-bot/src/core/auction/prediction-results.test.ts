import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PredictionNomination } from "../../../gen/auction/v1/auction_pb.js";
import { GetPredictionResultsResponseSchema } from "../../../gen/auction/v1/auction_service_pb.js";
import { predictionResultsOf } from "./prediction-results.js";

const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";

describe("predictionResultsOf", () => {
  it("maps the four outcomes and the viewer's own result", () => {
    expect(
      predictionResultsOf(
        create(GetPredictionResultsResponseSchema, {
          outcome: { case: "afterFinal", value: {} },
        }),
      ),
    ).toEqual({ kind: "after-final" });
    expect(
      predictionResultsOf(
        create(GetPredictionResultsResponseSchema, {
          outcome: { case: "byHand", value: {} },
        }),
      ),
    ).toEqual({ kind: "by-hand" });
    expect(
      predictionResultsOf(
        create(GetPredictionResultsResponseSchema, {
          outcome: { case: "cancelled", value: {} },
        }),
      ),
    ).toEqual({ kind: "cancelled" });
    expect(
      predictionResultsOf(
        create(GetPredictionResultsResponseSchema, {
          outcome: {
            case: "counted",
            value: {
              nominations: [
                {
                  nomination: PredictionNomination.MOST_EXPENSIVE_LOT,
                  value: { case: "lots", value: { lotIds: [lotId] } },
                  winners: 1,
                  winnerNames: [{ participantId: "p", name: "Сова*" }],
                },
              ],
              mine: [
                {
                  nomination: PredictionNomination.MOST_EXPENSIVE_LOT,
                  result: { case: "guessed", value: {} },
                },
              ],
            },
          },
        }),
      ),
    ).toEqual({
      kind: "counted",
      nominations: [
        {
          nomination: "catalog-most-expensive-lot",
          value: { kind: "lots", lotIds: [lotId] },
          winnerNames: ["Сова*"],
          winnerCount: 1,
          mine: { kind: "guessed" },
        },
      ],
    });
  });
});
