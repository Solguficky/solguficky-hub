export type Person = {
  identityId: string;
  globalRoles: readonly string[];
};

export type Intent = "acknowledge";

export type ExecuteRequest = {
  identity: Person;
  intent: Intent;
};

export type ExecuteResult =
  | { kind: "stub"; text: string }
  | { kind: "rejected"; reason: "unknown-intent" };
