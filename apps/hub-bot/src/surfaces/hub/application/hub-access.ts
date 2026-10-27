import { type AccessRight, admission } from "../../../auction-ui/index.js";
import { admittersLine } from "../../../core/entry.js";

// `pending` и `declined` видны только после «Подать заявку»: их несёт исход
// заявки, а разрешение личности их не знает (ADR-060, пункт 13). Ему известно
// одно — права хаба нет и человек не заблокирован: это `unapplied`, и ответ
// на него — приветствие с кнопкой заявки, а не «заявка ждёт проверки»,
// которой может и не быть (PER-592, дополнение ADR-060 от 2026-10-12).
// `invitation-only` — тоже только после «Подать заявку»: очередь сообщества
// закрыта настройкой Identity, и в хаб пускает только белый список (дополнение
// ADR-060 от 2026-10-25).
export type HubAccess =
  | "admitted"
  | "unapplied"
  | "pending"
  | "declined"
  | "blocked"
  | "invitation-only";

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

${admittersLine} Пока сходки не видны. Напиши администратору в общем чате сообщества ${lookup}`;
}

/**
 * Приветствие человека без права хаба (PER-592): что за бот и что дальше.
 * Заявку ставит только кнопка под ним, поэтому текст зовёт её нажать. Тот,
 * кто заявку уже подал, нажатием узнает, что с ней: разрешение личности
 * этого не знает, а повторная заявка Identity не создаёт.
 */
export const hubWelcome = {
  title: "Привет! Это бот сообщества солегуфиков.",
  paragraphs: [
    "Здесь сходки сообщества: что запланировано, материалы и уведомления. Сходки видят участники сообщества.",
    `Чтобы войти, подай заявку. ${admittersLine} Если заявка уже подана, кнопка покажет, что с ней.`,
  ],
} as const;

/**
 * Ответ на «Подать заявку», когда очередь сообщества закрыта (дополнение
 * ADR-060 от 2026-10-25): заявки нет, в хаб пускает только список
 * администраторов. Кнопка «Подать заявку» под ним остаётся — ник, который
 * добавили в список позже, она и пропустит. Аукционы — в боте аукциона.
 */
export const invitationOnlyHub = {
  title: "Бот сообщества — только по приглашению.",
  paragraphs: [
    "Вход открыт по списку, который ведут администраторы сообщества, а заявки сюда не принимаются. Если ник уже в списке, кнопка ниже откроет бот.",
    "Аукционы сообщества — в боте аукциона.",
  ],
} as const;

export const blockedHubAccessText = `Доступ к Solguficky Hub закрыт.

Если считаешь, что это ошибка, обратись к администратору в общем чате сообщества.`;

// Отказ в `member` — не блокировка: право аукциона он не отнимает, а новую
// заявку на хаб человек не подаёт, пока администратор не пересмотрит решение.
export const declinedHubAccessText = `Заявка на доступ отклонена.

Если считаешь, что это ошибка, обратись к администратору в общем чате сообщества.`;

export function hubAccessText(
  access: Exclude<HubAccess, "admitted" | "unapplied" | "invitation-only">,
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
  unapplied: "hub_access_not_requested",
  pending: "hub_access_pending",
  declined: "hub_access_declined",
  blocked: "hub_access_blocked",
  "invitation-only": "hub_access_invitation_only",
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
  switch (admission("hub", { rights, blocked })) {
    case undefined:
      return "admitted";
    case "blocked":
      return "blocked";
    default:
      return "unapplied";
  }
}

/** Пускает ли хаб человека: та же политика дерева, без текста отказа. */
export function admittedToHub(person: {
  rights: readonly AccessRight[];
}): boolean {
  return (
    admission("hub", { rights: person.rights, blocked: false }) === undefined
  );
}
