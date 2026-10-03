export type HubAccess = "admitted" | "pending" | "blocked";

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

export function hubAccessText(
  access: Exclude<HubAccess, "admitted">,
  identityId: string,
  telegramUsername: string | undefined,
): string {
  return access === "pending"
    ? pendingHubAccessText(identityId, telegramUsername)
    : blockedHubAccessText;
}

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
