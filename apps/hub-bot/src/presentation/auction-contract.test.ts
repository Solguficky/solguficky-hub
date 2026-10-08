import { describeAuctionContract } from "../auction-ui/contract/index.js";
import { hubTradeCallback } from "./auction-route.js";

// Contract suite пакета над торговой веткой бота хаба (ADR-044, «Проверка
// общего поведения»): та же таблица намерений и тот же снимок Auction, что у
// бота аукциона (`apps/auction-bot/src/contract.test.ts`), через ту же
// функцию, что и в маршруте бота, с поверхностью `hub`. Оболочка сходки —
// возврат «‹ Сходка» и ряд навигации — в suite не входит: у неё свои тесты.
describeAuctionContract(
  "hub bot",
  (ports) =>
    async ({ from, input }) =>
      hubTradeCallback({
        ports,
        identity: await ports.identity.resolveIdentity(from),
        user: from,
        input,
      }),
);
