export type ResolveIdentityInput = {
  telegramUserId: bigint;
  telegramUsername?: string;
};

export type ResolveIdentityResult =
  | { kind: "resolved"; identityId: string; globalRoles: readonly string[] }
  | { kind: "unavailable"; cause: unknown };

export type IdentityResolver = {
  resolve(input: ResolveIdentityInput): Promise<ResolveIdentityResult>;
};
