import { InlineKeyboard } from "grammy";
import {
  auctionChronicleParagraphs,
  auctionChronicleTitle,
} from "../../../../auction-day-chronicle.js";
import type { AuctionBlock } from "../../../../auction-ui/index.js";
import { money } from "../../../../core/format.js";
import { screenText, toAuctionRoot, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Статистика аукциона (PER-770): все торги из корня аукциона, тексты общие с
// ботом аукциона и с хрониками дня.
export function auctionChronicleScreen(
  block: Extract<AuctionBlock, { kind: "auction-chronicle" }>,
): ShownScreen {
  return {
    id: "auction-chronicle",
    text: screenText(
      auctionChronicleTitle,
      ...auctionChronicleParagraphs(block, { money }),
    ),
    keyboard: withNav(new InlineKeyboard(), toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}
