import { describe, expect, it } from "vitest";
import {
  ApplicationQueue as WireQueue,
  AccessRight as WireRight,
} from "../../../gen/identity/v1/access_pb.js";
import { rightsOf, wireQueue } from "./access.js";

describe("identity access vocabulary", () => {
  it("names every right of the contract", () => {
    expect(
      rightsOf([
        WireRight.ACCESS_HUB,
        WireRight.PLACE_BIDS,
        WireRight.MANAGE_MEMBERS,
        WireRight.ADMIT_BIDDERS,
        WireRight.MANAGE_MEETUPS,
        WireRight.GRANT_ADMINS,
      ]),
    ).toEqual([
      "access-hub",
      "place-bids",
      "manage-members",
      "admit-bidders",
      "manage-meetups",
      "grant-admins",
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
