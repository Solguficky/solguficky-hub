import { Code, ConnectError } from "@connectrpc/connect";
import {
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
  type TelegramUser,
} from "@solguficky/auction-bot-ui";
import type { EntryPorts } from "./entry-ports.js";
import type { AuctionEntryScreen } from "./entry-screen.js";
import { parseEntryCallback } from "./faq.js";

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
// Telegram»): домены — `auc` общего пакета и `entry` оболочки. Любая кнопка,
// которую оба parser'а не приняли, — устаревший экран. Торги идут через
// шлюз: личность разрешается здесь, один раз на update, и уезжает в него
// готовой (ADR-044, «Доступ как обязательный шлюз»). Identity или Auction
// недоступны — fail-closed: человек получает «недоступно», а не экран без
// проверки.
export async function routeAuctionCallback(input: {
  ports: EntryPorts;
  user: TelegramUser;
  data: string;
}): Promise<RouteOutcome> {
  return routeEntry({
    ...input,
    action: { kind: "callback", data: input.data },
  });
}

export function routeAuctionStart(input: {
  ports: EntryPorts;
  user: TelegramUser;
}): Promise<RouteOutcome> {
  return routeEntry({ ...input, action: { kind: "start" } });
}

async function routeEntry(input: {
  ports: EntryPorts;
  user: TelegramUser;
  action: { kind: "start" } | { kind: "callback"; data: string };
}): Promise<RouteOutcome> {
  const local =
    input.action.kind === "callback"
      ? parseEntryCallback(input.action.data)
      : undefined;
  if (
    input.action.kind === "callback" &&
    local === undefined &&
    !parseAuctionCallback(input.action.data).ok
  ) {
    return { screen: { kind: "outdated" } };
  }
  let identity: ResolvedIdentity;
  try {
    identity = await input.ports.identity.resolveIdentity(input.user);
  } catch (cause) {
    return { screen: { kind: "unavailable" }, failure: classify(cause) };
  }
  const identityId = identity.identityId;
  // Роль перепроверяется на каждом действии. Старая клавиатура и отметка FAQ
  // доступа не дают. Бот требует явную public и не разворачивает роли сам.
  if (identity.blocked || !identity.globalRoles.includes("public")) {
    return {
      screen: {
        kind: "denied",
        reason: identity.blocked ? "blocked" : "not-admitted",
      },
      identityId,
    };
  }
  const viewer = { identityId, globalRoles: identity.globalRoles };
  try {
    if (local === "faq" || local === "details" || local === "question") {
      return { screen: { kind: local }, identityId };
    }
    if (local === "menu") {
      // Фиксируется действие, не доставка Telegram и не факт прочтения.
      // Запись идемпотентна: таймаут безопасно повторить тем же действием.
      await input.ports.faq.acknowledge(viewer);
      return { screen: { kind: "menu" }, identityId };
    }
    if (!(await input.ports.faq.acknowledged(viewer))) {
      return { screen: { kind: "faq" }, identityId };
    }
    if (input.action.kind === "start")
      return { screen: { kind: "menu" }, identityId };
    if (local === "auctions")
      return { screen: { kind: "auctions" }, identityId };
    const result = await handleAuctionUpdate(
      { kind: "auction", ports: input.ports },
      { identity, input: { kind: "callback", data: input.action.data } },
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
