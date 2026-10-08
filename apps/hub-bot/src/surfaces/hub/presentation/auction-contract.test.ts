import { describeAuctionContract } from "../../../auction-ui/contract/index.js";
import { hubTradeCallback } from "./auction-route.js";

// Contract suite аукционного дерева над торговой веткой бота хаба: та же
// таблица намерений и тот же снимок Auction, что у фабрики дерева
// (`src/auction-ui/contract/surfaces.test.ts`) и у поверхности аукциона
// (`src/surfaces/auction/contract.test.ts`), через ту же функцию, что и в
// маршруте бота, с поверхностью `hub`. Оболочка сходки —
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
