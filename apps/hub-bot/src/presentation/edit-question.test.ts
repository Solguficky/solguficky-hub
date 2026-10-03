import { describe, expect, it } from "vitest";
import {
  editQuestion,
  parseEditQuestion,
  parsePublishMomentQuestion,
  publishMomentQuestion,
} from "./edit-question.js";

const token = "AZLzpLXGfY6fChssPU5fYA";

describe("edit question step", () => {
  it("recovers the edit after process-local state has been lost", () => {
    const question = editQuestion({
      prompt: "Новое название?",
      botUsername: "stub_bot",
      token,
      field: "title",
    });

    expect(parseEditQuestion(question.entities)).toEqual({
      token,
      field: "title",
    });
  });

  it("keeps the step out of the visible text", () => {
    const question = editQuestion({
      prompt: "Новое название?",
      botUsername: "stub_bot",
      token,
      field: "title",
    });

    expect(question.text.replaceAll(String.fromCharCode(0x200b), "")).toBe(
      "Новое название?",
    );
    expect(question.text).not.toContain("v1:");
    expect(question.entities).toEqual([
      {
        type: "text_link",
        offset: 0,
        length: 1,
        url: `https://t.me/stub_bot#v1:manage:field:${token}:title`,
      },
    ]);
  });

  it("does not interpret foreign or malformed entities as an edit step", () => {
    expect(parseEditQuestion(undefined)).toBeUndefined();
    expect(parseEditQuestion([{ type: "bold", offset: 0, length: 3 }])).toBe(
      undefined,
    );
    expect(
      parseEditQuestion([
        {
          type: "text_link",
          offset: 0,
          length: 1,
          url: `https://example.com/#v1:manage:field:${token}:title`,
        },
      ]),
    ).toBeUndefined();
    expect(
      parseEditQuestion([
        { type: "text_link", offset: 0, length: 1, url: "not a url" },
      ]),
    ).toBeUndefined();
    expect(
      parseEditQuestion([
        {
          type: "text_link",
          offset: 0,
          length: 1,
          url: "https://t.me/stub_bot#%E0",
        },
      ]),
    ).toBeUndefined();
  });

  it("recovers the publish moment question and keeps it apart from edits", () => {
    const moment = publishMomentQuestion({
      prompt: "Когда опубликовать?",
      botUsername: "stub_bot",
      token,
    });
    const edit = editQuestion({
      prompt: "Новое название?",
      botUsername: "stub_bot",
      token,
      field: "title",
    });

    expect(parsePublishMomentQuestion(moment.entities)).toEqual({ token });
    expect(parseEditQuestion(moment.entities)).toBeUndefined();
    expect(parsePublishMomentQuestion(edit.entities)).toBeUndefined();
  });
});
