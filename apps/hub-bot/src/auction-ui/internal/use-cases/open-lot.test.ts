import { describe, expect, it } from "vitest";
import type {
  AuctionPort,
  FavoritesPort,
  LotHistoryEntryView,
  LotView,
  Viewer,
} from "../../ports.js";
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
  withdrawProxyLimit: async () => {
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

// Ряд «Автоставка» лота, который ждёт финала (PER-821, ADR-079).
describe("proxy row of a lot waiting for the final", () => {
  const held = (over: Partial<LotView> = {}): LotView => ({
    lotId: LOT_ID,
    auctionId: AUCTION_ID,
    version: 4,
    card: { title: "Шарф", description: "" },
    proxyEnabled: true,
    status: { kind: "held", currentPrice: rub(900) },
    ...over,
  });
  const rowsOf = async (
    lot: LotView,
    viewer: Viewer | typeof VIEWER = VIEWER,
  ) => {
    const body = await showLot({ auction, viewer, lot, page: 0 });
    return body.keyboard
      .flat()
      .map((button) => button.action)
      .filter(
        (action) => action.startsWith("lot.bid") || action === "lot.proxy",
      );
  };

  it("offers only the proxy limit, to the leader too", async () => {
    expect(await rowsOf(held())).toEqual(["lot.proxy"]);
    expect(
      await rowsOf(
        held({
          status: {
            kind: "held",
            currentPrice: rub(900),
            leaderId: VIEWER.identityId,
          },
        }),
      ),
    ).toEqual(["lot.proxy"]);
  });

  it("offers nothing without the proxy, the right to bid or on a sold lot", async () => {
    expect(await rowsOf(held({ proxyEnabled: false }))).toEqual([]);
    expect(await rowsOf(held(), { ...VIEWER, rights: [] })).toEqual([]);
    expect(
      await rowsOf(
        held({ status: { kind: "sold", winnerId: LEADER, price: rub(900) } }),
      ),
    ).toEqual([]);
  });
});

// «Снять лимит» (PER-822): ряд только у лота с лимитом смотрящего, в торгах
// недели и в удержании.
describe("withdraw row", () => {
  const lot = (status: LotView["status"], limit?: boolean): LotView => ({
    lotId: LOT_ID,
    auctionId: AUCTION_ID,
    version: 4,
    card: { title: "Шарф", description: "" },
    proxyEnabled: true,
    ...(limit === false ? {} : { viewerProxyLimit: rub(2000) }),
    status,
  });
  const online: LotView["status"] = {
    kind: "trading",
    currentPrice: rub(900),
    phase: "online",
  };
  const live: LotView["status"] = {
    kind: "trading",
    currentPrice: rub(900),
    phase: "live",
  };
  const held: LotView["status"] = { kind: "held", currentPrice: rub(900) };
  const hasWithdraw = async (view: LotView) => {
    const body = await showLot({ auction, viewer: VIEWER, lot: view, page: 0 });
    return body.keyboard.flat().some((b) => b.action === "lot.withdraw");
  };

  it("is shown for an own limit online and on hold", async () => {
    expect(await hasWithdraw(lot(online))).toBe(true);
    expect(await hasWithdraw(lot(held))).toBe(true);
  });

  it("is absent without an own limit (a rival's limit never reaches the card)", async () => {
    expect(await hasWithdraw(lot(online, false))).toBe(false);
    expect(await hasWithdraw(lot(held, false))).toBe(false);
  });

  it("is absent in the live final", async () => {
    expect(await hasWithdraw(lot(live))).toBe(false);
  });
});

// «Мои счета» на карточке проданного лота (PER-813): только покупателю.
describe("sold lot invoices entry", () => {
  const soldTo = (winnerId: string): LotView => ({
    lotId: LOT_ID,
    auctionId: AUCTION_ID,
    version: 4,
    card: { title: "Кружка", description: "" },
    proxyEnabled: false,
    status: { kind: "sold", winnerId, price: rub(1200) },
  });
  const actionsFor = async (winnerId: string) =>
    (
      await showLot({
        auction,
        viewer: VIEWER,
        lot: soldTo(winnerId),
        page: 0,
      })
    ).keyboard
      .flat()
      .map((button) => button.action);

  it("gives the winner a way to the invoices", async () => {
    expect(await actionsFor(VIEWER.identityId)).toContain("lot.invoices");
  });

  it("does not show the button to anyone else", async () => {
    expect(await actionsFor(LEADER)).not.toContain("lot.invoices");
  });
});

// PER-840: карточка называет рост цены от автоставок, когда последняя ставка
// хронологии — прокси после чужой ставки. Первая ставка лота прокси «подъёмом»
// не считается, а сбой чтения хронологии строку убирает.
describe("price raised by proxies", () => {
  const trading = lots.find(
    ([name]) => name === "trading online",
  )?.[1] as LotView;
  const bid = (
    sequence: number,
    origin: "proxy" | "manual",
  ): LotHistoryEntryView => ({
    kind: "bid",
    sequence,
    occurredAt: "2026-10-20T15:00:00Z",
    bidId: `bid-${sequence}`,
    participantId: LEADER,
    amount: rub(1000 + sequence * 100),
    origin:
      origin === "proxy"
        ? { kind: "proxy" }
        : { kind: "manual", source: "bot" },
  });
  const cardWith = async (
    listLotHistory: AuctionPort["listLotHistory"],
  ): Promise<boolean | undefined> => {
    const body = await showLot({
      auction: { ...auction, listLotHistory },
      favorites,
      viewer: VIEWER,
      lot: trading,
      page: 0,
    });
    const [block] = body.blocks;
    return block?.kind === "lot" ? block.autoRaised === true : undefined;
  };
  const history =
    (...entries: LotHistoryEntryView[]) =>
    async () => ({
      entries,
      nextPageToken: "",
    });

  it("is flagged when the last bid is a proxy after another bid", async () => {
    expect(await cardWith(history(bid(1, "manual"), bid(2, "proxy")))).toBe(
      true,
    );
  });

  it("is not flagged when the last bid is manual", async () => {
    expect(await cardWith(history(bid(1, "proxy"), bid(2, "manual")))).toBe(
      false,
    );
  });

  it("is not flagged for a lone first proxy bid", async () => {
    expect(await cardWith(history(bid(1, "proxy")))).toBe(false);
  });

  it("drops the line when the history is unreadable", async () => {
    expect(
      await cardWith(async () => {
        throw new Error("unavailable");
      }),
    ).toBe(false);
  });
});
