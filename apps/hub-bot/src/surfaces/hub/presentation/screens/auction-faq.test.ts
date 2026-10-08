import { describe, expect, it } from "vitest";
import { defaultFaq } from "../../../../auction-faq.js";
import { parseAuctionCallback } from "../../../../auction-ui/index.js";
import { tokenToUuid } from "../meetup-deep-link.js";
import { auctionFaqScreen } from "./auction-faq.js";

describe("hub auction FAQ screen", () => {
  it("returns to the root feed of the same auction", () => {
    const auction = "AZLzpLXGfY6fChssPU5fYA";
    const screen = auctionFaqScreen(defaultFaq, auction);
    const [back] = screen.keyboard.inline_keyboard.at(-1) ?? [];

    expect(screen.id).toBe("auction-faq");
    expect(screen.text).toContain("<b>Правила и FAQ</b>");
    expect(back?.text).toBe("‹ Лоты");
    expect(back).toHaveProperty("callback_data");
    if (back === undefined || !("callback_data" in back)) {
      throw new Error("FAQ return button must be a callback");
    }
    expect(parseAuctionCallback(back.callback_data)).toEqual({
      ok: true,
      intent: {
        kind: "feed",
        auctionId: tokenToUuid(auction),
        page: 0,
      },
    });
    expect(
      screen.keyboard.inline_keyboard.at(-1)?.map((button) => button.text),
    ).toEqual(["‹ Лоты", "Меню"]);
  });

  it("uses only configured external links and keeps the return button", () => {
    const screen = auctionFaqScreen(
      { ...defaultFaq, detailsUrl: "https://example.org/rules" },
      "AZLzpLXGfY6fChssPU5fYA",
    );
    expect(
      screen.keyboard.inline_keyboard.map((row) =>
        row.map((button) => button.text),
      ),
    ).toEqual([["Прочитать подробнее ↗"], ["‹ Лоты", "Меню"]]);
  });
});
