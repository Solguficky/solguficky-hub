import { describe, expect, it } from "vitest";
import { AUCTION_SURFACES, describeAuctionSurfaces } from "./index.js";

// Одна фабрика на дерево, поверхность — параметр (ADR-064, п. 19): каждое
// намерение таблицы и каждая строка матрицы идут по всем поверхностям.
// Процессы проверяют свой вход поверх неё сами: маршрут и бот поверхности
// хаба — `presentation/auction-contract.test.ts` и `access-matrix.test.ts`,
// поверхности аукциона — `surfaces/auction/contract.test.ts` и
// `access-matrix.test.ts`.
describeAuctionSurfaces();

describe("auction surfaces", () => {
  it("covers both bots", () => {
    expect([...AUCTION_SURFACES].sort()).toEqual(["auction", "hub"]);
  });
});
