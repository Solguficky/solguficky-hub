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
};

export type MeetupFailure =
  | { kind: "forbidden" }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; cause: unknown };

export type MeetupResult =
  | { kind: "ok"; meetup: MeetupSnapshot }
  | MeetupFailure;

export type Meetups = {
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
