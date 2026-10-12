import { Code, ConnectError } from "@connectrpc/connect";
import {
  type AuctionBotPorts,
  type AuctionResult,
  admission,
  applicationQueue,
  decideEntry,
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
  type TelegramUser,
  type Viewer,
} from "../../auction-ui/index.js";
import {
  type OutbidFrequency,
  outbidToast,
} from "../../core/notifications/outbid.js";
import { type AuctionListing, listPage, readAuctions } from "./auctions.js";
import type { EntryPorts } from "./entry-ports.js";
import type { AuctionEntryScreen, UnavailableExit } from "./entry-screen.js";
import {
  applyCallback,
  type ListAction,
  parseEntryCallback,
  startCallback,
} from "./faq.js";

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
  // Всплывающий ответ на нажатие: подтверждение выбранного режима (PER-515).
  toast?: string;
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
// `firstName` нужен одной кнопке — «Подать заявку»: она зовёт `RequestAccess`
// с именем для карточки модератора.
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
// нажатия: права перепроверяются на каждом действии.
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

// `/start` заявку не ставит (PER-592, дополнение ADR-060 от 2026-10-12): он
// разрешает личность, как нажатие, и белый список Identity гасит в том же
// вызове. Человеку без права — приветствие с кнопкой «Подать заявку», и код
// канала из payload `s_<код>` едет в ней; заявку в очередь аукциона ставит
// только эта кнопка.
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
  // `/start` — команда либо её повтор кнопкой после сбоя: он разрешает
  // личность, а код канала несёт дальше, в кнопку «Подать заявку».
  const starting: { sourceCode?: string } | undefined =
    input.action.kind === "start"
      ? input.action.sourceCode === undefined
        ? {}
        : { sourceCode: input.action.sourceCode }
      : local?.action === "start"
        ? local.sourceCode === undefined
          ? {}
          : { sourceCode: local.sourceCode }
        : undefined;
  // Заявка — только «Подать заявку»: единственное действие, которое зовёт
  // `RequestAccess`; остальные разрешают личность и заявок не ставят.
  const entering =
    input.action.kind === "callback" && local?.action === "apply"
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
      ? { kind: "enter", data: applyCallback(entering.sourceCode) }
      : starting !== undefined
        ? { kind: "enter", data: startCallback(starting.sourceCode) }
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
        await input.ports.entry.requestAccess({
          user: input.user,
          queue: applicationQueue("auction"),
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
              message: "identity answered an unknown access request outcome",
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
  const { viewer } = identity;
  const identityId = viewer.identityId;
  // Право перепроверяется на каждом действии той же политикой, что у шлюза:
  // старая клавиатура и отметка FAQ доступа не дают, а участник сообщества
  // получает переход в бот хаба и на экранах оболочки.
  const denial = admission("auction", {
    rights: viewer.rights,
    blocked: identity.blocked,
  });
  // Без права аукциона и без блокировки — приветствие с кнопкой заявки:
  // есть ли заявка, разрешение личности не знает, а «на рассмотрении» без
  // неё было бы ложью (PER-592).
  if (denial === "not-admitted") {
    return {
      screen: {
        kind: "welcome",
        ...(starting?.sourceCode === undefined
          ? {}
          : { sourceCode: starting.sourceCode }),
      },
      identityId,
    };
  }
  if (denial !== undefined) {
    return { screen: { kind: "denied", reason: denial }, identityId };
  }
  // Корневое меню — общий родитель разделов (PER-592). Отметкой FAQ оно не
  // закрыто: иначе «‹ Меню» с FAQ вернула бы в FAQ, а разделы за меню
  // закрыты ею по-прежнему.
  const menu = {
    screen: {
      kind: "menu",
      favorites: input.ports.favorites !== undefined,
      notifications: input.ports.outbid !== undefined,
    },
    identityId,
  } as const;
  try {
    const action = local?.action;
    if (action === "faq" || action === "details" || action === "question") {
      return { screen: { kind: action }, identityId };
    }
    if (action === "menu") return menu;
    // Отметку ставит только кнопка «Аукционы» под FAQ: фиксируется действие,
    // не доставка Telegram и не факт прочтения. Запись идемпотентна: таймаут
    // безопасно повторить тем же действием. Дальше кнопка открывает список,
    // как «Аукционы».
    if (action === "read") {
      await input.ports.faq.acknowledge(viewer);
    } else if (!(await input.ports.faq.acknowledged(viewer))) {
      // Без отметки любой раздел, кроме FAQ, показывает FAQ.
      return { screen: { kind: "faq" }, identityId };
    }
    if (local?.action === "notify") {
      return await outbidSettings({
        ports: input.ports,
        viewer,
        exit,
        ...(local.choose === undefined ? {} : { choose: local.choose }),
      });
    }
    const listScreen = async (list: ListAction): Promise<RouteOutcome> => {
      const auctions = await readAuctions({
        catalog: input.ports.catalog,
        viewer,
        listing: listingOf[list],
      });
      return {
        screen: { kind: list, list: listPage(auctions, local?.page ?? 0) },
        identityId,
      };
    };
    // Вход и допущенная заявка открывают корневое меню (PER-592); «Аукционы»
    // под FAQ — список, который отметку и ставит.
    if (
      input.action.kind === "start" ||
      starting !== undefined ||
      entering !== undefined
    ) {
      return menu;
    }
    if (action === "read") return await listScreen("auctions");
    if (action === "auctions" || action === "past") {
      return await listScreen(action);
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

// Экран частоты «перебили» и выбор на нём (PER-515). Выбор — целевое
// значение: экран и подтверждение показывают то, что ответил Notifications, а
// не то, что нажато. Notifications недоступен — кадр отказа с повтором того
// же действия и без подтверждения. Выбор, который сервис успел записать до
// таймаута, этим не отменяется: повтор целевым значением его не меняет.
async function outbidSettings(input: {
  ports: EntryPorts;
  viewer: Viewer;
  exit: UnavailableExit;
  choose?: OutbidFrequency;
}): Promise<RouteOutcome> {
  const { outbid } = input.ports;
  const identityId = input.viewer.identityId;
  // Кнопка из сборки с Notifications в сборке без него: экран устарел.
  if (outbid === undefined) return { screen: { kind: "outdated" }, identityId };
  const unavailable = {
    kind: "unavailable",
    exit: input.exit,
    subject: "notifications",
  } as const;
  let current: OutbidFrequency | undefined;
  try {
    current =
      input.choose === undefined
        ? await outbid.get(input.viewer)
        : await outbid.set(input.viewer, input.choose);
  } catch (cause) {
    return { screen: unavailable, identityId, failure: classify(cause) };
  }
  if (current === undefined) {
    return {
      screen: unavailable,
      identityId,
      failure: {
        category: "invariant",
        message: "notifications answered an unknown outbid frequency",
      },
    };
  }
  return {
    screen: { kind: "notify", current },
    identityId,
    ...(input.choose === undefined ? {} : { toast: outbidToast(current) }),
  };
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
