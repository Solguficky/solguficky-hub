import { describe, expect, it } from "vitest";
import { editQuestionText, parseEditQuestion } from "./edit-question.js";

describe("edit question marker", () => {
  it("recovers the edit after process-local state has been lost", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const text = editQuestionText("Новое название?", token, "title");

    expect(parseEditQuestion(text)).toEqual({ token, field: "title" });
  });

  it("does not interpret arbitrary bot text as an edit step", () => {
    expect(parseEditQuestion("Как называется сходка?")).toBeUndefined();
  });
});
