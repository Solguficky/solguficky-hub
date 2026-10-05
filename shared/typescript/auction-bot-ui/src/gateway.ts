import { AuctionCallbackError, parseAuctionCallback } from "./callback-data.js";
import { dispatchAuctionIntent } from "./dispatcher.js";
import type {
  AuctionBotPorts,
  GlobalRole,
  ResolvedIdentity,
  RoleRequestAnswer,
  SurfaceCircle,
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
// аукционное действие, и его политика — `requestedRole` и `decideEntry` ниже.
//
// Личность приложение разрешает само, один раз на update, и приносит сюда:
// по тому же ответу оно собирает свою оболочку. Второй вызов Identity внутри
// шлюза дал бы оболочке и телу два разных ответа, и при отзыве роли между
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
  // Нужной роли нет: заявка на рассмотрении. Текст выбирает оболочка
  // поверхности.
  | "not-admitted"
  // Прошлая заявка на круг поверхности отклонена (ADR-060, пункт 13). Виден
  // только на `/start`: разрешение личности этого исхода не несёт.
  | "declined"
  // Отметка блокировки: отказ, отличный от отказа человеку без ролей.
  | "blocked";

export type AuctionResult =
  | { kind: "screen"; body: AuctionScreenBody }
  | { kind: "denied"; reason: AuctionDenial }
  | { kind: "unreadable"; error: AuctionCallbackError };

// Роли, которые пускает поверхность. Identity отдаёт плоский набор и
// вложенность кругов не разворачивает (ADR-043), поэтому хаб перечисляет
// внутренний круг целиком, а аукцион принимает `public`, которую при допуске
// получает и `member`.
const ADMITTED: Record<AuctionSurface["kind"], readonly GlobalRole[]> = {
  hub: ["admin", "maintainer", "member"],
  auction: ["public"],
};

function admits(
  surface: AuctionSurface["kind"],
  identity: ResolvedIdentity,
): boolean {
  return identity.globalRoles.some((role) => ADMITTED[surface].includes(role));
}

// Единственная публичная точка продуктового update (ADR-044, «Доступ как
// обязательный шлюз»): сначала политика поверхности, затем диспетчер.
//
// Политика нажатия — проверка круга по разрешённой личности; вход на `/start`
// решает `decideEntry`. Обе идут по одной таблице `ADMITTED`.
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
  if (!admits(surface.kind, identity)) {
    return {
      kind: "denied",
      reason: identity.blocked ? "blocked" : "not-admitted",
    };
  }
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
    viewer: {
      identityId: identity.identityId,
      globalRoles: identity.globalRoles,
    },
    user,
    intent: parsed.intent,
    ...(input.kind === "reply"
      ? { answer: input.text === undefined ? {} : { text: input.text } }
      : {}),
  });
  return { kind: "screen", body };
}

// Круг, который поверхность запрашивает у Identity на `/start` (ADR-060,
// пункт 7).
const REQUESTED: Record<AuctionSurface["kind"], SurfaceCircle> = {
  hub: "member",
  auction: "public",
};

export function requestedRole(surface: AuctionSurface["kind"]): SurfaceCircle {
  return REQUESTED[surface];
}

export type SurfaceEntry =
  | { kind: "entered"; identity: ResolvedIdentity }
  | { kind: "denied"; reason: AuctionDenial; identityId: string }
  // Исход, которого край не знает. По контракту это отказ, но не ответ о
  // заявке: приложение отвечает как на сбой соседа и пишет нарушение в лог.
  | { kind: "unknown-outcome"; identityId: string };

// Политика входа на `/start` — одна для обеих поверхностей (ADR-044, «Доступ
// как обязательный шлюз»; ADR-060). Вызов `RequestRole` заменяет разрешение
// личности: приложение зовёт его само, один раз на update, с кругом из
// `requestedRole`, и приносит ответ сюда. Допуск решает роль — той же
// таблицей, что и на нажатии, — а исход выбирает отказ.
export function decideEntry(
  surface: AuctionSurface["kind"],
  answer: RoleRequestAnswer,
): SurfaceEntry {
  const { identityId, globalRoles, outcome } = answer;
  const denied = (reason: AuctionDenial): SurfaceEntry => ({
    kind: "denied",
    reason,
    identityId,
  });
  switch (outcome) {
    case "blocked":
      return denied("blocked");
    case "declined":
      return denied("declined");
    case "pending":
      return denied("not-admitted");
    case "already-held":
    case "granted-by-allowlist": {
      const identity = { identityId, globalRoles, blocked: false };
      // Identity считает круг по вложенности, а поверхность — по плоскому
      // набору. Разошлись — следующее же нажатие отказало бы, поэтому вход
      // отказывает так же, как оно.
      return admits(surface, identity)
        ? { kind: "entered", identity }
        : denied("not-admitted");
    }
    case "unspecified":
      return { kind: "unknown-outcome", identityId };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
