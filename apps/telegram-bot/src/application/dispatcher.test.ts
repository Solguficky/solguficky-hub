import { describe, expect, it } from "vitest";
import { createDispatcher } from "./dispatcher.js";

describe("dispatcher", () => {
  it("runs acknowledge without telegram types", () => {
    const dispatcher = createDispatcher();
    const result = dispatcher.execute({
      identity: {
        identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
        globalRoles: [],
      },
      intent: "acknowledge",
    });
    expect(result).toEqual({ kind: "stub", text: "заглушка" });
  });
});
