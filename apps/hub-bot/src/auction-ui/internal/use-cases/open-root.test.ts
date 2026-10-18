import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  AuctionPort,
  AuctionSummaryView,
  PredictionRoundView,
} from "../../ports.js";
import { openRoot } from "./open-root.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  rights: ["place-bids"] as const,
};
const SUMMARY: AuctionSummaryView = {
  auctionId: AUCTION_ID,
  stage: "prebidding",
  final: true,
};

const notUsed = async (): Promise<never> => {
  throw new Error("not used");
};

function auctionOf(
  predictions: () => Promise<readonly PredictionRoundView[]>,
): AuctionPort {
  return {
    findLot: async () => undefined,
    getLot: notUsed,
    getOwnDisplayName: notUsed,
    getDisplayNames: notUsed,
    listLotHistory: notUsed,
    placeBid: notUsed,
    setProxyLimit: notUsed,
    chooseDisplayName: notUsed,
    getAuction: async () => SUMMARY,
    getRaffle: async () => undefined,
    getMyPredictions: predictions,
    submitPrediction: notUsed,
    registerForRaffle: notUsed,
    cancelRaffleRegistration: notUsed,
    listAuctionLots: notUsed,
  };
}

const rootWith = (rounds: readonly PredictionRoundView[]) =>
  openRoot({
    auction: auctionOf(async () => rounds),
    viewer: VIEWER,
    auctionId: AUCTION_ID,
  });

const predictionsRow = (round: PredictionRoundView["round"]) => [
  {
    action: "root.predictions",
    callbackData: encodeAuctionCallback({
      kind: "prediction",
      auctionId: AUCTION_ID,
      round,
    }),
  },
];

// Вход в прогнозы стоит в корне аукциона своим рядом под лотами (PER-489):
// лента после PER-644 — только список лотов.
describe("root predictions entry", () => {
  it("offers predictions under the lots while a round is open", async () => {
    const body = await rootWith([
      { round: "catalog", status: "open", answers: [] },
      { round: "final", status: "not-open", answers: [] },
    ]);

    expect(body.keyboard[1]).toEqual(predictionsRow("catalog"));
  });

  it("opens the final round when it is the active round", async () => {
    const body = await rootWith([
      { round: "catalog", status: "closed", answers: [] },
      { round: "final", status: "open", answers: [] },
    ]);

    expect(body.keyboard[1]).toEqual(predictionsRow("final"));
  });

  it("keeps access to a closed forecast but hides an empty, unopened game", async () => {
    const fixed = await rootWith([
      {
        round: "catalog",
        status: "closed",
        answers: [
          {
            nomination: "catalog-total-sales",
            answer: { kind: "number", value: 120_000 },
          },
        ],
      },
      { round: "final", status: "not-open", answers: [] },
    ]);
    const unopened = await rootWith([
      { round: "catalog", status: "not-open", answers: [] },
      { round: "final", status: "not-open", answers: [] },
    ]);

    expect(fixed.keyboard[1]).toEqual(predictionsRow("catalog"));
    expect(unopened.keyboard.flat().map((button) => button.action)).toEqual([
      "root.lots",
    ]);
  });

  it("shows a gone auction although the prediction read is refused", async () => {
    const gone: AuctionPort = {
      ...auctionOf(async () => {
        throw new Error("auction not found");
      }),
      getAuction: async () => undefined,
    };

    const body = await openRoot({
      auction: gone,
      viewer: VIEWER,
      auctionId: AUCTION_ID,
    });

    expect(body).toEqual({
      blocks: [{ kind: "root", auctionId: AUCTION_ID }],
      keyboard: [],
    });
  });

  it("propagates prediction read failures to the boundary", async () => {
    await expect(
      openRoot({
        auction: auctionOf(async () => {
          throw new Error("predictions unavailable");
        }),
        viewer: VIEWER,
        auctionId: AUCTION_ID,
      }),
    ).rejects.toThrow("predictions unavailable");
  });
});
