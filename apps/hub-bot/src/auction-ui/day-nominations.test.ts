import { describe, expect, it } from "vitest";
import {
  darkHorseMaxBidsBefore,
  dayNominations,
  duelMinChanges,
} from "./day-nominations.js";

const quiet = {
  bidCount: 0,
  leaderChanges: 0,
  longestDuel: 0,
  bidsBefore: 0,
};

describe("dayNominations", () => {
  it("nominates the most contested lot, the dark horse and the duel", () => {
    const contested = {
      id: "contested",
      bidCount: 9,
      leaderChanges: 7,
      longestDuel: duelMinChanges,
      bidsBefore: 10,
      priceGrowth: { minorUnits: 90_000 },
    };
    const dark = {
      id: "dark",
      bidCount: 2,
      leaderChanges: 1,
      longestDuel: 1,
      bidsBefore: darkHorseMaxBidsBefore,
      priceGrowth: { minorUnits: 50_000 },
    };
    const duel = {
      id: "duel",
      bidCount: 6,
      leaderChanges: 5,
      longestDuel: duelMinChanges + 1,
      bidsBefore: 12,
      priceGrowth: { minorUnits: 1_000 },
    };

    expect(dayNominations([contested, dark, duel])).toEqual({
      contested,
      darkHorse: dark,
      duel,
    });
  });

  it("leaves out lots without bids in the window and below the thresholds", () => {
    expect(
      dayNominations([
        // Рост большой, но за сутки ему не ставили.
        { ...quiet, leaderChanges: 3, priceGrowth: { minorUnits: 10_000 } },
        // До суток ставок больше порога «тёмной лошадки», дуэль короче порога.
        {
          bidCount: 1,
          leaderChanges: 0,
          longestDuel: duelMinChanges - 1,
          bidsBefore: darkHorseMaxBidsBefore + 1,
          priceGrowth: { minorUnits: 10_000 },
        },
      ]),
    ).toEqual({});
  });

  it("keeps the first of equal lots", () => {
    const first = { ...quiet, id: 1, bidCount: 1, leaderChanges: 2 };
    const second = { ...quiet, id: 2, bidCount: 1, leaderChanges: 2 };
    expect(dayNominations([first, second]).contested).toBe(first);
  });
});
