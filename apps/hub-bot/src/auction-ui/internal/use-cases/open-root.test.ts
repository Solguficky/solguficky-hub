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
    withdrawProxyLimit: notUsed,
    setProxyLimit: notUsed,
    chooseDisplayName: notUsed,
    getAuction: async () => SUMMARY,
    getRaffle: async () => undefined,
    listMyInvoices: async () => ({ invoices: [] }),
    getMyPredictions: predictions,
    getPredictionResults: notUsed,
    getDayChronicle: notUsed,
    getAuctionChronicle: notUsed,
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
describe("root prediction results entry", () => {
  it("offers results only after the auction is finished", async () => {
    const running = await rootWith([
      { round: "catalog", status: "closed", answers: [] },
      { round: "final", status: "not-open", answers: [] },
    ]);
    const actions = running.keyboard.flat().map((button) => button.action);
    expect(actions).not.toContain("root.prediction-results");

    const finished = await openRoot({
      auction: {
        ...auctionOf(async () => [
          { round: "catalog", status: "closed", answers: [] },
          { round: "final", status: "not-open", answers: [] },
        ]),
        getAuction: async () => ({ ...SUMMARY, stage: "finished" }),
      },
      viewer: VIEWER,
      auctionId: AUCTION_ID,
    });
    expect(finished.keyboard[1]).toEqual([
      {
        action: "root.prediction-results",
        callbackData: encodeAuctionCallback({
          kind: "prediction-results",
          auctionId: AUCTION_ID,
        }),
      },
    ]);
  });

  // Без «Прогнозов» розыгрышу в пару идут «Итоги», а при обоих «Итоги» —
  // своим рядом под парой (PER-798).
  it("pairs the raffle with the results only without the predictions", async () => {
    const finishedWith = (rounds: readonly PredictionRoundView[]) =>
      openRoot({
        auction: {
          ...auctionOf(async () => rounds),
          getAuction: async () => ({ ...SUMMARY, stage: "finished" }),
          getRaffle: async () => ({
            auctionId: AUCTION_ID,
            status: "drawn",
            closesAt: "2026-10-29T18:00:00Z",
            commitment: "ab".repeat(32),
            beaconRound: 1,
            registered: false,
            tickets: [],
          }),
        },
        viewer: VIEWER,
        auctionId: AUCTION_ID,
      });
    const rows = (body: {
      keyboard: readonly (readonly { action: string }[])[];
    }) => body.keyboard.map((row) => row.map((button) => button.action));

    expect(rows(await finishedWith([])).slice(0, 2)).toEqual([
      ["root.lots"],
      ["root.raffle", "root.prediction-results"],
    ]);
    expect(
      rows(
        await finishedWith([
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
        ]),
      ).slice(0, 3),
    ).toEqual([
      ["root.lots"],
      ["root.raffle", "root.predictions"],
      ["root.prediction-results"],
    ]);
  });
});

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
      "root.day-chronicle",
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

  // PER-703: держатель `run_auctions` без `place_bids` получает от Auction
  // `PERMISSION_DENIED` на прогнозы, а корень ему открыт.
  it("opens the root without predictions when their read is refused", async () => {
    const body = await openRoot({
      auction: auctionOf(async () => {
        throw new Error("predictions unavailable");
      }),
      viewer: VIEWER,
      auctionId: AUCTION_ID,
    });

    expect(body.blocks).toEqual([
      { kind: "root", auctionId: AUCTION_ID, auction: SUMMARY },
    ]);
    expect(body.keyboard.flat().map((button) => button.action)).toEqual([
      "root.lots",
      "root.day-chronicle",
    ]);
  });
});

// Хроники дня (PER-725): вход есть, пока идёт онлайн-неделя — в торгах и в
// ожидании закрытия последних лотов, — и нет до неё и после.
describe("root day chronicle entry", () => {
  const stages: readonly AuctionSummaryView["stage"][] = [
    "draft",
    "scheduled",
    "prebidding",
    "settling",
    "on-break",
    "lineup-frozen",
    "in-final",
    "finished",
    "cancelled",
  ];

  it("offers the day chronicle only during the online week", async () => {
    const offered: AuctionSummaryView["stage"][] = [];
    for (const stage of stages) {
      const body = await openRoot({
        auction: {
          ...auctionOf(async () => []),
          getAuction: async () => ({ ...SUMMARY, stage }),
        },
        viewer: VIEWER,
        auctionId: AUCTION_ID,
      });
      const chronicle = body.keyboard
        .flat()
        .find((button) => button.action === "root.day-chronicle");
      if (chronicle === undefined) continue;
      offered.push(stage);
      expect(chronicle.callbackData).toBe(
        encodeAuctionCallback({ kind: "day-chronicle", auctionId: AUCTION_ID }),
      );
    }

    expect(offered).toEqual(["prebidding", "settling"]);
  });

  // Хроники читает держатель `place_bids`; держатель одного `run_auctions`
  // получил бы отказ Auction, и кнопки у него нет.
  it("offers no day chronicle to a viewer without place_bids", async () => {
    const body = await openRoot({
      auction: auctionOf(async () => []),
      viewer: { ...VIEWER, rights: ["run-auctions"] },
      auctionId: AUCTION_ID,
    });

    expect(body.keyboard.flat().map((button) => button.action)).not.toContain(
      "root.day-chronicle",
    );
  });
});

// Статистика аукциона (PER-770) из корня ушла ко всем (PER-800): она — вход
// пульта хаба, и корень не ставит её ни в одной стадии, даже ведущему.
describe("root auction chronicle entry", () => {
  const stages: readonly AuctionSummaryView["stage"][] = [
    "draft",
    "scheduled",
    "prebidding",
    "settling",
    "on-break",
    "lineup-frozen",
    "in-final",
    "finished",
    "cancelled",
  ];

  it("offers the statistics at no stage, even to the holder of run_auctions", async () => {
    for (const stage of stages) {
      const body = await openRoot({
        auction: {
          ...auctionOf(async () => []),
          getAuction: async () => ({ ...SUMMARY, stage }),
        },
        viewer: { ...VIEWER, rights: ["place-bids", "run-auctions"] },
        auctionId: AUCTION_ID,
      });
      const statistics = encodeAuctionCallback({
        kind: "auction-chronicle",
        auctionId: AUCTION_ID,
      });

      expect(
        body.keyboard.flat().map((button) => button.callbackData),
      ).not.toContain(statistics);
    }
  });
});
