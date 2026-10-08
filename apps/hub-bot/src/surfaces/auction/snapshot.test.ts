import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AuctionSnapshotSchema } from "../../../gen/auction/v1/auction_service_pb.js";
import { auctionSummaryOf } from "./snapshot.js";

describe("auctionSummaryOf", () => {
  const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
  const snapshot = (fields: Record<string, unknown>) =>
    create(AuctionSnapshotSchema, {
      id: auctionId,
      lotIds: ["lot-1", "lot-2"],
      status: { case: "prebidding", value: {} },
      ...fields,
    });

  it("reads the start of the online phase, the stage and the lot count", () => {
    expect(
      auctionSummaryOf(
        snapshot({
          config: { onlinePhase: { opensAt: "2026-10-10T16:00:00Z" } },
          status: { case: "onBreak", value: {} },
        }),
      ),
    ).toEqual({
      auctionId,
      stage: "on-break",
      opensAt: "2026-10-10T16:00:00Z",
      lotCount: 2,
    });
    expect(auctionSummaryOf(snapshot({}))).not.toHaveProperty("opensAt");
  });

  it.each([
    ["a draft", { status: { case: "draft", value: {} } }],
    ["no status", { status: { case: undefined } }],
    ["a non-canonical id", { id: "DAEF05C7-CD68-5048-B03D-CB4860E8DC73" }],
    [
      "a broken online phase start",
      { config: { onlinePhase: { opensAt: "soon" } } },
    ],
  ])("refuses %s", (_name, fields) => {
    expect(() => auctionSummaryOf(snapshot(fields))).toThrow();
  });
});
