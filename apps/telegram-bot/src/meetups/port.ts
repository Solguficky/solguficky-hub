import type { Person } from "../application/types.js";

export type MeetupSchedule = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
};

export type MeetupSnapshot = {
  id: string;
  title: string;
  description: string;
  venue: string;
  schedule?: MeetupSchedule;
  lifecycle?: "planned" | "held" | "cancelled";
  visibility?: "hidden" | "visible";
};

export type MeetupSummary = {
  id: string;
  title: string;
  schedule?: { year: number; month: number; day: number };
};

export type MeetupFailure =
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; cause: unknown };

export type MeetupResult =
  | { kind: "ok"; meetup: MeetupSnapshot }
  | MeetupFailure;

export type MeetupListResult =
  | { kind: "ok"; meetups: readonly MeetupSummary[] }
  | MeetupFailure;

export type Meetups = {
  listVisible(person: Person, requestId?: string): Promise<MeetupListResult>;
  createDraft(
    person: Person,
    id: string,
    requestId?: string,
  ): Promise<MeetupResult>;
  get(person: Person, id: string, requestId?: string): Promise<MeetupResult>;
  changeAttributes(
    person: Person,
    meetup: MeetupSnapshot,
    requestId?: string,
  ): Promise<MeetupResult>;
  setSchedule(
    person: Person,
    id: string,
    schedule: MeetupSchedule,
    requestId?: string,
  ): Promise<MeetupResult>;
  publish(
    person: Person,
    id: string,
    requestId?: string,
  ): Promise<MeetupResult>;
};
