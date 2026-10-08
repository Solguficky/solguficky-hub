import { describeAuctionContract } from "../../auction-ui/contract/index.js";
import { tradeCallback } from "./route.js";

// Contract suite аукционного дерева над торговой веткой этой поверхности
// (ADR-064, п. 19): нажатие идёт через ту же функцию, что и в маршруте, с
// поверхностью `auction`. FAQ и меню — оболочка бота, в suite они не входят.
describeAuctionContract(
  "auction bot",
  (ports) =>
    async ({ from, input }) =>
      tradeCallback({
        ports,
        identity: await ports.identity.resolveIdentity(from),
        user: from,
        data: input.data,
        ...(input.kind === "reply"
          ? { reply: input.text === undefined ? {} : { text: input.text } }
          : {}),
      }),
);
