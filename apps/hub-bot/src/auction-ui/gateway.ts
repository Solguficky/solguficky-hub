import { AuctionCallbackError, parseAuctionCallback } from "./callback-data.js";
import { dispatchAuctionIntent } from "./dispatcher.js";
import type {
  AccessRight,
  ApplicationQueue,
  AuctionBotPorts,
  ResolvedIdentity,
  RoleRequestAnswer,
  TelegramUser,
} from "./ports.js";
import type { AuctionScreenBody } from "./screen.js";

// Поверхность — вход, через который человек пришёл к аукциону. Её собирает
// composition root приложения: вид выбирает политику, порты — его клиенты.
// Своей политики приложение передать не может, поэтому обойти шлюз нечем.
// Разрешать личность шлюз не должен: её приносит update.
export type AuctionSurface = {
  kind: "hub" | "auction";
  ports: AuctionBotPorts;
};

// Узкая модель update: grammY-update разбирает приложение, а пакет не знает
// типов Telegram. `/start` сюда не приходит: это вход на поверхность, а не
// аукционное действие, и его политика — `applicationQueue` и `decideEntry` ниже.
//
// Личность приложение разрешает само, один раз на update, и приносит сюда:
// по тому же ответу оно собирает свою оболочку. Второй вызов Identity внутри
// шлюза дал бы оболочке и телу два разных ответа, и при отзыве права между
// вызовами они разошлись бы (ADR-044, «Доступ как обязательный шлюз»).
//
// `user` — кто прислал update: Telegram id становится адресатом вопроса, а
// ник предлагается именем в аукционе (ADR-059). Пакет их не хранит.
//
// Ответ на вопрос приходит с шагом вопроса из `reply_to_message` — той же
// строкой, что лежит в его «Отмене». `text` нет — ответили не текстом.
export type AuctionUpdate = {
  identity: ResolvedIdentity;
  user: TelegramUser;
  input:
    | { kind: "callback"; data: string }
    | { kind: "reply"; data: string; text?: string };
};

export type AuctionDenial =
  // Нужного права нет: заявка на рассмотрении. Текст выбирает оболочка
  // поверхности.
  | "not-admitted"
  // Человек в сообществе: у него право хаба, и бот аукциона отвечает ему
  // только переходом в бот хаба (ADR-064, пункт 2). В хабе не возникает.
  | "in-community"
  // Прошлая заявка на круг поверхности отклонена (ADR-060, пункт 13). Виден
  // только на `/start`: разрешение личности этого исхода не несёт.
  | "declined"
  // Отметка блокировки: отказ, отличный от отказа человеку без прав.
  | "blocked";

export type AuctionResult =
  | { kind: "screen"; body: AuctionScreenBody }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "unreadable"; error: AuctionCallbackError };

