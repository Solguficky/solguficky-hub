import { describe, expect, it } from "vitest";
import { predictionResultsParagraphs } from "./auction-prediction-results.js";
import type { AuctionBlock } from "./auction-ui/index.js";

const money = () => "не нужно";

function counted(
  winnerNames: readonly string[],
  winnerCount: number,
): Extract<AuctionBlock, { kind: "prediction-results" }> {
  return {
    kind: "prediction-results",
    auctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
    results: {
      kind: "counted",
      nominations: [
        {
          nomination: "catalog-total-bids",
          value: { kind: "number", value: 12 },
          winnerNames,
          winnerCount,
        },
      ],
    },
  };
}

describe("prediction result winners", () => {
  it("names everyone when every display name remains", () => {
    const [text] = predictionResultsParagraphs(counted(["Сова*"], 1), {
      money,
    });
    expect(text).toContain("Угадали: Сова*.");
  });

  it("keeps the full count when a name was erased", () => {
    const [text] = predictionResultsParagraphs(counted(["Сова*"], 3), {
      money,
    });
    expect(text).toContain("Угадали 3: Сова*.");
  });

  it("counts guessers when no name remains", () => {
    const [text] = predictionResultsParagraphs(counted([], 2), { money });
    expect(text).toContain("Угадали: 2.");
  });

  it("says nobody guessed", () => {
    const [text] = predictionResultsParagraphs(counted([], 0), { money });
    expect(text).toContain("Никто не угадал.");
  });
});
