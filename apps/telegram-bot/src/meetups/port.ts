import type { Person } from "../application/types.js";
import type { RpcMetadata } from "../rpc-metadata.js";

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
  lifecycle: "planned" | "held" | "cancelled";
  visibility: "hidden" | "visible";
  // Версия агрегата, из которой принято решение: команда изменения или перехода
  // несёт её обратно как `expected_version`, и Meetups сравнивает её в предикате
  // записи (PER-78).
  version: number;
};

export type MeetupSummary = {
  id: string;
  title: string;
  schedule?: { year: number; month: number; day: number };
};

export type MeetupFailure =
  | { kind: "forbidden" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict" }
  | { kind: "timeout"; cause: unknown }
  | { kind: "unavailable"; cause: unknown };

export type MeetupResult =
  | { kind: "ok"; meetup: MeetupSnapshot }
  | MeetupFailure;

export type MeetupGetResult = MeetupResult | { kind: "not-found" };

export type MeetupListResult =
  | { kind: "ok"; meetups: readonly MeetupSummary[] }
  | MeetupFailure;

export type Meetups = {
  listVisible(person: Person, meta?: RpcMetadata): Promise<MeetupListResult>;
  createDraft(
    person: Person,
    id: string,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  get(person: Person, id: string, meta?: RpcMetadata): Promise<MeetupGetResult>;
  changeAttributes(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  setSchedule(
    person: Person,
    meetup: MeetupSnapshot,
    schedule: MeetupSchedule,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  publish(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  unpublish(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
  cancel(
    person: Person,
    meetup: MeetupSnapshot,
    meta?: RpcMetadata,
  ): Promise<MeetupResult>;
};
