import type { AuctionDenial } from "@solguficky/auction-bot-ui";
import {
  type AccessAnswer,
  describeAccessMatrix,
} from "@solguficky/auction-bot-ui/contract";
import type { AuctionEntryScreen } from "./entry-screen.js";
import { routeAuctionCallback, routeAuctionStart } from "./route.js";

const answers: Record<AuctionDenial, AccessAnswer> = {
  "not-admitted": "pending",
  declined: "declined",
  blocked: "blocked",
};

// Что человек увидел: отказ, кадр недоступности либо экран оболочки — FAQ,
// меню или торги.
function answerOf(screen: AuctionEntryScreen): AccessAnswer {
  switch (screen.kind) {
    case "denied":
      return answers[screen.reason];
    case "unavailable":
      return "unavailable";
    case "outdated":
      throw new Error("the matrix button was not read");
    default:
      return "admitted";
  }
}

// Матрица доступа пакета над маршрутом этого бота (ADR-044, «Проверка общего
// поведения»; ADR-060): вход и нажатие идут теми же функциями, что и в
// `bot.ts`, с поверхностью `auction`. FAQ — оболочка бота: в матрице он
// пройден, чтобы допущенный дошёл до экрана.
describeAccessMatrix("auction bot", "auction", (ports) => {
  const entryPorts = {
    ...ports,
    faq: { acknowledged: async () => true, acknowledge: async () => {} },
  };
  return async ({ from, firstName, action }) => {
    const outcome =
      action.kind === "start"
        ? await routeAuctionStart({
            ports: entryPorts,
            user: from,
            firstName,
            ...(action.sourceCode === undefined
              ? {}
              : { sourceCode: action.sourceCode }),
          })
        : await routeAuctionCallback({
            ports: entryPorts,
            user: from,
            data: action.data,
          });
    return answerOf(outcome.screen);
  };
});
