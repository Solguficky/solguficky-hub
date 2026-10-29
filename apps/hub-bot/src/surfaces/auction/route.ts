import { Code, ConnectError } from "@connectrpc/connect";
import {
  type AuctionBotPorts,
  type AuctionResult,
  admission,
  applicationQueue,
  decideEntry,
  encodeAuctionCallback,
  FinalBidReadUnavailable,
  handleAuctionUpdate,
  parseAuctionCallback,
  type ResolvedIdentity,
  type TelegramUser,
  type Viewer,
} from "../../auction-ui/index.js";
import {
  type AuctionNotificationChange,
  type AuctionNotificationSettings,
  auctionNotificationsToast,
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
import { lotIdOf } from "./start-payload.js";

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

// Кнопка дерева, которую этот бот ещё понимает. Избранное открывается только
// из корня аукциона (PER-644, решение владельца по прогону 14 октября 2026
// года): кнопка списка без аукциона — из прежнего меню или набранная
// `/favorites` — получает кадр устаревшего экрана, а не список без возврата.
function currentTradeCallback(data: string): boolean {
  const parsed = parseAuctionCallback(data);
  return (
    parsed.ok &&
    !(
      parsed.intent.kind === "favorites" &&
      parsed.intent.auctionId === undefined
    )
  );
}

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
  lotToken?: string;
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
      ...(input.lotToken === undefined ? {} : { lotToken: input.lotToken }),
    },
  });
}

