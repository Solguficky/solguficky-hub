import { describe, expect, it } from "vitest";
import { renderEntryScreen } from "./entry-screen.js";
import {
  defaultFaq,
  ENTRY_ACTIONS,
  entryCallback,
  parseEntryCallback,
  readFaqContent,
} from "./faq.js";

describe("FAQ content", () => {
  it("keeps explicit placeholders until the organizer supplies text", () => {
    expect(readFaqContent({})).toEqual({ ok: true, content: defaultFaq });
    const screen = renderEntryScreen({ kind: "faq" });
    expect(screen.text).toContain("Отменить сделанную ставку нельзя");
    for (const text of Object.values(defaultFaq))
      expect(screen.text).toContain(text);
    expect(screen.keyboard.flat().map((b) => b.text)).toEqual([
      "В меню",
      "Прочитать подробнее",
      "Задать вопрос",
    ]);
  });

  it("renders the organizer's rules verbatim as plain text and external buttons", () => {
    const result = readFaqContent({
      AUCTION_FAQ_SIMULTANEOUS_BIDS: "  Порядок организатора  ",
      AUCTION_FAQ_CONNECTION_FAILURE: "После сбоя: <текст>",
      AUCTION_FAQ_DELIVERY: "Условия доставки",
      AUCTION_FAQ_DETAILS_URL: "https://example.org/rules",
      AUCTION_FAQ_QUESTION_URL: "https://t.me/organizer",
    });
    if (!result.ok) throw new Error(result.error);
    const screen = renderEntryScreen({ kind: "faq" }, result.content);
    expect(screen.text).toContain("Порядок организатора");
    expect(screen.text).toContain("После сбоя: <текст>");
    expect(screen.text).toContain("Условия доставки");
    expect(screen.keyboard[1]).toEqual([
      { text: "Прочитать подробнее", url: "https://example.org/rules" },
    ]);
    expect(screen.keyboard[2]).toEqual([
      { text: "Задать вопрос", url: "https://t.me/organizer" },
    ]);
  });

  it.each([
    "http://example.org",
    "javascript:alert(1)",
    "https://user:secret@example.org",
    "not a url",
  ])("refuses the unsafe organizer URL %s", (url) => {
    expect(readFaqContent({ AUCTION_FAQ_DETAILS_URL: url }).ok).toBe(false);
    expect(readFaqContent({ AUCTION_FAQ_QUESTION_URL: url }).ok).toBe(false);
  });

  it("bounds the whole FAQ below Telegram's message budget", () => {
    const env = Object.fromEntries(
      [
        "ITEMS",
        "PURPOSE",
        "SIMULTANEOUS_BIDS",
        "CONNECTION_FAILURE",
        "DELIVERY",
      ].map((key) => [`AUCTION_FAQ_${key}`, "😀".repeat(250)]),
    );
    const result = readFaqContent(env);
    if (!result.ok) throw new Error(result.error);
    expect(
      renderEntryScreen({ kind: "faq" }, result.content).text.length,
    ).toBeLessThan(4096);
    expect(readFaqContent({ AUCTION_FAQ_ITEMS: "x".repeat(501) }).ok).toBe(
      false,
    );
    expect(
      readFaqContent({
        AUCTION_FAQ_DETAILS_URL: `https://example.org/${"x".repeat(2048)}`,
      }).ok,
    ).toBe(false);
  });

  it("refuses a URL whose normalized path exceeds the address budget", () => {
    const url = `https://example.org/${"я".repeat(400)}`;
    expect(url.length).toBeLessThan(2048);
    expect(readFaqContent({ AUCTION_FAQ_DETAILS_URL: url }).ok).toBe(false);
  });
});

describe("entry callbacks", () => {
  it.each(ENTRY_ACTIONS)(
    "round trips %s within the 64-byte budget",
    (action) => {
      expect(parseEntryCallback(entryCallback(action))).toBe(action);
      expect(Buffer.byteLength(entryCallback(action))).toBeLessThanOrEqual(64);
    },
  );
  it.each([
    undefined,
    {},
    "v2:entry:faq",
    "v1:entry:unknown",
    "v1:entry:menu:extra",
    "v1:auc:faq",
    "v1:entry:faq ",
  ])("does not accept malformed or foreign callback %j", (data) => {
    expect(parseEntryCallback(data)).toBeUndefined();
  });
});
