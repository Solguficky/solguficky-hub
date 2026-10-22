import { InlineKeyboard } from "grammy";
import {
  predictionResultsParagraphs,
  predictionResultsTitle,
} from "../../../../auction-prediction-results.js";
import type { AuctionBlock } from "../../../../auction-ui/index.js";
import { money } from "../../../../core/format.js";
import { screenText, toAuctionRoot, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

export function predictionResultsScreen(
  block: Extract<AuctionBlock, { kind: "prediction-results" }>,
): ShownScreen {
  return {
    id: "prediction-results",
    text: screenText(
      predictionResultsTitle,
      ...predictionResultsParagraphs(block, { money }),
    ),
    keyboard: withNav(new InlineKeyboard(), toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}
