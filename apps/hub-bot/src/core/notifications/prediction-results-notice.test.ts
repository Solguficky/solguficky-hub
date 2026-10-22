import { describe, expect, it } from "vitest";
import {
  predictionResultsNoticeOf,
  renderPredictionResultsNotice,
} from "./prediction-results-notice.js";

const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";

describe("predictionResultsNoticeOf", () => {
  it("accepts the thin fact: the auction id only", () => {
    expect(predictionResultsNoticeOf({ auctionId })).toEqual({
      kind: "prediction-results",
      auctionId,
    });
  });

  it("rejects an auction id that is not canonical", () => {
    expect(
      predictionResultsNoticeOf({ auctionId: auctionId.toUpperCase() }),
    ).toBeUndefined();
  });
});

describe("renderPredictionResultsNotice", () => {
  it("is one phrase and a button to the results screen", () => {
    const notice = predictionResultsNoticeOf({ auctionId });
    if (notice === undefined) throw new Error("notice");
    expect(renderPredictionResultsNotice(notice)).toEqual({
      text: "Итоги твоих прогнозов подведены.",
      button: { auctionId, text: "К итогам" },
    });
  });
});
