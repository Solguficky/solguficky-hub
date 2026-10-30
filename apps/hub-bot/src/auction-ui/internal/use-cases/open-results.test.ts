import { describe, expect, it } from "vitest";
import { auctionResultsParagraphs } from "../../../auction-results.js";
import type { AuctionPort, LotView } from "../../ports.js";
import { openAuctionResults, RESULTS_SHOWN } from "./open-results.js";

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
  rights: ["place-bids"] as const,
};
const OTHER = "01929b7e-5c1d-7a3f-8e4b-000000000002";
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

const lotId = (n: number) =>
  `01929b7e-5c1d-7a3f-8e4b-${n.toString(16).padStart(12, "0")}`;

const lot = (n: number, status: LotView["status"]): LotView => ({
  lotId: lotId(n),
  auctionId: AUCTION_ID,
  version: 1,
  card: { title: `Лот ${n}`, description: "" },
  proxyEnabled: false,
  status,
});

function auctionOf(
  lots: readonly LotView[],
  names: () => Promise<Record<string, string>> = async () => ({
    [OTHER]: "Сыч*",
  }),
): AuctionPort {
  const refuse = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    findLot: async () => undefined,
    getLot: refuse,
    getOwnDisplayName: refuse,
    getDisplayNames: names,
    listLotHistory: refuse,
    placeBid: refuse,
    setProxyLimit: refuse,
    withdrawProxyLimit: refuse,
    chooseDisplayName: refuse,
    getAuction: async () => undefined,
    getRaffle: async () => undefined,
    listMyInvoices: async () => ({ invoices: [] }),
    getMyPredictions: async () => [],
    getPredictionResults: refuse,
    getDayChronicle: refuse,
    getAuctionChronicle: refuse,
    submitPrediction: refuse,
    registerForRaffle: refuse,
    cancelRaffleRegistration: refuse,
    listAuctionLots: async () => ({ lots, nextPageToken: "" }),
  };
}

const block = async (auction: AuctionPort) => {
  const body = await openAuctionResults({
    auction,
    viewer: VIEWER,
    auctionId: AUCTION_ID,
  });
  const [first] = body.blocks;
  if (first?.kind !== "auction-results") throw new Error("wrong block");
  return { first, body };
};

describe("auction results (PER-813)", () => {
  it("names sold lots, buyers and prices, dearest first", async () => {
    const { first, body } = await block(
      auctionOf([
        lot(1, { kind: "sold", winnerId: OTHER, price: rub(1000) }),
        lot(2, { kind: "sold", winnerId: VIEWER.identityId, price: rub(3000) }),
        lot(3, { kind: "unsold" }),
      ]),
    );
    expect(first.sold).toEqual([
      { lotId: lotId(2), title: "Лот 2", price: rub(3000), mine: true },
      {
        lotId: lotId(1),
        title: "Лот 1",
        price: rub(1000),
        winnerName: "Сыч*",
        mine: false,
      },
    ]);
    expect(first.total).toEqual(rub(4000));
    expect(first.unsoldCount).toBe(1);
    expect(body.keyboard.flat().map((button) => button.action)).toEqual([
      "results.back",
    ]);
  });

  it("keeps prices when the names are refused", async () => {
    const { first } = await block(
      auctionOf(
        [lot(1, { kind: "sold", winnerId: OTHER, price: rub(1000) })],
        async () => {
          throw new Error("names down");
        },
      ),
    );
    expect(first.sold[0]).toEqual({
      lotId: lotId(1),
      title: "Лот 1",
      price: rub(1000),
      mine: false,
    });
  });

  it("says nothing was sold", async () => {
    const { first } = await block(auctionOf([lot(1, { kind: "unsold" })]));
    expect(first.sold).toEqual([]);
    expect(first.total).toBeUndefined();
    expect(first.unsoldCount).toBe(1);
  });

  it("counts the lots over the screen limit instead of listing them", async () => {
    const many = Array.from({ length: RESULTS_SHOWN + 2 }, (_, index) =>
      lot(index + 1, { kind: "sold", winnerId: OTHER, price: rub(100) }),
    );
    const { first } = await block(auctionOf(many));
    expect(first.sold).toHaveLength(RESULTS_SHOWN);
    expect(first.hiddenSold).toBe(2);
    expect(first.total).toEqual(rub((RESULTS_SHOWN + 2) * 100));
  });

  it("shortens a long title so thirty lines fit one message", async () => {
    const long = "я".repeat(300);
    const { first } = await block(
      auctionOf([
        {
          ...lot(1, { kind: "sold", winnerId: OTHER, price: rub(1000) }),
          card: { title: long, description: "" },
        },
      ]),
    );
    const text = auctionResultsParagraphs(first, {
      money: () => "1 000 ₽",
    }).join("\n");
    expect(text.length).toBeLessThan(200);
  });
});
