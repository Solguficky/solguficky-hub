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

export type IdentityActor = {
  identityId: string;
  globalRoles: readonly string[];
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
