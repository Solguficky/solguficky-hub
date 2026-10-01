import {
  type AuctionCallbackError,
  parseAuctionCallback,
} from "./callback-data.js";
import { dispatchAuctionIntent } from "./dispatcher.js";
import type { AuctionBotPorts, GlobalRole, ResolvedIdentity } from "./ports.js";
import type { AuctionScreenBody } from "./screen.js";

// Поверхность — вход, через который человек пришёл к аукциону. Её собирает
// composition root приложения: вид выбирает политику, порты — его клиенты.
// Своей политики приложение передать не может, поэтому обойти шлюз нечем.
// Порт Identity шлюзу нужен только для самозаписи `public` на `/start`
// (PER-316): разрешать личность он не должен, её приносит update.
export type AuctionSurface = {
  kind: "hub" | "auction";
  ports: AuctionBotPorts;
};

// Узкая модель update: grammY-update разбирает приложение, а пакет не знает
// типов Telegram. `/start` появится здесь вместе с самозаписью `public`.
//
// Личность приложение разрешает само, один раз на update, и приносит сюда:
// по тому же ответу оно собирает свою оболочку. Второй вызов Identity внутри
// шлюза дал бы оболочке и телу два разных ответа, и при отзыве роли между
// вызовами они разошлись бы (ADR-044, «Доступ как обязательный шлюз»).
export type AuctionUpdate = {
  identity: ResolvedIdentity;
  input: { kind: "callback"; data: string };
};

export type AuctionDenial =
  // Нужной роли нет. Текст выбирает оболочка поверхности.
  | "not-admitted"
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
// Политика здесь минимальная — проверка круга по разрешённой личности.
// Самозапись `public` на `/start` и полная матрица шести случаев — PER-316;
// сигнатура при этом не меняется.
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

  const body = await dispatchAuctionIntent({
    auction: surface.ports.auction,
    viewer: {
      identityId: identity.identityId,
      globalRoles: identity.globalRoles,
    },
    intent: parsed.intent,
  });
  return { kind: "screen", body };
}
