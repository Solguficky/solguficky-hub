import { Code, ConnectError } from "@connectrpc/connect";
import {
  type AuctionBotPorts,
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
  type TelegramUser,
} from "@solguficky/auction-bot-ui";
import type { AuctionEntryScreen } from "./entry-screen.js";

// Отказ зависимости для записи в лог: класс по словарю logging.md и код gRPC.
// Человеку ни то ни другое не показывается.
export type RouteFailure = {
  category: "dependency_unavailable" | "timeout" | "unexpected";
  grpcCode?: string;
  message: string;
};

export type RouteOutcome = {
  screen: AuctionEntryScreen;
  identityId?: string;
  failure?: RouteFailure;
};

// Нажатие кнопки без Telegram: вход — примитивы update, выход — оболочка.
//
// Нечитаемая кнопка соседей не зовёт (бриф ботов, «Правила края при отказах
// Telegram»): своих доменов, кроме `auc`, у бота нет, поэтому любая кнопка,
// которую parser пакета не принял, — устаревший экран. Остальное идёт через
// шлюз: личность разрешается здесь, один раз на update, и уезжает в него
// готовой (ADR-044, «Доступ как обязательный шлюз»). Identity или Auction
// недоступны — fail-closed: человек получает «недоступно», а не экран без
// проверки.
export async function routeAuctionCallback(input: {
  ports: AuctionBotPorts;
  user: TelegramUser;
  data: string;
}): Promise<RouteOutcome> {
  if (!parseAuctionCallback(input.data).ok) {
    return { screen: { kind: "outdated" } };
  }
  let identity: ResolvedIdentity;
  try {
    identity = await input.ports.identity.resolveIdentity(input.user);
  } catch (cause) {
    return { screen: { kind: "unavailable" }, failure: classify(cause) };
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
        return { screen: { kind: "outdated" }, identityId };
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  } catch (cause) {
    return {
      screen: { kind: "unavailable" },
      identityId,
      failure: classify(cause),
    };
  }
}

function classify(cause: unknown): RouteFailure {
  if (cause instanceof ConnectError) {
    return {
      category:
        cause.code === Code.DeadlineExceeded
          ? "timeout"
          : "dependency_unavailable",
      grpcCode: Code[cause.code],
      message: cause.message,
    };
  }
  return {
    category: "unexpected",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
