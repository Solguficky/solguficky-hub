import { describe, expect, it } from "vitest";
import type { AuctionPort, FavoritesPort, LotView } from "../../ports.js";
import { previewLot, showLot } from "./open-lot.js";

// Предпросмотр лота (PER-512): блок тот же, что у карточки участника, на
// каждом виде статуса, а кнопок нет. Состояние смотрящего — лимит и отметка —
// в предпросмотр не попадает: он показывает нейтрального участника.

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-000000000001";
const LEADER = "01929b7e-5c1d-7a3f-8e4b-0000000000b1";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-000000000002",
  rights: ["place-bids"] as const,
};
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

const auction: AuctionPort = {
  findLot: async () => undefined,
  getLot: async () => {
    throw new Error("not used");
  },
  getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
  getDisplayNames: async ({ participantIds }) =>
    Object.fromEntries(participantIds.map((id) => [id, "Сова"])),
  listLotHistory: async () => {
    throw new Error("not used");
  },
  placeBid: async () => {
    throw new Error("not used");
  },
  setProxyLimit: async () => {
    throw new Error("not used");
  },
  chooseDisplayName: async () => {
    throw new Error("not used");
  },
  listAuctionLots: async () => {
    throw new Error("not used");
  },
  getAuction: async () => undefined,
  getRaffle: async () => undefined,
  registerForRaffle: async () => {
    throw new Error("not used");
  },
  cancelRaffleRegistration: async () => {
    throw new Error("not used");
  },
  getMyPredictions: async () => [],
  getPredictionResults: async () => {
    throw new Error("not used");
  },
  submitPrediction: async () => {
    throw new Error("not used");
  },
};

const favorites: FavoritesPort = {
  followLot: async () => {
    throw new Error("not used");
  },
  unfollowLot: async () => {
    throw new Error("not used");
  },
  listFollowedLots: async () => [LOT_ID],
};

const base: LotView = {
  lotId: LOT_ID,
  auctionId: AUCTION_ID,
  version: 3,
  card: {
    title: "Ваза",
    description: "Синяя.\n\nС трещиной.",
    image: { version: "2" },
  },
  proxyEnabled: true,
  status: { kind: "draft" },
};

const window = {
  from: "2026-10-20T15:00:00Z",
  until: "2026-10-20T16:00:00Z",
  step: rub(50),
};

const lots: [string, LotView][] = [
  ["draft", base],
  [
    "without a card",
    {
      lotId: LOT_ID,
      auctionId: AUCTION_ID,
      version: 1,
      proxyEnabled: false,
      status: { kind: "draft" },
    },
  ],
  [
    "scheduled",
    {
      ...base,
      fixedStep: rub(100),
      status: {
        kind: "scheduled",
        startingPrice: rub(1000),
      },
    },
  ],
  [
    "trading online",
    {
      ...base,
      nextPrice: rub(1200),
      baseStep: rub(100),
      activeWindow: window,
      nextWindow: { ...window, step: rub(20) },
      viewerProxyLimit: rub(5000),
      status: {
        kind: "trading",
        currentPrice: rub(1100),
        leaderId: LEADER,
        deadline: "2026-10-27T00:00:00Z",
        phase: "online",
      },
    },
  ],
  [
    "sold",
    {
      ...base,
      status: { kind: "sold", winnerId: LEADER, price: rub(3000) },
    },
  ],
  [
    "held",
    {
      ...base,
      status: { kind: "held", currentPrice: rub(1500), leaderId: LEADER },
    },
  ],
  ["unsold", { ...base, status: { kind: "unsold" } }],
  ["withdrawn", { ...base, status: { kind: "withdrawn" } }],
];

describe("lot preview", () => {
  it.each(lots)(
    "shows the participant's lot block without buttons: %s",
    async (_, lot) => {
      const card = await showLot({
        auction,
        favorites,
        viewer: VIEWER,
        lot,
        page: 0,
      });
      const preview = await previewLot({ auction, viewer: VIEWER, lot });
      const [shown] = card.blocks;
      if (shown?.kind !== "lot") throw new Error("no lot block");
      const {
        viewerProxyLimit: _limit,
        following: _following,
        ...neutral
      } = shown;
      expect(preview.blocks).toEqual([neutral]);
      expect(preview.keyboard).toEqual([]);
    },
  );

  it("names the leader as the card does", async () => {
    const [, trading] = lots.find(([name]) => name === "trading online") ?? [];
    if (trading === undefined) throw new Error("no trading lot");
    const preview = await previewLot({ auction, viewer: VIEWER, lot: trading });
    expect(preview.blocks[0]).toMatchObject({ participantName: "Сова" });
  });
});
