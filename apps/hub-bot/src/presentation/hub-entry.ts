import type { HubAccess } from "../application/hub-access.js";
import type { DeepLink, Person } from "../application/types.js";
import { viewerOf } from "../auction/port.js";
import {
  type AuctionDenial,
  decideEntry,
  requestedRole,
} from "../auction-ui/index.js";
import type {
  RequestRoleInput,
  RequestRoleResult,
  ResolveIdentityInput,
} from "../identity/port.js";

// Вход на `/start` в боте хаба (ADR-060). Круг и разбор исхода — политика
// аукционного дерева, одна на оба бота (ADR-044, «Доступ как обязательный шлюз»):
// хаб только называет свою поверхность и переводит ответ в свои кадры.

/**
 * Запрос входа: круг хаба, имя для карточки модератора и код канала. Код
 * несёт только payload `s_<код>` — ссылка на сходку и чужой payload его не
 * несут, а пустой код после `s_` едет пустой строкой.
 */
export function hubRoleRequest(
  person: ResolveIdentityInput & { firstName: string },
  deepLink: DeepLink | undefined,
): RequestRoleInput {
  return {
    telegramUserId: person.telegramUserId,
    ...(person.telegramUsername === undefined
      ? {}
      : { telegramUsername: person.telegramUsername }),
    requestedRole: requestedRole("hub"),
    ...(deepLink?.kind === "source" ? { sourceCode: deepLink.code } : {}),
    firstName: person.firstName,
  };
}

const denials: Record<AuctionDenial, Exclude<HubAccess, "admitted">> = {
  "not-admitted": "pending",
  declined: "declined",
  blocked: "blocked",
};

export type HubEntry =
  | { kind: "decided"; person: Person; access: HubAccess }
  // Исход, которого край не знает: ни допуска, ни ответа о заявке.
  | { kind: "unknown-outcome"; identityId: string };

export function decideHubEntry(
  answer: Extract<RequestRoleResult, { kind: "answered" }>,
): HubEntry {
  const person = {
    identityId: answer.identityId,
    globalRoles: answer.globalRoles,
  };
  const entry = decideEntry("hub", {
    ...viewerOf(person),
    outcome: answer.outcome,
  });
  switch (entry.kind) {
    case "entered":
      return { kind: "decided", person, access: "admitted" };
    case "denied":
      return { kind: "decided", person, access: denials[entry.reason] };
    case "unknown-outcome":
      return entry;
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}
