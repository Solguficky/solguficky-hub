import { InlineKeyboard } from "grammy";
import { type FaqContent, renderFaqText } from "../../../../auction-faq.js";
import { tokenToUuid } from "../meetup-deep-link.js";
import { toAuctionRoot } from "./extensions.js";
import { backLabel } from "./kit.js";
import type { ShownScreen } from "./show.js";

export function auctionFaqScreen(
  faq: FaqContent,
  auctionToken: string,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (faq.detailsUrl !== undefined) {
    keyboard.url("Прочитать подробнее ↗", faq.detailsUrl).row();
  }
  if (faq.questionUrl !== undefined) {
    keyboard.url("Задать вопрос ↗", faq.questionUrl).row();
  }
  // Правила живут в корне аукциона (PER-605): возврат туда.
  const root = toAuctionRoot(tokenToUuid(auctionToken));
  keyboard.text(backLabel(root), root.data);
  return {
    id: "auction-faq",
    text: renderFaqText(faq),
    keyboard,
    format: "HTML",
  };
}
