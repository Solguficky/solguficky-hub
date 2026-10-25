import { InlineKeyboard } from "grammy";
import {
  dayChronicleParagraphs,
  dayChronicleTitle,
} from "../../../../auction-day-chronicle.js";
import type { AuctionBlock } from "../../../../auction-ui/index.js";
import { money } from "../../../../core/format.js";
import { screenText, toAuctionRoot, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Хроники дня участника (PER-725): номинации последних суток из корня
// аукциона, тексты общие с ботом аукциона и сводкой дня пульта.
export function dayChronicleScreen(
  block: Extract<AuctionBlock, { kind: "day-chronicle" }>,
): ShownScreen {
  return {
    id: "day-chronicle",
    text: screenText(
      dayChronicleTitle,
      ...dayChronicleParagraphs(block, { money }),
    ),
    keyboard: withNav(new InlineKeyboard(), toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}
