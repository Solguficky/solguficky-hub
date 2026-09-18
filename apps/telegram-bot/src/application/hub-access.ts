export type HubAccess = "admitted" | "pending" | "blocked";

export const pendingHubAccessText = `Заявка на доступ ждёт проверки.

Пока сходки не видны. Напиши администратору в общем чате сообщества — он сможет найти заявку после твоего запуска бота.`;

export const blockedHubAccessText = `Доступ к Solguficky Hub закрыт.

Если считаешь, что это ошибка, обратись к администратору в общем чате сообщества.`;

export const hubAccessTexts = {
  pending: pendingHubAccessText,
  blocked: blockedHubAccessText,
} as const;

export const hubAccessErrors = {
  pending: "hub_access_pending",
  blocked: "hub_access_blocked",
} as const;

const memberCircleRoles = ["admin", "maintainer", "member"] as const;

export function decideHubAccess(
  globalRoles: readonly string[],
  blocked: boolean,
): HubAccess {
  if (blocked) {
    return "blocked";
  }
  if (memberCircleRoles.some((role) => globalRoles.includes(role))) {
    return "admitted";
  }
  return "pending";
}
