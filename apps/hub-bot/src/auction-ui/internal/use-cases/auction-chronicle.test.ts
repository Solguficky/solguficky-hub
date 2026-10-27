import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import type {
  AuctionChronicleView,
  AuctionPort,
  LotView,
} from "../../ports.js";
import { openAuctionChronicle } from "./auction-chronicle.js";

// Статистика аукциона (PER-770) открывается только в хабе держателю
// `run_auctions` (PER-800), поэтому общая таблица контракта двух поверхностей
// её не гоняет: тело проверяется здесь, а допуск — тестом шлюза и матрицей.

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const MUG = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const POSTER = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
const QUIET = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  rights: ["access-hub", "place-bids", "run-auctions"] as const,
};

const notUsed = async (): Promise<never> => {
  throw new Error("not used");
};

const lotOf = (lotId: string, title: string): LotView => ({
  lotId,
  auctionId: AUCTION_ID,
  version: 1,
  card: { title, description: "" },
  proxyEnabled: false,
  status: { kind: "withdrawn" },
});

const LOTS = new Map([
  [MUG, lotOf(MUG, "Кружка с совой")],
  [POSTER, lotOf(POSTER, "Плакат")],
]);

function open(chronicle: AuctionChronicleView) {
  const reads: string[] = [];
  const auction: AuctionPort = {
    findLot: async ({ lotId }) => {
      reads.push(lotId);
      return LOTS.get(lotId);
    },
    getLot: notUsed,
    getOwnDisplayName: notUsed,
    getDisplayNames: notUsed,
    listLotHistory: notUsed,
    placeBid: notUsed,
    setProxyLimit: notUsed,
    chooseDisplayName: notUsed,
    getAuction: notUsed,
    getRaffle: notUsed,
    listMyInvoices: notUsed,
    chooseFulfillment: notUsed,
    getMyPredictions: notUsed,
    getPredictionResults: notUsed,
    getDayChronicle: notUsed,
    getAuctionChronicle: async (request) => {
      expect(request).toEqual({ viewer: VIEWER, auctionId: AUCTION_ID });
      return chronicle;
    },
    submitPrediction: notUsed,
    registerForRaffle: notUsed,
    cancelRaffleRegistration: notUsed,
    listAuctionLots: notUsed,
  };
  const body = openAuctionChronicle(
    {
      auction,
      operations: {
        newOperationId: () => "01929b7e-5c1d-7a3f-8e4b-00000000c001",
      },
      viewer: VIEWER,
      user: { telegramUserId: 424242 },
    },
    AUCTION_ID,
  );
  return { body, reads };
}

const back = [
  [
    {
      action: "auction-chronicle.back",
      callbackData: encodeAuctionCallback({
        kind: "root",
        auctionId: AUCTION_ID,
      }),
    },
  ],
];

describe("auction chronicle", () => {
  it("counts the trading and names the record and the nominees", async () => {
    const { body, reads } = open({
      bidCount: 14,
      participantCount: 5,
      tradedLotCount: 2,
      growthRecord: {
        lotId: POSTER,
        growth: { minorUnits: 50_000, currency: "RUB" },
      },
      lots: [
        // Спорнее всех и дуэль: пять смен лидера, четыре подряд вдвоём.
        { lotId: MUG, bidCount: 9, leaderChanges: 5, longestDuel: 4 },
        // Рекорд роста — тот, что выбрал Auction.
        { lotId: POSTER, bidCount: 5, leaderChanges: 1, longestDuel: 1 },
        // Без ставок лот не номинируется и не читается.
        { lotId: QUIET, bidCount: 0, leaderChanges: 0, longestDuel: 0 },
      ],
    });

    expect(await body).toEqual({
      blocks: [
        {
          kind: "auction-chronicle",
          auctionId: AUCTION_ID,
          chronicle: {
            kind: "counted",
            bidCount: 14,
            participantCount: 5,
            tradedLotCount: 2,
            lotCount: 3,
            growthRecord: {
              title: "Плакат",
              growth: { minorUnits: 50_000, currency: "RUB" },
            },
            contested: { title: "Кружка с совой", leaderChanges: 5 },
            duel: { title: "Кружка с совой", longestDuel: 4 },
          },
        },
      ],
      keyboard: back,
    });
    // Каждое название — один раз, и только у названных лотов.
    expect(reads).toEqual([POSTER, MUG]);
  });

  it("keeps the counters alone without a nominee", async () => {
    const { body, reads } = open({
      bidCount: 1,
      participantCount: 1,
      tradedLotCount: 1,
      lots: [{ lotId: MUG, bidCount: 1, leaderChanges: 0, longestDuel: 0 }],
    });

    expect((await body).blocks).toEqual([
      {
        kind: "auction-chronicle",
        auctionId: AUCTION_ID,
        chronicle: {
          kind: "counted",
          bidCount: 1,
          participantCount: 1,
          tradedLotCount: 1,
          lotCount: 1,
        },
      },
    ]);
    expect(reads).toEqual([]);
  });

  it("says there were no bids or no lots", async () => {
    const noBids = open({
      bidCount: 0,
      participantCount: 0,
      tradedLotCount: 0,
      lots: [{ lotId: MUG, bidCount: 0, leaderChanges: 0, longestDuel: 0 }],
    });
    const noLots = open({
      bidCount: 0,
      participantCount: 0,
      tradedLotCount: 0,
      lots: [],
    });

    expect((await noBids.body).blocks[0]).toMatchObject({
      chronicle: { kind: "no-bids" },
    });
    expect((await noLots.body).blocks[0]).toMatchObject({
      chronicle: { kind: "no-lots" },
    });
  });
});
