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

// Contract suite для приложения: тест на каждое намерение таблицы над его
// фабрикой. Оба бота зовут её со своей фабрикой и одной таблицей — так одно
// поведение проверяется на двух входах (ADR-044).
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
      it(matrixCase.name, async () => {
        expect(await checkAccessMatrixCase(createApp, matrixCase)).toEqual([]);
      });
    }
  });
}
