import type { MeetupSnapshot, MeetupSummary } from "../meetups/port.js";

export type Person = { identityId: string; globalRoles: readonly string[] };
export type DeepLink =
  | { kind: "meetup"; payload: string }
  | { kind: "unclassified"; payload: string };
export type FormField = "title" | "schedule" | "venue" | "description";

export type ExecuteRequest =
  | { identity: Person; intent: "start"; deepLink?: DeepLink }
  | { identity: Person; intent: "list-visible-meetups"; requestId?: string }
  | {
      identity: Person;
      intent: "view-meetup";
      meetupId: string;
      requestId?: string;
    }
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
  | { kind: "meetup-list"; meetups: readonly MeetupSummary[] }
  | { kind: "meetup-card"; meetup: MeetupSnapshot }
  | { kind: "meetup-not-found" }
  | { kind: "ask"; field: FormField; meetup: MeetupSnapshot; error?: string }
  | { kind: "preview"; meetup: MeetupSnapshot }
  | { kind: "published"; meetup: MeetupSnapshot }
  | {
      kind: "dependency-rejected";
      reason: "forbidden" | "timeout" | "unavailable";
    }
  | { kind: "dependency-rejected"; reason: "invalid"; message: string }
  | { kind: "rejected"; reason: string };
