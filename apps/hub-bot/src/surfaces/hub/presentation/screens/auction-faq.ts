import { InlineKeyboard } from "grammy";
import { type FaqContent, renderFaqText } from "../../../../auction-faq.js";
import { encodeAuctionCallback } from "../../../../auction-ui/index.js";
import { tokenToUuid } from "../meetup-deep-link.js";
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
  keyboard.text(
    "‹ Лоты",
    encodeAuctionCallback({
      kind: "feed",
      auctionId: tokenToUuid(auctionToken),
      page: 0,
    }),
  );
  keyboard.text("Меню", "v1:nav:start");
  return {
    id: "auction-faq",
    text: renderFaqText(faq),
    keyboard,
    format: "HTML",
  };
}
