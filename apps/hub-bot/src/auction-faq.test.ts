import { describe, expect, it } from "vitest";
import {
  defaultFaq,
  faqTextProblems,
  readFaqContent,
  renderFaqText,
} from "./auction-faq.js";
import { organizerFaqText } from "./auction-faq-text.js";

describe("shared auction FAQ", () => {
  it("shows the organizer's free text to both surfaces as is", () => {
    const loaded = readFaqContent({});
    expect(loaded).toEqual({ ok: true, content: defaultFaq });
    if (!loaded.ok) return;
    expect(renderFaqText(loaded.content)).toBe(organizerFaqText);
    expect(organizerFaqText.startsWith("<b>Правила и FAQ</b>")).toBe(true);
  });

  it("keeps the organizer's text sendable as one Telegram HTML message", () => {
    expect(faqTextProblems(organizerFaqText)).toEqual([]);
  });

  it.each([
    ["<script>x</script>", "not allowed"],
    ["<b>open", "not closed"],
    ["<b>x</i>", "unbalanced"],
    ['<a href="http://example.org">x</a>', "not allowed"],
    ["1 < 2", "bare angle bracket"],
    ["Tom & Jerry", "bare ampersand"],
    ["x".repeat(4001), "visible text"],
  ])("refuses a broken FAQ text %#", (text, problem) => {
    expect(faqTextProblems(text).join("; ")).toContain(problem);
  });

  it("accepts entities, https links and nested emphasis", () => {
    expect(
      faqTextProblems(
        '<b>Тег &lt;b&gt; &amp; <i>курсив</i></b> <a href="https://t.me/x">ссылка</a>',
      ),
    ).toEqual([]);
  });
});