// Политика поверхности по правам, которые вывел Identity (ADR-064, пересмотр
// ADR-044): хаб требует право хаба, бот аукциона — право аукциона и отсутствие
// права хаба. Ни роли, ни вложенности кругов шлюз не знает. `undefined` —
// пустить.
function refusal(
  surface: AuctionSurface["kind"],
  rights: readonly AccessRight[],
): Exclude<AuctionDenial, "declined" | "blocked"> | undefined {
  switch (surface) {
    case "hub":
      return rights.includes("hub") ? undefined : "not-admitted";
    case "auction":
      if (rights.includes("hub")) return "in-community";
      return rights.includes("auction") ? undefined : "not-admitted";
    default: {
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}

// Отказ на действии разрешённой личности или `undefined` — пустить. Ту же
// проверку поверхность повторяет на своих экранах, чтобы политика была одна.
export function admission(
  surface: AuctionSurface["kind"],
  identity: { rights: readonly AccessRight[]; blocked: boolean },
): AuctionDenial | undefined {
  // У заблокированного прав нет по контракту; отметка выбирает текст отказа.
  if (identity.blocked) return "blocked";
  return refusal(surface, identity.rights);
}

// Единственная публичная точка продуктового update (ADR-044, «Доступ как
// обязательный шлюз»): сначала политика поверхности, затем диспетчер.
//
// Политика нажатия — проверка права по разрешённой личности; вход на `/start`
// решает `decideEntry`. Обе идут через одну функцию `refusal`.
export async function handleAuctionUpdate(
  surface: AuctionSurface,
  update: AuctionUpdate,
): Promise<AuctionResult> {
  // Чужая кнопка — не аукционное действие, и политика аукциона к ней не
  // применяется: приложение отдаёт её своему разбору. Иначе человек, которого
  // аукцион не пускает, получал бы аукционный отказ на кнопке хаба.
  const parsed = parseAuctionCallback(update.input.data);
  if (!parsed.ok && parsed.error.reason === "foreign") {
    return { kind: "unreadable", error: parsed.error };
  }

  // Своя кнопка, даже нечитаемая, — уже действие аукциона: отказ
  // заблокированному положен на любом из них.
  const { identity } = update;
  const denial = admission(surface.kind, {
    rights: identity.viewer.rights,
    blocked: identity.blocked,
  });
  if (denial !== undefined) return { kind: "denied", reason: denial };
  if (!parsed.ok) return { kind: "unreadable", error: parsed.error };
  const { input, user } = update;
  // Ответом служит только вопрос, и только тому, кому он задан: после
  // рестарта адресата помнит шаг, а не процесс (дизайн-код, «Вопросы»).
  if (
    input.kind === "reply" &&
    (parsed.intent.kind !== "question" ||
      parsed.intent.addressee !== user.telegramUserId)
  ) {
    return {
      kind: "unreadable",
      error: new AuctionCallbackError("outdated"),
    };
  }

  const body = await dispatchAuctionIntent({
    auction: surface.ports.auction,
    operations: surface.ports.operations,
    viewer: identity.viewer,
    user,
    intent: parsed.intent,
    ...(input.kind === "reply"
      ? { answer: input.text === undefined ? {} : { text: input.text } }
      : {}),
  });
  return { kind: "screen", body };
}

// Очередь, в которую поверхность ставит заявку на `/start` (ADR-064, пункт 8):
// хаб — заявку на участника, бот аукциона — на право аукциона.
const QUEUES: Record<AuctionSurface["kind"], ApplicationQueue> = {
  hub: "community",
  auction: "auction",
};

export function applicationQueue(
  surface: AuctionSurface["kind"],
): ApplicationQueue {
  return QUEUES[surface];
}

export type SurfaceEntry =
  | { kind: "entered"; identity: ResolvedIdentity }
  | { kind: "denied"; reason: AuctionDenial; identityId: string }
  // Исход, которого край не знает. По контракту это отказ, но не ответ о
  // заявке: приложение отвечает как на сбой соседа и пишет нарушение в лог.
  | { kind: "unknown-outcome"; identityId: string };

// Политика входа на `/start` — одна для обеих поверхностей (ADR-064, пересмотр
// ADR-044 и ADR-060, пункт 7). Вызов `RequestRole` заменяет разрешение
// личности: приложение зовёт его само, один раз на update, с очередью из
// `applicationQueue`, и приносит ответ сюда. Допуск решает право — той же
// функцией, что и на нажатии, — а исход выбирает отказ.
export function decideEntry(
  surface: AuctionSurface["kind"],
  answer: RoleRequestAnswer,
): SurfaceEntry {
  const { viewer, outcome } = answer;
  const { identityId } = viewer;
  const denied = (reason: AuctionDenial): SurfaceEntry => ({
    kind: "denied",
    reason,
    identityId,
  });
  if (outcome === "unspecified") return { kind: "unknown-outcome", identityId };
  if (outcome === "blocked") return denied("blocked");
  // Участник в боте аукциона получает переход при любом исходе очереди
  // аукциона: о заявке ему здесь отвечать нечего (ADR-064, пункт 2).
  const refused = refusal(surface, viewer.rights);
  if (refused === "in-community") return denied(refused);
  switch (outcome) {
    case "declined":
      return denied("declined");
    case "pending":
      return denied("not-admitted");
    case "already-held":
    case "granted-by-allowlist":
      // Исход говорит об очереди, а пускает право: разошлись — следующее же
      // нажатие отказало бы, поэтому вход отказывает так же, как оно.
      return refused === undefined
        ? { kind: "entered", identity: { viewer, blocked: false } }
        : denied(refused);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
