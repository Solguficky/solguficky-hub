import { describe, expect, it } from "vitest";
import { meetupFieldEditQuestion } from "./meetup-field-question.js";

describe("meetup field edit question", () => {
  it("shows an empty field with the «Добавь» prompt and no copyable block", () => {
    expect(meetupFieldEditQuestion("title", "", "")).toEqual({
      text: "Добавь название сходки?",
    });
    expect(meetupFieldEditQuestion("venue", "", "")).toEqual({
      text: "Добавь место встречи?",
    });
    expect(meetupFieldEditQuestion("description", "", "")).toEqual({
      text: "Добавь короткое описание сходки.",
    });
  });

  it("puts the title and venue into an inline code block", () => {
    const question = meetupFieldEditQuestion("venue", "Зал «A&B»", "Зал «A&B»");
    expect(question).toEqual({
      text:
        "Новое место встречи?\n" +
        "нажми, чтобы скопировать:\n" +
        "<code>Зал «A&amp;B»</code>",
      source: "Зал «A&B»",
      format: "HTML",
    });
  });

  it("puts the description source into a pre block, escaping it once", () => {
    const source = "<b>Свои</b> игры &amp; чай";
    const question = meetupFieldEditQuestion(
      "description",
      "Свои игры & чай",
      source,
    );
    expect(question.text).toBe(
      "Новое описание сходки?\n" +
        "нажми, чтобы скопировать:\n" +
        "<pre>&lt;b&gt;Свои&lt;/b&gt; игры &amp;amp; чай</pre>",
    );
    expect(question.source).toBe(source);
  });

  it("keeps an oversized value inside the Telegram message limit", () => {
    const question = meetupFieldEditQuestion(
      "title",
      "а".repeat(5000),
      "а".repeat(5000),
    );
    expect(question.text.length).toBeLessThanOrEqual(4096);
    expect(question.text).toContain("…</code>");
    // Вставка показанного (обрезанного) текста совпадает с исходником вопроса.
    expect(question.source?.length).toBeLessThan(5000);
    expect(question.source?.endsWith("…")).toBe(true);
  });
});
