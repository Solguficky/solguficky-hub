import { describe, expect, it } from "vitest";
import {
  editQuestionText,
  parseEditQuestion,
  parsePublishMomentQuestion,
  publishMomentQuestionText,
} from "./edit-question.js";

describe("edit question marker", () => {
  it("recovers the edit after process-local state has been lost", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const text = editQuestionText("Новое название?", token, "title");

    expect(parseEditQuestion(text)).toEqual({ token, field: "title" });
  });

  it("does not interpret arbitrary bot text as an edit step", () => {
    expect(parseEditQuestion("Как называется сходка?")).toBeUndefined();
  });

  it("recovers the publish moment question and keeps it apart from edits", () => {
    const token = "AZLzpLXGfY6fChssPU5fYA";
    const moment = publishMomentQuestionText("Когда опубликовать?", token);
    const edit = editQuestionText("Новое название?", token, "title");

    expect(parsePublishMomentQuestion(moment)).toEqual({ token });
    expect(parseEditQuestion(moment)).toBeUndefined();
    expect(parsePublishMomentQuestion(edit)).toBeUndefined();
  });
});
