export type Person = {
  identityId: string;
  globalRoles: readonly string[];
};

export type Intent = "start";

export type ExecuteRequest = {
  identity: Person;
  intent: Intent;
  deepLinkPayload?: string;
};

export type ExecuteResult =
  | { kind: "message"; text: string }
  | { kind: "rejected"; reason: "unknown-intent" };
