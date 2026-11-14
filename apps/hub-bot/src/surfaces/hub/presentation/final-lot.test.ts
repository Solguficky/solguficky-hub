import { describe, expect, it } from "vitest";
import type {
  AuctionSummaryView,
  LotView,
  Viewer,
} from "../../../auction-ui/index.js";
import type { Person } from "../application/types.js";
import type { MeetupAuctionResult } from "../auction/port.js";
import {
  finalLotWhisper,
  finalUnavailableText,
  noFinalText,
  openInBotLabel,
  readFinalLot,
} from "./final-lot.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Лот живого финала шёпотом (PER-685; ADR-078, п. 4): название и цена, без
// имени лидера, и вход в бот хаба на карточку лота.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const leaderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
const person: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "place-bids"],
};
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });
// Сумму `Intl` пишет с неразрывными пробелами.
const plain = (text: string) => text.replace(/[  ]/g, " ");

const tradingLot: LotView = {
  lotId,
  auctionId,
  version: 4,
  card: { title: "Кружка <с совой>", description: "Ручная роспись." },
  proxyEnabled: true,
  status: {
    kind: "trading",
    currentPrice: rub(1200),
    leaderId,
    phase: "live",
  },
};

function summary(over: Partial<AuctionSummaryView> = {}): AuctionSummaryView {
  return {
    auctionId,
    stage: "in-final",
    final: true,
    lineup: { order: [lotId], activeLotId: lotId },
    ...over,
  };
}

function read(
  current: MeetupAuctionResult,
  lot: () => Promise<LotView> = async () => tradingLot,
) {
  const asked: { viewer?: Viewer; lotId?: string } = {};
  const result = readFinalLot({
    auctions: { currentAuction: async () => current },
    lots: {
      getLot: async (request) => {
        asked.viewer = request.viewer;
        asked.lotId = request.lotId;
        return lot();
      },
    },
    person,
  });
  return { result, asked };
}

describe("readFinalLot", () => {
  it("reads the active lot of the live final with the person's own rights", async () => {
    const { result, asked } = read({
      kind: "ok",
      auctionId,
      auction: summary(),
    });
    expect(await result).toEqual({
      kind: "lot",
      lot: {
        lotId,
        title: "Кружка <с совой>",
        status: tradingLot.status,
      },
    });
    expect(asked).toEqual({
      viewer: { identityId: person.identityId, rights: person.rights },
      lotId,
    });
  });

  it("answers no final without an auction, before the final and for a hidden auction", async () => {
    for (const current of [
      { kind: "ok" } as const,
      { kind: "ok", auctionId, auction: summary({ stage: "prebidding" }) },
      { kind: "ok", auctionId, auction: summary({ stage: "lineup-frozen" }) },
      { kind: "ok", auctionId, auction: summary({ stage: "finished" }) },
      { kind: "ok", auctionId, auction: summary({ hidden: true }) },
    ] satisfies MeetupAuctionResult[]) {
      const { result, asked } = read(current);
      expect(await result).toEqual({ kind: "no-final" });
      expect(asked).toEqual({});
    }
  });

  it("tells the final is between lots when no lot is active", async () => {
    const { result, asked } = read({
      kind: "ok",
      auctionId,
      auction: summary({ lineup: { order: [lotId] } }),
    });
    expect(await result).toEqual({ kind: "between-lots" });
    expect(asked).toEqual({});
  });

  it("reports Auction failures as unavailable", async () => {
    expect(
      await read({ kind: "unavailable", cause: new Error("down") }).result,
    ).toMatchObject({ kind: "unavailable" });
    expect(
      await read({ kind: "ok", auctionId, auction: summary() }, async () => {
        throw new Error("lot read failed");
      }).result,
    ).toEqual({ kind: "unavailable", error: "lot read failed" });
  });
});

describe("finalLotWhisper", () => {
  it("names the lot and its price with a link to the lot card in the hub bot and no leader", () => {
    const whisper = finalLotWhisper(
      {
        kind: "lot",
        lot: { lotId, title: "Кружка <с совой>", status: tradingLot.status },
      },
      "hub_bot",
    );
    const text = plain(whisper.text);
    expect(text).toBe(
      "Идёт финал: сейчас «Кружка &lt;с совой&gt;», цена 1 200 ₽.",
    );
    expect(text).not.toContain(leaderId);
    expect(whisper.keyboard?.inline_keyboard).toEqual([
      [
        {
          text: openInBotLabel,
          url: `https://t.me/hub_bot?start=l_${uuidToToken(lotId)}`,
        },
      ],
    ]);
  });

  it("names the ask of the auctioneer as a price", () => {
    const whisper = finalLotWhisper(
      {
        kind: "lot",
        lot: {
          lotId,
          title: "Ваза",
          status: { ...tradingLot.status, ask: rub(1500) } as LotView["status"],
        },
      },
      "hub_bot",
    );
    expect(plain(whisper.text)).toBe(
      "Идёт финал: сейчас «Ваза», цена 1 200 ₽, ведущий объявил 1 500 ₽.",
    );
  });

  it("says there is no final, the final is between lots or Auction is down without a button", () => {
    expect(finalLotWhisper({ kind: "no-final" }, "hub_bot")).toEqual({
      text: noFinalText,
      format: "HTML",
    });
    expect(finalLotWhisper({ kind: "between-lots" }, "hub_bot")).toEqual({
      text: "Идёт финал: ведущий готовит следующий лот.",
      format: "HTML",
    });
    expect(
      finalLotWhisper({ kind: "unavailable", error: "down" }, "hub_bot"),
    ).toEqual({ text: finalUnavailableText, format: "HTML" });
  });
});
