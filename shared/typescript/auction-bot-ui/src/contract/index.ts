import { describe, expect, it } from "vitest";
import {
  AUCTION_CONTRACT_CASES,
  type AuctionContractApp,
  type AuctionContractCase,
  checkAuctionContractCase,
} from "./check.js";

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
