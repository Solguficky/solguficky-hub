import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  AchievementsInvariant,
  reportAchievementsFailure,
} from "./failures.js";

describe("achievement failure categories", () => {
  it.each([
    [new ConnectError("deadline", Code.DeadlineExceeded), "timeout"],
    [new ConnectError("offline", Code.Unavailable), "dependency_unavailable"],
    [new AchievementsInvariant("wrong holder"), "invariant"],
    [new Error("defect"), "unexpected"],
  ])("classifies %s as %s", (cause, category) => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    reportAchievementsFailure({
      logger,
      cause,
      meta: { requestId: "request-1" },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "achievement screen unavailable",
      expect.objectContaining({
        request_id: "request-1",
        error_category: category,
      }),
    );
    if (category === "unexpected")
      expect(logger.warn.mock.calls[0]?.[1]?.stack).toContain("Error: defect");
  });
});
