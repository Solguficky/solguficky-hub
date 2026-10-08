import { describe, expect, it } from "vitest";
import type { AuctionSurface } from "../gateway.js";
import {
  ACCESS_MATRIX_CASES,
  type AccessMatrixApp,
  type AccessMatrixCase,
  checkAccessMatrixCase,
} from "./access.js";
import {
  AUCTION_CONTRACT_CASES,
  type AuctionContractApp,
  type AuctionContractCase,
  checkAuctionContractCase,
} from "./check.js";
import {
  AUCTION_SURFACES,
  accessMatrixApp,
  auctionContractApp,
} from "./surfaces.js";

export {
  ACCESS_MATRIX_CASES,
  type AccessAction,
  type AccessAnswer,
  type AccessMatrixApp,
  type AccessMatrixCase,
  type AccessMatrixInput,
  type AccessMatrixPorts,
  type AccessViolation,
  checkAccessMatrix,
  checkAccessMatrixCase,
} from "./access.js";
export {
  AUCTION_CONTRACT_CASES,
  type AuctionContractApp,
  type AuctionContractCase,
  type AuctionContractInput,
  CONTRACT_AUCTION_ID,
  CONTRACT_IDENTITY,
  CONTRACT_LOT,
  CONTRACT_USER,
  type ContractAuction,
  type ContractViolation,
  checkAuctionContract,
  checkAuctionContractCase,
  type PortCall,
} from "./check.js";

// Contract suite над фабрикой: тест на каждое намерение таблицы. Её зовут
// фабрика дерева для каждой поверхности (`describeAuctionSurfaces`) и маршрут
// каждой поверхности со своей фабрикой — так одно поведение проверяется и в
// дереве, и на входах ботов (ADR-064, п. 19).
export function describeAuctionContract(
  name: string,
  createApp: AuctionContractApp,
  cases: readonly AuctionContractCase[] = AUCTION_CONTRACT_CASES,
): void {
  describe(`auction contract: ${name}`, () => {
    it("has intents to check", () => {
      expect(cases.length).toBeGreaterThan(0);
    });
    for (const contractCase of cases) {
      it(`intent ${contractCase.intent}`, async () => {
        expect(await checkAuctionContractCase(createApp, contractCase)).toEqual(
          [],
        );
      });
    }
  });
}

// Матрица доступа для приложения: тест на каждую строку его поверхности над
// его фабрикой. Вход приложения здесь целый — от действия человека до ответа
// ему, — поэтому матрица ловит и забытый вход на `/start`, и вызов Auction
// для человека, которого поверхность не пускает (ADR-044, ADR-060).
export function describeAccessMatrix(
  name: string,
  surface: AuctionSurface["kind"],
  createApp: AccessMatrixApp,
  cases: readonly AccessMatrixCase[] = ACCESS_MATRIX_CASES,
): void {
  const own = cases.filter((each) => each.surface === surface);
  describe(`access matrix: ${name}`, () => {
    it("has cases to check", () => {
      expect(own.length).toBeGreaterThan(0);
    });
    for (const matrixCase of own) {
      it(`${matrixCase.name}: ${matrixCase.answer}`, async () => {
        expect(await checkAccessMatrixCase(createApp, matrixCase)).toEqual([]);
      });
    }
  });
}
export {
  AUCTION_SURFACES,
  accessMatrixApp,
  auctionContractApp,
} from "./surfaces.js";

// Contract suite и матрица доступа над одной фабрикой для каждой поверхности
// (ADR-064, п. 19): намерение, добавленное в дерево строкой таблицы,
// проверяется на всех поверхностях без правки второй.
export function describeAuctionSurfaces(): void {
  for (const kind of AUCTION_SURFACES) {
    describeAuctionContract(`${kind} surface`, auctionContractApp(kind));
    describeAccessMatrix(`${kind} surface`, kind, accessMatrixApp(kind));
  }
}
