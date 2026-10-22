export type PredictionResultsNotice = {
  kind: "prediction-results";
  auctionId: string;
};

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function predictionResultsNoticeOf(value: {
  auctionId: string;
}): PredictionResultsNotice | undefined {
  if (!CANONICAL_UUID.test(value.auctionId)) return undefined;
  return { kind: "prediction-results", auctionId: value.auctionId };
}

export type PredictionResultsNoticeView = {
  text: string;
  button: { auctionId: string; text: string };
};

const toResultsLabel = "К итогам";

export function renderPredictionResultsNotice(
  notice: PredictionResultsNotice,
): PredictionResultsNoticeView {
  return {
    text: "Итоги твоих прогнозов подведены.",
    button: { auctionId: notice.auctionId, text: toResultsLabel },
  };
}
