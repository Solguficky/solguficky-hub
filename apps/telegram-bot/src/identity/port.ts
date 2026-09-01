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

export type ResolveIdentityResult =
  | { kind: "resolved"; identityId: string; globalRoles: readonly string[] }
  | { kind: "unavailable"; cause: unknown };

export type IdentityResolver = {
  resolve(input: ResolveIdentityInput): Promise<ResolveIdentityResult>;
};
