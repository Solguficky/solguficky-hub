import { InlineKeyboard } from "grammy";
import {
  auctionChronicleParagraphs,
  auctionChronicleTitle,
} from "../../../../auction-day-chronicle.js";
import type { AuctionBlock } from "../../../../auction-ui/index.js";
import { money } from "../../../../core/format.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { consoleDaySummaryData } from "../parse-callback.js";
import { screenText, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Статистика аукциона (PER-770): все торги, тексты общие с хрониками дня. Вход
// — «Сводка дня» пульта (PER-800), и возврат туда же.
export function auctionChronicleScreen(
  block: Extract<AuctionBlock, { kind: "auction-chronicle" }>,
): ShownScreen {
  return {
    id: "auction-chronicle",
    text: screenText(
      auctionChronicleTitle,
      ...auctionChronicleParagraphs(block, { money }),
    ),
    keyboard: withNav(new InlineKeyboard(), {
      name: "Сводка дня",
      data: consoleDaySummaryData(uuidToToken(block.auctionId)),
    }),
    format: "HTML",
  };
}
