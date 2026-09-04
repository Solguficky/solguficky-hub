import { describe, expect, it } from "vitest";
import { createDispatcher } from "./dispatcher.js";

describe("dispatcher", () => {
  it("renders the start response without telegram types", () => {
    const dispatcher = createDispatcher();
    const result = dispatcher.execute({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "start",
    });
    expect(result).toEqual({
      kind: "message",
      text: expect.stringContaining("Привет."),
    });
  });

  it("renders the same start response when a deep link is present", () => {
    const dispatcher = createDispatcher();
    const result = dispatcher.execute({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "start",
      deepLink: {
        kind: "meetup",
        payload: "m_AZLzpLXGfY6fChssPU5fYA",
      },
    });
    expect(result).toEqual({
      kind: "message",
      text: expect.stringContaining("Привет."),
    });
  });
});
