import { InlineKeyboard } from "grammy";
import {
  auctionResultsParagraphs,
  auctionResultsTitle,
} from "../../../../auction-results.js";
import type { AuctionBlock } from "../../../../auction-ui/index.js";
import { money } from "../../../../core/format.js";
import { screenText, toAuctionRoot, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Итоги завершённого аукциона (PER-813): проданные лоты, покупатели и цены.
export function auctionResultsScreen(
  block: Extract<AuctionBlock, { kind: "auction-results" }>,
): ShownScreen {
  return {
    id: "auction-results",
    text: screenText(
      auctionResultsTitle,
      ...auctionResultsParagraphs(block, { money }),
    ),
    keyboard: withNav(new InlineKeyboard(), toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}
