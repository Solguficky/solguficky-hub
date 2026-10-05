import { Code, ConnectError } from "@connectrpc/connect";
import {
  type AuctionBotPorts,
  type AuctionResult,
  decideEntry,
  encodeAuctionCallback,
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
  requestedRole,
  type TelegramUser,
  type Viewer,
} from "@solguficky/auction-bot-ui";
import type { EntryPorts } from "./entry-ports.js";
import type { AuctionEntryScreen } from "./entry-screen.js";
import { parseEntryCallback } from "./faq.js";

// Отказ зависимости для записи в лог: класс по словарю logging.md и код gRPC.
// Человеку ни то ни другое не показывается.
export type RouteFailure = {
  // `invariant` — сосед ответил вне контракта: исход входа, которого край не
  // знает.
  category: "dependency_unavailable" | "timeout" | "invariant" | "unexpected";
  grpcCode?: string;
  message: string;
};

export type RouteOutcome = {
  screen: AuctionEntryScreen;
  identityId?: string;
  // Смотрящий торгового экрана: от его имени край берёт байты изображения.
  viewer?: Viewer;
  failure?: RouteFailure;
};

// Торговое нажатие через шлюз пакета поверхности `auction` с уже
// разрешённой личностью (ADR-044, «Доступ как обязательный шлюз»). Над этой
// функцией идёт contract suite пакета.
export function tradeCallback(input: {
  ports: AuctionBotPorts;
  identity: ResolvedIdentity;
  data: string;
}): Promise<AuctionResult> {
  return handleAuctionUpdate(
    { kind: "auction", ports: input.ports },
    { identity: input.identity, input: { kind: "callback", data: input.data } },
  );
}

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
  auctionId?: string;
}): Promise<RouteOutcome> {
  return routeEntry({
    ...input,
    action: { kind: "callback", data: input.data },
  });
}

// `/start` — вход на поверхность (ADR-060): вместо разрешения личности бот
// зовёт `RequestRole` с кругом `public`, кодом канала из payload `s_<код>` и
// именем для карточки модератора. Identity гасит белый список или ставит
// заявку, а ответ по исходу выбирает политика пакета.
export function routeAuctionStart(input: {
  ports: EntryPorts;
  user: TelegramUser;
  firstName: string;
  auctionId?: string;
  sourceCode?: string;
}): Promise<RouteOutcome> {
  return routeEntry({
    ports: input.ports,
    user: input.user,
    ...(input.auctionId === undefined ? {} : { auctionId: input.auctionId }),
    action: {
      kind: "start",
      firstName: input.firstName,
      ...(input.sourceCode === undefined
        ? {}
        : { sourceCode: input.sourceCode }),
    },
  });
}

async function routeEntry(input: {
  ports: EntryPorts;
  user: TelegramUser;
  action:
    | { kind: "start"; firstName: string; sourceCode?: string }
    | { kind: "callback"; data: string };
  // Аукцион ленты из конфигурации. Нет — «Аукционы» отвечают, что каталог
  // ещё не открыт: чтения текущего аукциона в контракте нет.
  auctionId?: string;
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
    if (input.action.kind === "start") {
      const entry = decideEntry(
        "auction",
        await input.ports.entry.requestRole({
          user: input.user,
          requestedRole: requestedRole("auction"),
          ...(input.action.sourceCode === undefined
            ? {}
            : { sourceCode: input.action.sourceCode }),
          firstName: input.action.firstName,
        }),
      );
      switch (entry.kind) {
        case "entered":
          identity = entry.identity;
          break;
        case "denied":
          return {
            screen: { kind: "denied", reason: entry.reason },
            identityId: entry.identityId,
          };
        case "unknown-outcome":
          return {
            screen: { kind: "unavailable" },
            identityId: entry.identityId,
            failure: {
              category: "invariant",
              message: "identity answered an unknown role request outcome",
            },
          };
        default: {
          const _exhaustive: never = entry;
          return _exhaustive;
        }
      }
    } else {
      identity = await input.ports.identity.resolveIdentity(input.user);
    }
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
    if (local === "auctions" && input.auctionId === undefined)
      return { screen: { kind: "auctions" }, identityId };
    // «Аукционы» при названном аукционе — первая страница его ленты.
    const data =
      local === "auctions" && input.auctionId !== undefined
        ? encodeAuctionCallback({
            kind: "feed",
            auctionId: input.auctionId,
            page: 0,
          })
        : input.action.data;
    const result = await tradeCallback({ ports: input.ports, identity, data });
    switch (result.kind) {
      case "screen":
        return {
          screen: { kind: "auction", body: result.body },
          identityId,
          viewer,
        };
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
