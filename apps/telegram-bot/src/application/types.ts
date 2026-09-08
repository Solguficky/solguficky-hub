import type { MeetupSnapshot } from "../meetups/port.js";

export type Person = { identityId: string; globalRoles: readonly string[] };
export type DeepLink =
  | { kind: "meetup"; payload: string }
  | { kind: "unclassified"; payload: string };
export type FormField = "title" | "schedule" | "venue" | "description";

export type ExecuteRequest =
  | { identity: Person; intent: "start"; deepLink?: DeepLink }
  | {
      identity: Person;
      intent: "create-meetup";
      meetupId: string;
      requestId?: string;
    }
  | {
      identity: Person;
      intent: "set-meetup-field";
      field: FormField;
      value: string;
      meetupId: string;
      requestId?: string;
    }
  | {
      identity: Person;
      intent: "publish-meetup";
      meetupId: string;
      requestId?: string;
    };

export function startExecuteRequest(
  identity: Person,
  deepLink: DeepLink | undefined,
): ExecuteRequest {
  return deepLink === undefined
    ? { identity, intent: "start" }
    : { identity, intent: "start", deepLink };
}

export type ExecuteResult =
  | { kind: "message"; text: string }
  | { kind: "ask"; field: FormField; meetup: MeetupSnapshot; error?: string }
  | { kind: "preview"; meetup: MeetupSnapshot }
  | { kind: "published"; meetup: MeetupSnapshot }
  | {
      kind: "dependency-rejected";
      reason: "forbidden" | "unavailable";
    }
  | { kind: "dependency-rejected"; reason: "invalid"; message: string }
  | { kind: "rejected"; reason: string };
