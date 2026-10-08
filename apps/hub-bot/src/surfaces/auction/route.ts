import { Code, ConnectError } from "@connectrpc/connect";
import {
  type AuctionBotPorts,
  type AuctionResult,
  decideEntry,
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
  requestedRole,
  type TelegramUser,
  type Viewer,
} from "../../auction-ui/index.js";
import { type AuctionListing, listPage, readAuctions } from "./auctions.js";
import type { EntryPorts } from "./entry-ports.js";
import type { AuctionEntryScreen, UnavailableExit } from "./entry-screen.js";
import { type ListAction, parseEntryCallback, startCallback } from "./faq.js";

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
//
// `reply` — ответ на вопрос: шаг пришёл из `reply_to_message`, `text` нет —
// ответили не текстом.
export function tradeCallback(input: {
  ports: AuctionBotPorts;
  identity: ResolvedIdentity;
  user: TelegramUser;
  data: string;
  reply?: { text?: string };
}): Promise<AuctionResult> {
  const { reply } = input;
  return handleAuctionUpdate(
    { kind: "auction", ports: input.ports },
    {
      identity: input.identity,
      user: input.user,
      input:
        reply === undefined
          ? { kind: "callback", data: input.data }
          : {
              kind: "reply",
              data: input.data,
              ...(reply.text === undefined ? {} : { text: reply.text }),
            },
    },
  );
}

// Нажатие кнопки без Telegram: вход — примитивы update, выход — оболочка.
//
// Нечитаемая кнопка соседей не зовёт (бриф ботов, «Правила края при отказах
// Telegram»): домены — `auc` аукционного дерева и `entry` оболочки. Любая кнопка,
// которую оба parser'а не приняли, — устаревший экран. Торги идут через
// шлюз: личность разрешается здесь, один раз на update, и уезжает в него
// готовой (ADR-044, «Доступ как обязательный шлюз»). Identity или Auction
// недоступны — fail-closed: человек получает «недоступно», а не экран без
// проверки.
//
// `firstName` нужен одной кнопке — повтору входа под кадром «недоступно»
// после `/start`: она зовёт тот же `RequestRole`, что и команда.
export async function routeAuctionCallback(input: {
  ports: EntryPorts;
  user: TelegramUser;
  firstName: string;
  data: string;
}): Promise<RouteOutcome> {
  return routeEntry({
    ports: input.ports,
    user: input.user,
    action: {
      kind: "callback",
      data: input.data,
      firstName: input.firstName,
    },
  });
}

// Ответ на вопрос листа ставки (PER-317): шаг — `callback_data` кнопки
// «Отмена» под вопросом, на который ответили. Проверка доступа та же, что у
// нажатия: роль перепроверяется на каждом действии.
export function routeAuctionReply(input: {
  ports: EntryPorts;
  user: TelegramUser;
  data: string;
  text?: string;
}): Promise<RouteOutcome> {
  return routeEntry({
    ports: input.ports,
    user: input.user,
    action: {
      kind: "reply",
      data: input.data,
      ...(input.text === undefined ? {} : { text: input.text }),
    },
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
  sourceCode?: string;
}): Promise<RouteOutcome> {
  return routeEntry({
    ports: input.ports,
    user: input.user,
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
    | { kind: "callback"; data: string; firstName: string }
    | { kind: "reply"; data: string; text?: string };
}): Promise<RouteOutcome> {
  const local =
    input.action.kind === "callback"
      ? parseEntryCallback(input.action.data)
      : undefined;
  // Вход — команда `/start` либо её повтор кнопкой после сбоя: оба зовут
  // `RequestRole`, остальные действия разрешают личность и заявок не ставят.
  const entering =
    input.action.kind === "start"
      ? input.action
      : input.action.kind === "callback" && local?.action === "start"
        ? {
            firstName: input.action.firstName,
            ...(local.sourceCode === undefined
              ? {}
              : { sourceCode: local.sourceCode }),
          }
        : undefined;
  // Выход кадра «недоступно»: повтор несёт данные того же действия. Ответ на
  // вопрос в кнопку не помещается — его присылают ещё раз.
  const exit: UnavailableExit =
    entering !== undefined
      ? { kind: "enter", data: startCallback(entering.sourceCode) }
      : input.action.kind === "callback"
        ? { kind: "retry", data: input.action.data }
        : { kind: "answer" };
  const unavailable = { kind: "unavailable", exit } as const;
  if (
    input.action.kind !== "start" &&
    local === undefined &&
    !parseAuctionCallback(input.action.data).ok
  ) {
    return { screen: { kind: "outdated" } };
  }
  let identity: ResolvedIdentity;
  try {
    if (entering !== undefined) {
      const entry = decideEntry(
        "auction",
        await input.ports.entry.requestRole({
          user: input.user,
          requestedRole: requestedRole("auction"),
          ...(entering.sourceCode === undefined
            ? {}
            : { sourceCode: entering.sourceCode }),
          firstName: entering.firstName,
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
            screen: unavailable,
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
    return { screen: unavailable, failure: classify(cause) };
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
    const action = local?.action;
    if (action === "faq" || action === "details" || action === "question") {
      return { screen: { kind: action }, identityId };
    }
    if (action === "read") {
      // Отметку ставит только возврат из FAQ: фиксируется действие, не
      // доставка Telegram и не факт прочтения. Запись идемпотентна: таймаут
      // безопасно повторить тем же действием.
      await input.ports.faq.acknowledge(viewer);
      return { screen: { kind: "menu" }, identityId };
    }
    // «Меню» с любого другого экрана отметки не ставит: без неё человек
    // видит FAQ, а не меню.
    if (!(await input.ports.faq.acknowledged(viewer))) {
      return { screen: { kind: "faq" }, identityId };
    }
    if (
      input.action.kind === "start" ||
      action === "start" ||
      action === "menu"
    ) {
      return { screen: { kind: "menu" }, identityId };
    }
    if (action === "auctions" || action === "past") {
      const auctions = await readAuctions({
        catalog: input.ports.catalog,
        viewer,
        listing: listingOf[action],
      });
      return {
        screen: { kind: action, list: listPage(auctions, local?.page ?? 0) },
        identityId,
      };
    }
    const { action: update } = input;
    const result = await tradeCallback({
      ports: input.ports,
      identity,
      user: input.user,
      data: update.data,
      ...(update.kind === "reply"
        ? { reply: update.text === undefined ? {} : { text: update.text } }
        : {}),
    });
    switch (result.kind) {
      case "screen": {
        const feed = result.body.blocks.find((block) => block.kind === "feed");
        // Родитель ленты — список, в котором аукцион стоит сейчас, а не путь,
        // которым человек пришёл (дизайн-код, «Дерево бота аукциона»): лента,
        // открытая из прошедших или из карточки по кнопке уведомления,
        // возвращает туда же, куда и открытая из активных. Не активный
        // аукцион — прошедший: черновика бот аукциона не показывает.
        const parent: ListAction | undefined =
          feed === undefined
            ? undefined
            : (
                  await readAuctions({
                    catalog: input.ports.catalog,
                    viewer,
                    listing: "active",
                  })
                ).some((auction) => auction.auctionId === feed.auctionId)
              ? "auctions"
              : "past";
        return {
          screen: {
            kind: "auction",
            body: result.body,
            ...(parent === undefined ? {} : { parent }),
          },
          identityId,
          viewer,
        };
      }
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
    return { screen: unavailable, identityId, failure: classify(cause) };
  }
}

const listingOf: Record<ListAction, AuctionListing> = {
  auctions: "active",
  past: "finished",
};

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
