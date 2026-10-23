import { describe, expect, it } from "vitest";
import { noteCatalog } from "../../core/release-notes.js";
import { toReleaseTrace } from "./release-lines.js";

const notes = noteCatalog([
  {
    id: "known",
    surfaces: ["hub"],
    text: "Под сводкой аукциона теперь кнопка на каждый лот.",
  },
  { id: "auction-only", surfaces: ["auction"], text: "Только аукцион." },
]);

describe("release trace", () => {
  it("drops a record the image does not know", () => {
    expect(
      toReleaseTrace(
        notes,
        ["missing", "known", "auction-only"],
        "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
        "14 октября",
      ),
    ).toEqual({
      kind: "ready",
      message: {
        kind: "release-note",
        day: "14 октября",
        lines: ["Под сводкой аукциона теперь кнопка на каждый лот."],
        hidden: 0,
        summaryId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
      },
    });
  });

  it("does not send a summary with no known record", () => {
    expect(
      toReleaseTrace(
        notes,
        ["missing", "auction-only"],
        "summary",
        "14 октября",
      ),
    ).toEqual({ kind: "ineligible" });
  });
});
