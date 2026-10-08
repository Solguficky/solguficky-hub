import { describe, expect, it } from "vitest";
import {
  ApplicationQueue as WireQueue,
  AccessRight as WireRight,
} from "../../../gen/identity/v1/roles_pb.js";
import { rightsOf, wireQueue } from "./access.js";

describe("identity access vocabulary", () => {
  it("names every right of the contract", () => {
    expect(
      rightsOf([
        WireRight.HUB,
        WireRight.AUCTION,
        WireRight.MANAGE_MEMBERSHIP,
        WireRight.MODERATE_AUCTION,
        WireRight.MANAGE_AUCTION,
      ]),
    ).toEqual([
      "hub",
      "auction",
      "manage-membership",
      "moderate-auction",
      "manage-auction",
    ]);
  });

  // Незнакомое право по контракту ничего не даёт: допуска оно не открывает.
  it("drops an unset or unknown right", () => {
    expect(rightsOf([WireRight.UNSPECIFIED, 99 as WireRight])).toEqual([]);
  });

  it("sends each surface queue by its wire value", () => {
    expect(wireQueue("community")).toBe(WireQueue.COMMUNITY);
    expect(wireQueue("auction")).toBe(WireQueue.AUCTION);
  });
});
