import { describe, expect, it } from "vitest";
import { defaultFaq, readFaqContent, renderFaqText } from "./auction-faq.js";

describe("shared auction FAQ", () => {
  it("uses the same organizer content and safely escapes it for both surfaces", () => {
    const loaded = readFaqContent({ AUCTION_FAQ_ITEMS: "<лот> & текст" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(renderFaqText(loaded.content)).toBe(
      "<b>Правила и FAQ</b>\n\n" +
        "<b>Что продаём</b>\n&lt;лот&gt; &amp; текст\n\n" +
        "<b>Куда идут средства</b>\nОрганизатор ещё не указал, куда идут средства.\n\n" +
        "<b>Правила ставок</b>\nОтменить сделанную ставку нельзя.\n\n" +
        "<b>Почти одновременные ставки</b>\nОрганизатор ещё не опубликовал порядок при почти одновременных ставках.\n\n" +
        "<b>Сбой и потеря связи</b>\nОрганизатор ещё не опубликовал порядок действий при сбое и потере связи.\n\n" +
        "<b>Доставка победителю</b>\nОрганизатор ещё не опубликовал условия доставки победителю.",
    );
    expect(readFaqContent({})).toEqual({ ok: true, content: defaultFaq });
  });
});
