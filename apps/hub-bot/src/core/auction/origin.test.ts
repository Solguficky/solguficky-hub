import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../auction-ui/index.js";
import { auctionRootFrom } from "./origin.js";

const auctionId = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
describe("auction return after a process restart", () => {
  it("recovers the auction from the existing card keyboard", () => {
    const root = encodeAuctionCallback({ kind: "root", auctionId });
    expect(
      auctionRootFrom([
        "garbage",
        encodeAuctionCallback({ kind: "feed", auctionId, page: 3 }),
      ]),
    ).toBe(root);
    expect(auctionRootFrom([root])).toBe(root);
    expect(auctionRootFrom(["garbage"])).toBeUndefined();
  });
});
