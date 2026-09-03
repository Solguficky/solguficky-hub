export type Person = {
  identityId: string;
  globalRoles: readonly string[];
};

export type Intent = "start";

export type DeepLink =
  | { kind: "meetup"; payload: string }
  | { kind: "unclassified"; payload: string };

export type ExecuteRequest =
  | {
      identity: Person;
      intent: "start";
    }
  | {
      identity: Person;
      intent: "start";
      deepLink: DeepLink;
    };

export function startExecuteRequest(
  identity: Person,
  deepLink: DeepLink | undefined,
): ExecuteRequest {
  if (deepLink === undefined) {
    return { identity, intent: "start" };
  }
  return { identity, intent: "start", deepLink };
}

export type ExecuteResult =
  | { kind: "message"; text: string }
  | { kind: "rejected"; reason: "unknown-intent" };
