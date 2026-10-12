import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AuctionState_DraftSchema,
  AuctionState_PrebiddingSchema,
} from "../../../gen/auction/v1/auction_events_pb.js";
import {
  AuctionConfigSchema,
  OnlinePhaseSchema,
} from "../../../gen/auction/v1/auction_pb.js";
import { AuctionSnapshotSchema } from "../../../gen/auction/v1/auction_service_pb.js";
import { auctionSummaryViewOf } from "./auction.js";

const AUCTION_ID = "daef05c7-cd68-5048-b03d-cb4860e8dc73";

// Снимок аукциона для его корня (PER-605): стадия, сроки онлайн-торгов и финал.
describe("auction snapshot for the root", () => {
  it("reads the stage, the online phase and the final of a running auction", () => {
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          config: create(AuctionConfigSchema, {
            onlinePhase: create(OnlinePhaseSchema, {
              opensAt: "2026-10-26T09:00:00Z",
              closesAt: "2026-10-29T18:00:00Z",
            }),
            finalBlocks: 1,
          }),
          status: {
            case: "prebidding",
            value: create(AuctionState_PrebiddingSchema, {}),
          },
        }),
      ),
    ).toEqual({
      auctionId: AUCTION_ID,
      stage: "prebidding",
      opensAt: "2026-10-26T09:00:00Z",
      closesAt: "2026-10-29T18:00:00Z",
      final: true,
    });
  });

  it("reads a draft without config as a stage without dates", () => {
    expect(
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toEqual({ auctionId: AUCTION_ID, stage: "draft", final: false });
  });

  // Дефект соседа — отказ перевода, а не корень с выдуманной стадией.
  it("throws on a snapshot without a status, an id or an instant it cannot read", () => {
    expect(() =>
      auctionSummaryViewOf(create(AuctionSnapshotSchema, { id: AUCTION_ID })),
    ).toThrow("auction snapshot without status");
    expect(() =>
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: "not-a-uuid",
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toThrow("auction id is not a canonical UUID");
    expect(() =>
      auctionSummaryViewOf(
        create(AuctionSnapshotSchema, {
          id: AUCTION_ID,
          config: create(AuctionConfigSchema, {
            onlinePhase: create(OnlinePhaseSchema, { opensAt: "soon" }),
          }),
          status: {
            case: "draft",
            value: create(AuctionState_DraftSchema, {}),
          },
        }),
      ),
    ).toThrow("auction online phase start is not an instant");
  });
});
