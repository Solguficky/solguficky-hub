import { describe, expect, it } from "vitest";
import {
  auctionChronicleParagraphs,
  dayChronicleParagraphs,
} from "./auction-day-chronicle.js";

const money = (amount: { minorUnits: number }) =>
  `${amount.minorUnits / 100} ₽`;
const auctionId = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";

describe("day chronicle paragraphs", () => {
  it("names each nomination with its lot and tail", () => {
    expect(
      dayChronicleParagraphs(
        {
          kind: "day-chronicle",
          auctionId,
          chronicle: {
            kind: "nominated",
            contested: { title: "Кружка <с> совой", leaderChanges: 21 },
            darkHorse: {
              priceGrowth: { minorUnits: 50_000, currency: "RUB" },
              bidsBefore: 0,
            },
            duel: { title: "Плакат", longestDuel: 4 },
          },
        },
        { money },
      ),
    ).toEqual([
      "За последние сутки.",
      "Спорнее всех:\n• «Кружка &lt;с&gt; совой» — 21 смена лидера",
      "Тёмная лошадка:\n• «Лот без названия» — +500 ₽ от старта, нет ставок до этих суток",
      "Эпичная дуэль:\n• «Плакат» — 4 перебивания подряд вдвоём",
    ]);
  });

  it("says why there is nothing to tell", () => {
    const of = (
      chronicle: Parameters<typeof dayChronicleParagraphs>[0]["chronicle"],
    ) =>
      dayChronicleParagraphs(
        { kind: "day-chronicle", auctionId, chronicle },
        { money },
      );
    expect(of({ kind: "no-lots" })).toEqual(["Лотов в аукционе пока нет."]);
    expect(of({ kind: "no-bids" })).toEqual([
      "За последние сутки ставок не было.",
    ]);
    expect(of({ kind: "nominated" })).toEqual([
      "За последние сутки.",
      "За сутки ни один лот не набрал на номинацию.",
    ]);
  });
});

describe("auction chronicle paragraphs", () => {
  it("counts the trading and names the record and the nominations", () => {
    expect(
      auctionChronicleParagraphs(
        {
          kind: "auction-chronicle",
          auctionId,
          chronicle: {
            kind: "counted",
            bidCount: 21,
            participantCount: 3,
            tradedLotCount: 2,
            lotCount: 21,
            growthRecord: {
              title: "Кружка <с> совой",
              growth: { minorUnits: 50_000, currency: "RUB" },
            },
            contested: { leaderChanges: 2 },
            duel: { title: "Плакат", longestDuel: 4 },
          },
        },
        { money },
      ),
    ).toEqual([
      "За всё время торгов.",
      "• 21 ставка\n• 3 участника\n• 2 из 21 лота со ставками",
      "Рекорд роста:\n• «Кружка &lt;с&gt; совой» — +500 ₽ от старта",
      "Спорнее всех:\n• «Лот без названия» — 2 смены лидера",
      "Эпичная дуэль:\n• «Плакат» — 4 перебивания подряд вдвоём",
    ]);
  });

  it("says when the auction has no lots or no bids", () => {
    const paragraphs = (
      chronicle: Parameters<typeof auctionChronicleParagraphs>[0]["chronicle"],
    ) =>
      auctionChronicleParagraphs(
        { kind: "auction-chronicle", auctionId, chronicle },
        { money },
      );
    expect(paragraphs({ kind: "no-lots" })).toEqual([
      "Лотов в аукционе пока нет.",
    ]);
    expect(paragraphs({ kind: "no-bids" })).toEqual([
      "Ставок в аукционе пока не было.",
    ]);
  });
});
