import { describeAuctionContract } from "@solguficky/auction-bot-ui/contract";
import { tradeCallback } from "./route.js";

// Contract suite пакета над торговой веткой этого бота (ADR-044, «Проверка
// общего поведения»): нажатие идёт через ту же функцию, что и в маршруте, с
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
