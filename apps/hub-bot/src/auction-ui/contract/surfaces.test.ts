import { describe, expect, it } from "vitest";
import {
  AUCTION_CONTRACT_CASES,
  AUCTION_SURFACES,
  auctionContractApp,
  checkAuctionContract,
  describeAuctionSurfaces,
} from "./index.js";

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

  // Функция, добавленная в дерево, видна обеим поверхностям без правки второй:
  // строка таблицы проходит на фабрике каждой поверхности, и ни одна строка
  // кода поверхности её не называет.
  it("runs a row added to the tree's table on every surface", async () => {
    const [template] = AUCTION_CONTRACT_CASES;
    if (template === undefined) throw new Error("no contract cases");
    const added = { ...template, intent: `${template.intent}: added` };
    for (const kind of AUCTION_SURFACES) {
      expect(
        await checkAuctionContract(auctionContractApp(kind), [added]),
      ).toEqual([]);
    }
  });
});
