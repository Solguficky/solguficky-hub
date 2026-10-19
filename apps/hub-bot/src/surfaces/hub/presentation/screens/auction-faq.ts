import { InlineKeyboard } from "grammy";
import { type FaqContent, renderFaqText } from "../../../../auction-faq.js";
import { tokenToUuid } from "../meetup-deep-link.js";
import { backLabel, toAuctionRoot, viaEvents } from "./kit.js";
import type { ShownScreen } from "./show.js";

export function auctionFaqScreen(
  faq: FaqContent,
  auctionToken: string,
  fromEvents = false,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (faq.detailsUrl !== undefined) {
    keyboard.url("Прочитать подробнее ↗", faq.detailsUrl).row();
  }
  if (faq.questionUrl !== undefined) {
    keyboard.url("Задать вопрос ↗", faq.questionUrl).row();
  }
  // Правила живут в корне аукциона (PER-605): возврат туда, со входом из
  // «Событий», если корень открыт оттуда (PER-669).
  const root = toAuctionRoot(tokenToUuid(auctionToken));
  keyboard.text(backLabel(root), fromEvents ? viaEvents(root.data) : root.data);
  return {
    id: "auction-faq",
    text: renderFaqText(faq),
    keyboard,
    format: "HTML",
  };
}
