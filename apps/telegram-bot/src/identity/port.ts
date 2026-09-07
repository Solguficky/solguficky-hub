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
export type ResolveIdentityResult =
  | { kind: "resolved"; identityId: string; globalRoles: readonly string[] }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type IdentityResolver = {
  resolve(
    input: ResolveIdentityInput,
    requestId?: string,
  ): Promise<ResolveIdentityResult>;
};
