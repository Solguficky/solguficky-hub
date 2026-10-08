import { describe, expect, it } from "vitest";
import { createUuidV7 } from "./uuid-v7.js";

describe("createUuidV7", () => {
  it("makes a canonical UUIDv7 with the time in front", () => {
    expect(createUuidV7(0x0192_9b7e_5c1d)).toMatch(
      /^01929b7e-5c1d-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
