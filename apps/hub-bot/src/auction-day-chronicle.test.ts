import { describe, expect, it } from "vitest";
import { dayChronicleParagraphs } from "./auction-day-chronicle.js";

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
