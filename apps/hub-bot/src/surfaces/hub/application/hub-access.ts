import type { AccessRight } from "../../../auction-ui/index.js";

// `declined` виден только на `/start`: его несёт исход входа, а разрешение
// личности на остальных действиях его не знает (ADR-060, пункт 13).
export type HubAccess = "admitted" | "pending" | "declined" | "blocked";

// Код заявки — хвост UUIDv7, а не голова: голова несёт время создания и у
// профилей, заведённых в одну минуту, совпадает, а хвост случаен.
export function applicationCode(identityId: string): string {
  return identityId.slice(-8);
}

// Человека с ником администратор видит в списке по нику, без кода, поэтому
// код называет только тот, у кого ника нет: иначе он назвал бы то, чего на
// экране администратора нет.
export function pendingHubAccessText(
  identityId: string,
  telegramUsername: string | undefined,
): string {
  const lookup =
    telegramUsername === undefined
      ? `и назови код заявки: ${applicationCode(identityId)}. По нему он найдёт тебя в списке.`
      : "— он найдёт заявку по твоему нику.";
  return `Заявка на доступ ждёт проверки.

Пока сходки не видны. Напиши администратору в общем чате сообщества ${lookup}`;
}

export const blockedHubAccessText = `Доступ к Solguficky Hub закрыт.

Если считаешь, что это ошибка, обратись к администратору в общем чате сообщества.`;

// Отказ в `member` — не блокировка: право аукциона он не отнимает, а новую
// заявку на хаб человек не подаёт, пока администратор не пересмотрит решение.
export const declinedHubAccessText = `Заявка на доступ отклонена.

Если считаешь, что это ошибка, обратись к администратору в общем чате сообщества.`;

export function hubAccessText(
  access: Exclude<HubAccess, "admitted">,
  identityId: string,
  telegramUsername: string | undefined,
): string {
  switch (access) {
    case "pending":
      return pendingHubAccessText(identityId, telegramUsername);
    case "declined":
      return declinedHubAccessText;
    case "blocked":
      return blockedHubAccessText;
    default: {
      const _exhaustive: never = access;
      return _exhaustive;
    }
  }
}

export const hubAccessErrors = {
  pending: "hub_access_pending",
  declined: "hub_access_declined",
  blocked: "hub_access_blocked",
} as const;

/**
 * Хаб пускает по праву хаба, которое вывел Identity (ADR-064, пункт 6): круга и
 * вложенности бот не знает. Гостю и постороннему — заявка на участника, без
 * сходок, аукциона и намёка на бот аукциона (RFC-015, С-4).
 */
export function decideHubAccess(
  rights: readonly AccessRight[],
  blocked: boolean,
): HubAccess {
  if (blocked) {
    return "blocked";
  }
  if (rights.includes("hub")) {
    return "admitted";
  }
  return "pending";
}
