import type { RpcMetadata } from "../rpc-metadata.js";

export type ResolveIdentityInput = {
  telegramUserId: bigint;
  telegramUsername?: string;
};

export function toResolveIdentityInput(
  telegramUserId: bigint,
  telegramUsername: string | undefined,
): ResolveIdentityInput {
  if (telegramUsername === undefined) {
    return { telegramUserId };
  }
  return { telegramUserId, telegramUsername };
}

// Три исхода, а не два: недоступность зависимости и нарушение контракта
// различаются наблюдаемо. Повтор лечит первое и никогда не лечит второе,
// поэтому first-slice.md требует различать их в логах и метриках.
//
// Отметка блокировки идёт отдельным полем, а не выводится из пустого набора
// ролей: блокировка отзывает роли, и заблокированный иначе неотличим от
// человека, который ни разу не начинал.
export type ResolveIdentityResult =
  | {
      kind: "resolved";
      identityId: string;
      globalRoles: readonly string[];
      blocked: boolean;
    }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type IdentityResolver = {
  resolve(
    input: ResolveIdentityInput,
    meta?: RpcMetadata,
  ): Promise<ResolveIdentityResult>;
};

// Обратный путь для канала доставки: уведомление несёт внутренний идентификатор,
// а писать можно только по Telegram id. Отсутствующий и заблокированный профиль
// — разные исходы: оба окончательные, но в журнале и логах различимы, а
// недоступность Identity, в отличие от них, лечится повтором.
export type TelegramRecipientResult =
  | { kind: "resolved"; telegramUserId: bigint }
  | { kind: "not-found" }
  | { kind: "blocked" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type TelegramRecipientResolver = {
  resolveTelegramUserId(
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<TelegramRecipientResult>;
};

export type IdentityActor = {
  identityId: string;
  globalRoles: readonly string[];
};

// Ник автора сходки для карточки (PER-404). Identity отвечает только про
// действующего администратора: для остальных, отсутствующих и заблокированных
// — одинаковый `not-found`. Отсутствие ника — `resolved` без поля, а не отказ.
export type OrganizerUsernameResult =
  | { kind: "resolved"; telegramUsername?: string }
  | { kind: "not-found" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type OrganizerResolver = {
  resolveOrganizerUsername(
    viewer: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<OrganizerUsernameResult>;
};
export type CommunityMember = {
  identityId: string;
  telegramUsername?: string;
  admitted: boolean;
};
export type CommunitySnapshot = {
  members: readonly CommunityMember[];
  allowedUsernames: readonly string[];
};
export type IdentityAdminResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "unavailable"; cause: unknown };

export type CommunityAdministrator = {
  community(
    actor: IdentityActor,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<CommunitySnapshot>>;
  admit(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  block(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  addAllowedUsername(
    actor: IdentityActor,
    username: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  removeAllowedUsername(
    actor: IdentityActor,
    username: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
};