async function routeEntry(input: {
  ports: EntryPorts;
  user: TelegramUser;
  action:
    | {
        kind: "start";
        firstName: string;
        sourceCode?: string;
        lotToken?: string;
      }
    | { kind: "callback"; data: string; firstName: string }
    | { kind: "reply"; data: string; text?: string };
}): Promise<RouteOutcome> {
  const local =
    input.action.kind === "callback"
      ? parseEntryCallback(input.action.data)
      : undefined;
  // `/start` — команда либо её повтор кнопкой после сбоя: он разрешает
  // личность, а код канала несёт дальше, в кнопку «Подать заявку».
  const starting: { sourceCode?: string; lotToken?: string } | undefined =
    input.action.kind === "start"
      ? {
          ...(input.action.sourceCode === undefined
            ? {}
            : { sourceCode: input.action.sourceCode }),
          ...(input.action.lotToken === undefined
            ? {}
            : { lotToken: input.action.lotToken }),
        }
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
    !currentTradeCallback(input.action.data)
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
        // Политика отдаёт `invitation-only` только хабу; ветка здесь ради
        // полноты типа и отвечает, как на незнакомый исход.
        case "invitation-only":
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
  // Экран торгового результата: тем же путём идёт и ссылка на лот `l_<токен>`,
  // и нажатие. Тело пакета, отказ доступа и устаревший экран.
  const auctionOutcome = async (
    result: AuctionResult,
  ): Promise<RouteOutcome> => {
    switch (result.kind) {
      case "screen": {
        const root = result.body.blocks.find((block) => block.kind === "root");
        // Родитель корня аукциона — список, в котором аукцион стоит сейчас, а
        // не путь, которым человек пришёл (дизайн-код, «Дерево бота
        // аукциона»): корень, открытый из прошедших или с ленты по кнопке
        // уведомления, возвращает туда же, куда и открытый из активных. Не
        // активный аукцион — прошедший: черновика бот аукциона не показывает.
        const parent: ListAction | undefined =
          root === undefined
            ? undefined
            : (
                  await readAuctions({
                    catalog: input.ports.catalog,
                    viewer,
                    listing: "active",
                  })
                ).some((auction) => auction.auctionId === root.auctionId)
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
  };
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
  const menu = { screen: { kind: "menu" }, identityId } as const;
  try {
    // Ссылка на лот `l_<токен>` (PER-492) открывает карточку лота: цель названа
    // самой ссылкой, поэтому отметка FAQ её не перекрывает — та закрывает вход в
    // дерево без цели, `/start` и разделы. Токен недоверенный: не разобранный,
    // он не открывает ничего, и приход идёт обычным `/start`. Отказ Auction на
    // этом пути — тот же кадр недоступности, что у нажатия, а не тишина: ветка
    // стоит внутри `try`.
    if (starting?.lotToken !== undefined) {
      const lotId = lotIdOf(starting.lotToken);
      if (lotId !== undefined) {
        return await auctionOutcome(
          await tradeCallback({
            ports: input.ports,
            identity,
            user: input.user,
            data: encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
          }),
        );
      }
    }
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
    // «Настройки» (PER-595): имя выбирается в идущем аукционе — ближайшем
    // активном. Торги открыты у одного аукциона (RFC-017). Сбой списка
    // убирает пункт имени, а не раздел: частота от Auction не зависит.
    if (local?.action === "settings") {
      const [current] = await readAuctions({
        catalog: input.ports.catalog,
        viewer,
        listing: "active",
      }).catch(() => []);
      return {
        screen: {
          kind: "settings",
          notifications: input.ports.outbid !== undefined,
          ...(current === undefined ? {} : { auctionId: current.auctionId }),
        },
        identityId,
      };
    }
    if (local?.action === "notify") {
      return await outbidSettings({
        ports: input.ports,
        viewer,
        exit,
        ...(local.choose === undefined ? {} : { choose: local.choose }),
        ...(local.detached === true ? { detached: true } : {}),
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
    return await auctionOutcome(
      await tradeCallback({
        ports: input.ports,
        identity,
        user: input.user,
        data: update.data,
        ...(update.kind === "reply"
          ? { reply: update.text === undefined ? {} : { text: update.text } }
          : {}),
      }),
    );
  } catch (cause) {
    // Карточка, хронология, избранное и экран сета начинаются с GetLot. Лот,
    // который исчез или стал невидимым, — устаревшая кнопка, а не временный
    // отказ Auction: повтор того же callback его не откроет. Список намерений
    // тот же, что у хаба (bot.ts).
    if (
      cause instanceof ConnectError &&
      cause.code === Code.NotFound &&
      input.action.kind === "callback"
    ) {
      const parsed = parseAuctionCallback(input.action.data);
      if (
        parsed.ok &&
        (parsed.intent.kind === "lot" ||
          parsed.intent.kind === "set" ||
          parsed.intent.kind === "history" ||
          parsed.intent.kind === "follow" ||
          parsed.intent.kind === "unfollow")
      ) {
        return { screen: { kind: "outdated" }, identityId };
      }
    }
    return {
      screen: {
        ...unavailable,
        ...(cause instanceof FinalBidReadUnavailable
          ? { bidRejected: true as const }
          : {}),
      },
      identityId,
      failure: classify(
        cause instanceof FinalBidReadUnavailable ? cause.cause : cause,
      ),
    };
  }
}

// Экран настроек уведомлений аукциона и выбор на нём (PER-515, PER-539):
// частота «перебили» и анонс финала. Выбор — целевое значение: экран и
// подтверждение показывают то, что ответил Notifications, а не то, что нажато. Notifications недоступен — кадр отказа с повтором того
// же действия и без подтверждения. Выбор, который сервис успел записать до
// таймаута, этим не отменяется: повтор целевым значением его не меняет.
async function outbidSettings(input: {
  ports: EntryPorts;
  viewer: Viewer;
  exit: UnavailableExit;
  choose?: AuctionNotificationChange;
  // Экран открыт из вести (№73 прогона 14 октября 2026 года).
  detached?: true;
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
  let current: AuctionNotificationSettings | undefined;
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
    screen: {
      kind: "notify",
      current,
      ...(input.detached === true ? { detached: true } : {}),
    },
    identityId,
    ...(input.choose === undefined
      ? {}
      : { toast: auctionNotificationsToast(input.choose, current) }),
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
