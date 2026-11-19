import { describe, expect, it } from "vitest";
import {
  descriptionHtml,
  plainDescription,
  richDescription,
  visibleDescription,
} from "./description-markup.js";

describe("description markup", () => {
  it("turns supported entities into Telegram HTML and drops the rest", () => {
    expect(
      descriptionHtml("жирно курсив @owl код", [
        { type: "bold", offset: 0, length: 5 },
        { type: "italic", offset: 6, length: 6 },
        { type: "mention", offset: 13, length: 4 },
        { type: "code", offset: 18, length: 3 },
      ]),
    ).toBe("<b>жирно</b> <i>курсив</i> @owl <code>код</code>");
  });

  it("nests entities and reopens the ones that cross", () => {
    expect(
      descriptionHtml("abcdef", [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 2, length: 4 },
      ]),
    ).toBe("<b>ab<i>cd</i></b><i>ef</i>");
    expect(
      descriptionHtml("abc", [
        { type: "underline", offset: 0, length: 3 },
        { type: "spoiler", offset: 1, length: 1 },
      ]),
    ).toBe("<u>a<tg-spoiler>b</tg-spoiler>c</u>");
  });

  it("counts offsets in UTF-16 units across emoji and Cyrillic", () => {
    // 🎲 — суррогатная пара: две единицы UTF-16.
    const text = "🎲 Игры 🎲 чай";
    expect(
      descriptionHtml(text, [
        { type: "bold", offset: 3, length: 4 },
        { type: "strikethrough", offset: 11, length: 3 },
      ]),
    ).toBe("🎲 <b>Игры</b> 🎲 <s>чай</s>");
  });

  it("escapes typed tags, so they stay text", () => {
    const stored = descriptionHtml("<b>текст</b> & ещё");
    expect(stored).toBe("&lt;b&gt;текст&lt;/b&gt; &amp; ещё");
    expect(plainDescription(stored)).toBe(stored);
    expect(visibleDescription(stored)).toBe("<b>текст</b> & ещё");
  });

  it("keeps a link only with a scheme Telegram shows", () => {
    expect(
      descriptionHtml("тут", [
        { type: "text_link", offset: 0, length: 3, url: "javascript:x" },
      ]),
    ).toBe("тут");
    expect(
      descriptionHtml("тут", [
        {
          type: "text_link",
          offset: 0,
          length: 3,
          url: 'https://e.org/?a="1"&b',
        },
      ]),
    ).toBe('<a href="https://e.org/?a=&quot;1&quot;&amp;b">тут</a>');
  });

  it("shows a legacy plain description as it was typed", () => {
    for (const legacy of [
      "5 < 7 & 8 > 3",
      "<b>не закрыт",
      "a <script>x</script>",
    ]) {
      expect(visibleDescription(legacy)).toBe(legacy);
      expect(plainDescription(legacy)).toBe(
        legacy
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;"),
      );
    }
  });

  it("lays out lines and blocks for the rich card", () => {
    expect(richDescription("Первая\nвторая\n\nабзац")).toBe(
      "Первая<br>вторая<br><br>абзац",
    );
    expect(
      richDescription("до\n<blockquote>цитата\nдальше</blockquote>\nпосле"),
    ).toBe("до</p><blockquote>цитата<br>дальше</blockquote><p>после");
    expect(richDescription("<pre>a\n  b</pre>")).toBe(
      "</p><pre>a\n  b</pre><p>",
    );
    // Жирный, охвативший цитату, закрывается перед ней и открывается внутри.
    expect(richDescription("<b>x<blockquote>y</blockquote>z</b>")).toBe(
      "<b>x</b></p><blockquote><b>y</b></blockquote><p><b>z</b>",
    );
  });
});
