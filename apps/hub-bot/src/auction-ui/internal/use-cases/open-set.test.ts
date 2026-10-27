import { describe, expect, it } from "vitest";
import type { AuctionPort, LotView } from "../../ports.js";
import { openSet } from "./open-set.js";

// Экран сета (ADR-073, п. 7): лоты сета по порядку организатора, а собравший
// приходит после итога. Сет читается из снимка лота, с которого открыли экран.

const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-000000000001";
const OTHER_ID = "01929b7e-5c1d-7a3f-8e4b-000000000002";
const GONE_ID = "01929b7e-5c1d-7a3f-8e4b-000000000003";
const VIEWER = {
  identityId: "01929b7e-5c1d-7a3f-8e4b-0000000000b1",
  rights: ["place-bids"] as const,
};
const lot = (lotId: string, title: string): LotView => ({
  lotId,
  auctionId: AUCTION_ID,
  version: 1,
  card: { title, description: "" },
  proxyEnabled: false,
  status: { kind: "unsold" },
});

const setLot: LotView = {
  ...lot(LOT_ID, "Кружка"),
  lotSet: {
    name: "Лесные дары",
    lotIds: [LOT_ID, OTHER_ID, GONE_ID],
  },
};

const other: LotView = lot(OTHER_ID, "Плакат");

const port = (overrides: Partial<AuctionPort> = {}): AuctionPort => ({
  findLot: async () => undefined,
  getLot: async () => {
    throw new Error("not used");
  },
  getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
  getDisplayNames: async () => ({}),
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
  listMyInvoices: async () => ({ invoices: [] }),
  chooseFulfillment: async () => {
    throw new Error("not used");
  },
  getMyPredictions: async () => [],
  getPredictionResults: async () => {
    throw new Error("not used");
  },
  getDayChronicle: async () => {
    throw new Error("not used");
  },
  getAuctionChronicle: async () => {
    throw new Error("not used");
  },
  submitPrediction: async () => {
    throw new Error("not used");
  },
  ...overrides,
});

describe("openSet", () => {
  it("lists the lots of the set in the order of the organizer", async () => {
    const body = await openSet({
      auction: port({
        getLot: async () => setLot,
        findLot: async ({ lotId }) => (lotId === OTHER_ID ? other : undefined),
      }),
      viewer: VIEWER,
      lotId: LOT_ID,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "set") throw new Error("no set block");
    expect(block.name).toBe("Лесные дары");
    expect(block.lots.map((item) => item.lotId)).toEqual([LOT_ID, OTHER_ID]);
  });

  // Лот, которого Auction больше не знает, выпадает: сет из таких лотов
  // участнику не показывается (ADR-073, п. 3).
  it("drops a lot of the set that Auction does not know", async () => {
    const body = await openSet({
      auction: port({
        getLot: async () => setLot,
        findLot: async () => undefined,
      }),
      viewer: VIEWER,
      lotId: LOT_ID,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "set") throw new Error("no set block");
    expect(block.lots.map((item) => item.lotId)).toEqual([LOT_ID]);
  });

  // Отказ чтения лота сета не выпадает, а роняет экран: показать состав
  // неполным без признака сбоя хуже, чем сказать «недоступно».
  it("fails the screen when a lot of the set cannot be read", async () => {
    await expect(
      openSet({
        auction: port({
          getLot: async () => setLot,
          findLot: async () => {
            throw new Error("auction is unavailable");
          },
        }),
        viewer: VIEWER,
        lotId: LOT_ID,
        page: 0,
      }),
    ).rejects.toThrow("auction is unavailable");
  });

  // Предел экрана: сет длиннее восьми лотов показан частично, а остальные
  // посчитаны строкой «И ещё N.» (дизайн-код, «Лоты сета»).
  it("shows eight lots of a longer set and counts the rest", async () => {
    const many = Array.from(
      { length: 10 },
      (_, n) => `01929b7e-5c1d-7a3f-8e4b-00000000${String(n).padStart(4, "0")}`,
    );
    const body = await openSet({
      auction: port({
        getLot: async () => ({
          ...lot(many[0] as string, "Кружка"),
          lotSet: { name: "Лесные дары", lotIds: many },
        }),
        findLot: async ({ lotId }) => lot(lotId, "Плакат"),
      }),
      viewer: VIEWER,
      lotId: many[0] as string,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "set") throw new Error("no set block");
    expect(block.lots).toHaveLength(8);
    expect(block.more).toBe(2);
  });

  // Сет исчез, а экран висел: показывается карточка лота, с которой его
  // открывали.
  it("falls back to the card of the lot when the set is gone", async () => {
    const body = await openSet({
      auction: port({ getLot: async () => lot(LOT_ID, "Кружка") }),
      viewer: VIEWER,
      lotId: LOT_ID,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "lot") throw new Error("no lot block");
    expect(block.lotId).toBe(LOT_ID);
  });

  // Неполный сет — меньше чем два лота — участнику не показывается
  // (ADR-073, п. 3): показывается карточка лота.
  it("falls back to the card of the lot when the set is incomplete", async () => {
    const body = await openSet({
      auction: port({
        getLot: async () => ({
          ...lot(LOT_ID, "Кружка"),
          lotSet: { name: "Лесные дары", lotIds: [LOT_ID] },
        }),
      }),
      viewer: VIEWER,
      lotId: LOT_ID,
      page: 0,
    });
    const [block] = body.blocks;
    if (block?.kind !== "lot") throw new Error("no lot block");
    expect(block.lotId).toBe(LOT_ID);
  });
});
