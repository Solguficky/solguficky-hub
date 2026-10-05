import { describe, expect, it } from "vitest";
import { newLotId, newLotIdOf, newLotKey } from "./new-lot-id.js";

// Auction принимает `lot_id` только каноническим UUIDv7 (`RequestMapping`).
const canonicalUuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("new lot id", () => {
  it("keeps the time, the version and the variant of the UUIDv7 and zeroes its tail", () => {
    const id = newLotId("01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c");

    expect(id).toBe("01929b7e-5c1d-7a3f-8e00-000000000000");
    expect(id).toMatch(canonicalUuidV7);
  });

  it("is restored whole from the creation key its question carries", () => {
    for (const uuid of [
      "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
      "ffffffff-ffff-7fff-bfff-ffffffffffff",
      "00000000-0000-7000-8000-000000000000",
    ]) {
      const id = newLotId(uuid);
      const key = newLotKey(id);

      expect(key).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(newLotIdOf(key)).toBe(id);
    }
  });

  it("orders new lots by the time of their creation, as the feed of the auction does", () => {
    const earlier = newLotId("01929b7e-5c1d-7fff-bfff-ffffffffffff");
    const later = newLotId("01929b7e-5c1e-7000-8000-000000000000");

    expect(earlier < later).toBe(true);
  });
});
