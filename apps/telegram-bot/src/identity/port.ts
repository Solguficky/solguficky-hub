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
