import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { GetAuctionDayChronicleResponseSchema } from "../../../gen/auction/v1/auction_service_pb.js";
import { dayChronicleOf } from "./day-chronicle.js";

const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";

describe("dayChronicleOf", () => {
  it("maps the window aggregates and the lifetime counts of every lot", () => {
    expect(
      dayChronicleOf(
        create(GetAuctionDayChronicleResponseSchema, {
          from: "2026-10-26T12:00:00Z",
          until: "2026-10-27T12:00:00Z",
          lots: [
            {
              day: {
                lotId,
                bidCount: 4n,
                leaderChangeCount: 5n,
                longestDuel: 3n,
                maxPrice: { minorUnits: 45_000n, currency: "RUB" },
              },
              bidCount: 6n,
              priceGrowth: { minorUnits: 15_000n, currency: "RUB" },
            },
            { day: { lotId: "quiet" }, bidCount: 0n },
          ],
        }),
      ),
    ).toEqual({
      lots: [
        {
          lotId,
          bidCount: 4,
          leaderChanges: 5,
          longestDuel: 3,
          totalBidCount: 6,
          priceGrowth: { minorUnits: 15_000, currency: "RUB" },
        },
        {
          lotId: "quiet",
          bidCount: 0,
          leaderChanges: 0,
          longestDuel: 0,
          totalBidCount: 0,
        },
      ],
    });
  });

  it("refuses a lot without window aggregates and a count out of range", () => {
    expect(() =>
      dayChronicleOf(
        create(GetAuctionDayChronicleResponseSchema, {
          lots: [{ bidCount: 1n }],
        }),
      ),
    ).toThrow("day chronicle lot without window aggregates");
    expect(() =>
      dayChronicleOf(
        create(GetAuctionDayChronicleResponseSchema, {
          lots: [{ day: { lotId, bidCount: -1n } }],
        }),
      ),
    ).toThrow("day chronicle bid count out of range");
  });
});
