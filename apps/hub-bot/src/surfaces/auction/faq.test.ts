import { describe, expect, it } from "vitest";
import { renderEntryScreen } from "./entry-screen.js";
import {
  defaultFaq,
  ENTRY_ACTIONS,
  entryCallback,
  listCallback,
  MAX_LIST_PAGE,
  parseEntryCallback,
  readFaqContent,
  startCallback,
} from "./faq.js";

describe("FAQ content", () => {
  it("shows the organizer's FAQ text without configuration", () => {
    expect(readFaqContent({})).toEqual({ ok: true, content: defaultFaq });
    const screen = renderEntryScreen(
      { kind: "faq" },
      { timeZone: "Europe/Moscow" },
    );
    expect(screen.text).toBe(defaultFaq.text);
    expect(screen.text).toContain("Отменить ставку нельзя");
    // Только «Аукционы» ставит отметку ознакомления; последний ряд —
    // возврат в меню (PER-592).
    expect(screen.keyboard).toEqual([
      [{ text: "Прочитать подробнее", callback_data: "v1:entry:details" }],
      [{ text: "Задать вопрос", callback_data: "v1:entry:question" }],
      [{ text: "Аукционы", callback_data: "v1:entry:read" }],
      [{ text: "‹ Меню", callback_data: "v1:entry:menu" }],
    ]);
  });

  it("renders the organizer's text verbatim and marks external buttons", () => {
    const result = readFaqContent({
      AUCTION_FAQ_DETAILS_URL: "https://example.org/rules",
      AUCTION_FAQ_QUESTION_URL: "https://t.me/organizer",
    });
    if (!result.ok) throw new Error(result.error);
    const screen = renderEntryScreen(
      { kind: "faq" },
      {
        faq: { ...result.content, text: "<b>Правила</b>\n\nТекст &amp; ещё" },
        timeZone: "Europe/Moscow",
      },
    );
    // Текст организатора уже размечен и уходит как есть.
    expect(screen.text).toBe("<b>Правила</b>\n\nТекст &amp; ещё");
    expect(screen.keyboard[0]).toEqual([
      { text: "Прочитать подробнее ↗", url: "https://example.org/rules" },
    ]);
    expect(screen.keyboard[1]).toEqual([
      { text: "Задать вопрос ↗", url: "https://t.me/organizer" },
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

  it("bounds the organizer's links", () => {
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
      expect(parseEntryCallback(entryCallback(action))).toEqual({
        action,
        page: 0,
      });
      expect(Buffer.byteLength(entryCallback(action))).toBeLessThanOrEqual(64);
    },
  );
  it.each([
    ["auctions", 0],
    ["auctions", 1],
    ["past", 12],
    ["past", MAX_LIST_PAGE],
  ] as const)("round trips the %s list page %i", (action, page) => {
    const data = listCallback(action, page);
    expect(parseEntryCallback(data)).toEqual({ action, page });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });
  // Повтор входа несёт код канала, пока тот помещается в 64 байта кнопки.
  it.each(["chat", "a-b_C9", "", "a".repeat(49)])(
    "round trips the entry retry with the channel code %j",
    (sourceCode) => {
      const data = startCallback(sourceCode);
      expect(parseEntryCallback(data)).toEqual({
        action: "start",
        page: 0,
        sourceCode,
      });
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    },
  );
  it.each([undefined, "a".repeat(50), "a".repeat(62)])(
    "retries the entry without a channel code that does not fit: %s",
    (sourceCode) => {
      expect(startCallback(sourceCode)).toBe(entryCallback("start"));
    },
  );
  it("keeps the first list page equal to the menu button", () => {
    expect(listCallback("past", 0)).toBe(entryCallback("past"));
  });
  it.each([
    undefined,
    {},
    "v2:entry:faq",
    "v1:entry:unknown",
    "v1:entry:menu:extra",
    "v1:auc:faq",
    "v1:entry:faq ",
    "v1:entry:past:0",
    "v1:entry:past:01",
    "v1:entry:past:1000",
    "v1:entry:past:-1",
    "v1:entry:faq:1",
    "v1:entry:auctions:1:2",
    "v1:entry:start:a b",
    `v1:entry:start:${"a".repeat(50)}`,
    "v1:entry:read:chat",
  ])("does not accept malformed or foreign callback %j", (data) => {
    expect(parseEntryCallback(data)).toBeUndefined();
  });
});
