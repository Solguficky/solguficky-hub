import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  PredictionNominationResult,
  PredictionResultsView,
} from "../../ports.js";
import type { AuctionScreenBody, PredictionResultsLine } from "../../screen.js";
import type { CommandContext } from "./commands.js";

const untitledLot = "Лот без названия";

export async function openPredictionResults(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  const results = await context.auction.getPredictionResults({
    viewer: context.viewer,
    auctionId,
  });
  return {
    blocks: [
      {
        kind: "prediction-results",
        auctionId,
        results: await shownResults(context, results),
      },
    ],
    keyboard: [
      [
        {
          action: "prediction-results.back",
          callbackData: encodeAuctionCallback({ kind: "root", auctionId }),
        },
      ],
    ],
  };
}

type ShownResults = Extract<
  AuctionScreenBody["blocks"][number],
  { kind: "prediction-results" }
>["results"];

async function shownResults(
  context: CommandContext,
  results: PredictionResultsView,
): Promise<ShownResults> {
  if (results.kind !== "counted") return results;
  const nominations: PredictionResultsLine[] = [];
  for (const nomination of results.nominations) {
    nominations.push(await lineOf(context, nomination));
  }
  return { kind: "counted", nominations };
}

async function lineOf(
  context: CommandContext,
  nomination: PredictionNominationResult,
): Promise<PredictionResultsLine> {
  const shared = {
    nomination: nomination.nomination,
    winnerNames: nomination.winnerNames,
    winnerCount: nomination.winnerCount,
    ...(nomination.mine === undefined ? {} : { mine: nomination.mine }),
  };
  if (nomination.value.kind === "number") {
    return { ...shared, value: nomination.value };
  }
  const titles: string[] = [];
  for (const lotId of nomination.value.lotIds) {
    const lot = await context.auction.findLot({
      viewer: context.viewer,
      lotId,
    });
    const title = lot?.card?.title.trim() ?? "";
    titles.push(title === "" ? untitledLot : title);
  }
  return { ...shared, value: { kind: "lots", titles } };
}
