import { describe, expect, it } from "vitest";
import { renderEntryScreen } from "./entry-screen.js";

describe("renderEntryScreen", () => {
  it("keeps the welcome shell free of trading buttons and hub promises", () => {
    const screen = renderEntryScreen({ kind: "welcome" });
    expect(screen.keyboard).toEqual([]);
    expect(screen.text).not.toMatch(/хаб|сходк/i);
  });

  it("gives the blocked person a text different from the not-admitted one", () => {
    const blocked = renderEntryScreen({ kind: "denied", reason: "blocked" });
    const notAdmitted = renderEntryScreen({
      kind: "denied",
      reason: "not-admitted",
    });
    expect(blocked.text).not.toBe(notAdmitted.text);
  });

  it("renders the shared body inside the shell", () => {
    const screen = renderEntryScreen({
      kind: "auction",
      body: {
        blocks: [
          { kind: "lot", lotId: "lot-1", auctionId: "auc-1", version: 1 },
        ],
        keyboard: [[{ action: "lot.refresh", callbackData: "v1:auc:lot:x" }]],
      },
    });
    expect(screen.text).toContain("lot-1");
    expect(screen.keyboard).toEqual([
      [{ text: "Обновить", callback_data: "v1:auc:lot:x" }],
    ]);
  });
});
