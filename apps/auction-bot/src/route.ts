import {
  type AuctionBotPorts,
  handleAuctionUpdate,
  type ResolvedIdentity,
  type TelegramUser,
} from "@solguficky/auction-bot-ui";
import type { AuctionEntryScreen } from "./entry-screen.js";

export type RouteOutcome = {
  screen: AuctionEntryScreen;
  identityId?: string;
  // Причина недоступности для записи в лог; человеку она не показывается.
  failure?: unknown;
};

// Нажатие кнопки без Telegram: вход — примитивы update, выход — оболочка.
// Личность разрешается здесь, один раз на update, и уезжает в шлюз готовой
// (ADR-044, «Доступ как обязательный шлюз»). Identity или Auction недоступны —
// fail-closed: человек получает «недоступно», а не экран без проверки.
export async function routeAuctionCallback(input: {
  ports: AuctionBotPorts;
  user: TelegramUser;
  data: string;
}): Promise<RouteOutcome> {
  let identity: ResolvedIdentity;
  try {
    identity = await input.ports.identity.resolveIdentity(input.user);
  } catch (failure) {
    return { screen: { kind: "unavailable" }, failure };
  }
  const identityId = identity.identityId;
  try {
    const result = await handleAuctionUpdate(
      { kind: "auction", ports: input.ports },
      { identity, input: { kind: "callback", data: input.data } },
    );
    switch (result.kind) {
      case "screen":
        return { screen: { kind: "auction", body: result.body }, identityId };
      case "denied":
        return {
          screen: { kind: "denied", reason: result.reason },
          identityId,
        };
      case "unreadable":
        // Своих доменов у бота аукциона нет, поэтому чужая кнопка, как и
        // нечитаемая своя, — устаревший экран: человек открывает вход заново.
        return { screen: { kind: "outdated" }, identityId };
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  } catch (failure) {
    return { screen: { kind: "unavailable" }, identityId, failure };
  }
}
