import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  MeetupLifecycle,
  MeetupVisibility,
} from "../../gen/meetups/v1/meetups_pb.js";
import { MeetupsService } from "../../gen/meetups/v1/meetups_service_pb.js";
import type { Person } from "../application/types.js";
import { callHeaders, type RpcMetadata } from "../rpc-metadata.js";
import type {
  ArchivedMeetupListResult,
  ArchivedMeetupSummary,
  MeetupListResult,
  MeetupMaterial,
  MeetupMaterialSource,
  MeetupResult,
  MeetupSnapshot,
  MeetupSummary,
  Meetups,
} from "./port.js";

type MeetupsRpc = Pick<
  Client<typeof MeetupsService>,
  | "createMeetupDraft"
  | "changeMeetupAttributes"
  | "setMeetupSchedule"
  | "publishMeetup"
  | "unpublishMeetup"
  | "cancelMeetup"
  | "attachMaterial"
  | "removeMaterial"
  | "markMeetupHeld"
  | "getMeetup"
  | "listVisibleMeetups"
  | "listArchivedMeetups"
>;

export type MeetupsClient = Meetups & { close(): void };

export function createMeetupsClient(
  baseUrl: string,
  timeoutMs = 3_000,
): MeetupsClient {
  const sessionManager = new Http2SessionManager(baseUrl);
  const rpc = createClient(
    MeetupsService,
    createGrpcTransport({
      baseUrl,
      defaultTimeoutMs: timeoutMs,
      sessionManager,
    }),
  );
  const client = createMeetupsAdapter(rpc, timeoutMs);
  return { ...client, close: () => sessionManager.abort() };
}

export function createMeetupsAdapter(
  rpc: MeetupsRpc,
  timeoutMs = 3_000,
): Meetups {
  const call = async (
    operation: () => Promise<MeetupSnapshot>,
  ): Promise<MeetupResult> => {
    try {
      return { kind: "ok", meetup: await operation() };
    } catch (cause) {
      if (
        cause instanceof ConnectError &&
        cause.code === Code.DeadlineExceeded
      ) {
        return { kind: "timeout", cause };
      }
      if (
        cause instanceof ConnectError &&
        cause.code === Code.PermissionDenied
      ) {
        return { kind: "forbidden" };
      }
      if (
        cause instanceof ConnectError &&
        (cause.code === Code.InvalidArgument ||
          cause.code === Code.FailedPrecondition)
      ) {
        return { kind: "invalid", message: cause.message };
      }
      // ABORTED — настоящий конфликт версий, а не недоступность зависимости:
      // команда собрана верно, но показанный снимок устарел (PER-78).
      if (cause instanceof ConnectError && cause.code === Code.Aborted) {
        return { kind: "conflict" };
      }
      return { kind: "unavailable", cause };
    }
  };
  const options = (meta?: RpcMetadata) => ({
    timeoutMs,
    ...callHeaders(meta),
  });
  return {
    listVisible: async (person, meta): Promise<MeetupListResult> => {
      try {
        const response = await rpc.listVisibleMeetups(
          { viewer: viewer(person) },
          options(meta),
        );
        return { kind: "ok", meetups: response.meetups.map(toSummary) };
      } catch (cause) {
        if (
          cause instanceof ConnectError &&
          cause.code === Code.DeadlineExceeded
        ) {
          return { kind: "timeout", cause };
        }
        if (
          cause instanceof ConnectError &&
          cause.code === Code.PermissionDenied
        ) {
          return { kind: "forbidden" };
        }
        if (
          cause instanceof ConnectError &&
          cause.code === Code.InvalidArgument
        ) {
          return { kind: "invalid", message: cause.message };
        }
        return { kind: "unavailable", cause };
      }
    },
    listArchived: async (person, meta): Promise<ArchivedMeetupListResult> => {
      try {
        const response = await rpc.listArchivedMeetups(
          { viewer: viewer(person) },
          options(meta),
        );
        return { kind: "ok", meetups: response.meetups.map(toArchivedSummary) };
      } catch (cause) {
        if (
          cause instanceof ConnectError &&
          cause.code === Code.DeadlineExceeded
        ) {
          return { kind: "timeout", cause };
        }
        if (
          cause instanceof ConnectError &&
          cause.code === Code.PermissionDenied
        ) {
          return { kind: "forbidden" };
        }
        if (
          cause instanceof ConnectError &&
          cause.code === Code.InvalidArgument
        ) {
          return { kind: "invalid", message: cause.message };
        }
        return { kind: "unavailable", cause };
      }
    },
    createDraft: (person, id, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.createMeetupDraft(
            { viewer: viewer(person), id },
            options(meta),
          ),
        ),
      ),
    get: async (person, id, meta) => {
      try {
        return {
          kind: "ok",
          meetup: toSnapshot(
            await rpc.getMeetup({ viewer: viewer(person), id }, options(meta)),
          ),
        };
      } catch (cause) {
        if (
          cause instanceof ConnectError &&
          cause.code === Code.DeadlineExceeded
        ) {
          return { kind: "timeout", cause };
        }
        if (cause instanceof ConnectError && cause.code === Code.NotFound) {
          return { kind: "not-found" };
        }
        if (
          cause instanceof ConnectError &&
          cause.code === Code.PermissionDenied
        ) {
          return { kind: "forbidden" };
        }
        if (
          cause instanceof ConnectError &&
          cause.code === Code.InvalidArgument
        ) {
          return { kind: "invalid", message: cause.message };
        }
        return { kind: "unavailable", cause };
      }
    },
    changeAttributes: (person, meetup, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.changeMeetupAttributes(
            {
              viewer: viewer(person),
              id: meetup.id,
              expectedVersion: BigInt(meetup.version),
              title: meetup.title,
              description: meetup.description,
              venue: meetup.venue,
              kind: "",
              calendarLink: "",
            },
            options(meta),
          ),
        ),
      ),
    setSchedule: (person, meetup, schedule, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.setMeetupSchedule(
            {
              viewer: viewer(person),
              id: meetup.id,
              expectedVersion: BigInt(meetup.version),
              schedule: {
                form: {
                  case: "fixed",
                  value: {
                    precision: {
                      case: "dayStart",
                      value: {
                        date: {
                          year: schedule.year,
                          month: schedule.month,
                          day: schedule.day,
                        },
                        time: {
                          hours: schedule.hours,
                          minutes: schedule.minutes,
                        },
                      },
                    },
                  },
                },
              },
            },
            options(meta),
          ),
        ),
      ),
    publish: (person, meetup, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.publishMeetup(
            {
              viewer: viewer(person),
              id: meetup.id,
              expectedVersion: BigInt(meetup.version),
            },
            options(meta),
          ),
        ),
      ),
    unpublish: (person, meetup, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.unpublishMeetup(
            {
              viewer: viewer(person),
              id: meetup.id,
              expectedVersion: BigInt(meetup.version),
            },
            options(meta),
          ),
        ),
      ),
    cancel: (person, meetup, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.cancelMeetup(
            {
              viewer: viewer(person),
              id: meetup.id,
              expectedVersion: BigInt(meetup.version),
            },
            options(meta),
          ),
        ),
      ),
    markHeld: (person, meetup, meta) =>
      call(async () =>
        toSnapshot(
          await rpc.markMeetupHeld(
            {
              viewer: viewer(person),
              id: meetup.id,
              expectedVersion: BigInt(meetup.version),
            },
            options(meta),
          ),
        ),
      ),
    attachMaterial: ({ person, meetupId, material, meta }) =>
      call(async () =>
        toSnapshot(
          await rpc.attachMaterial(
            {
              viewer: viewer(person),
              id: meetupId,
              materialId: material.id,
              title: material.title,
              source: fromMaterialSource(material.source),
            },
            options(meta),
          ),
        ),
      ),
    removeMaterial: ({ person, meetupId, materialId, meta }) =>
      call(async () =>
        toSnapshot(
          await rpc.removeMaterial(
            { viewer: viewer(person), id: meetupId, materialId },
            options(meta),
          ),
        ),
      ),
  };
}

function fromMaterialSource(source: MeetupMaterialSource) {
  return source.kind === "message-link"
    ? { source: { case: "messageLink" as const, value: source.url } }
    : { source: { case: "fileId" as const, value: source.fileId } };
}

function toSummary(
  value: Awaited<
    ReturnType<MeetupsRpc["listVisibleMeetups"]>
  >["meetups"][number],
): MeetupSummary {
  const summary: MeetupSummary = { id: value.id, title: value.title };
  const date = scheduleDate(value.schedule);
  return date === undefined ? summary : { ...summary, schedule: date };
}

function toArchivedSummary(
  value: Awaited<
    ReturnType<MeetupsRpc["listArchivedMeetups"]>
  >["meetups"][number],
): ArchivedMeetupSummary {
  const summary = toSummary(value);
  // Meetups отдаёт в архив только held, cancelled и просроченную planned
  // (Archive.fs); внутри архивного ответа planned однозначно значит «прошедшая
  // и не отмечена состоявшейся» — отдельного статуса на это в контракте нет.
  const status =
    value.lifecycle === MeetupLifecycle.HELD
      ? "held"
      : value.lifecycle === MeetupLifecycle.CANCELLED
        ? "cancelled"
        : "past";
  return { ...summary, status };
}

function scheduleDate(
  schedule: Awaited<
    ReturnType<MeetupsRpc["listVisibleMeetups"]>
  >["meetups"][number]["schedule"],
): MeetupSummary["schedule"] {
  const form = schedule?.form;
  if (form?.case !== "fixed" && form?.case !== "tentative") {
    return undefined;
  }
  const precision = form.value.precision;
  if (precision.case === "day") {
    return calendarDate(precision.value);
  }
  if (precision.case === "dayStart") {
    return precision.value.date === undefined
      ? undefined
      : calendarDate(precision.value.date);
  }
  if (precision.case === "interval") {
    return precision.value.start?.date === undefined
      ? undefined
      : calendarDate(precision.value.start.date);
  }
  return undefined;
}

function calendarDate(value: {
  year: number;
  month: number;
  day: number;
}): NonNullable<MeetupSummary["schedule"]> {
  return { year: value.year, month: value.month, day: value.day };
}

function viewer(person: Person) {
  return {
    identityId: person.identityId,
    globalRoles: person.globalRoles.map(roleValue),
  };
}

// Строка роли пришла из Identity. Неизвестное имя не превращается в разрешение:
// Meetups отбрасывает UNSPECIFIED, как и любое значение вне своего словаря.
function roleValue(role: string): GlobalRole {
  switch (role) {
    case "maintainer":
      return GlobalRole.MAINTAINER;
    case "admin":
      return GlobalRole.ADMIN;
    case "member":
      return GlobalRole.MEMBER;
    case "public":
      return GlobalRole.PUBLIC;
    default:
      return GlobalRole.UNSPECIFIED;
  }
}

function toSnapshot(
  value: Awaited<ReturnType<MeetupsRpc["createMeetupDraft"]>>,
): MeetupSnapshot {
  const snapshot: MeetupSnapshot = {
    id: value.id,
    title: value.title,
    description: value.description,
    venue: value.venue,
    lifecycle: toLifecycle(value.lifecycle),
    visibility: toVisibility(value.visibility),
    version: Number(value.version),
    materials: value.materials.map(toMaterial),
  };
  const fixed =
    value.schedule?.form.case === "fixed"
      ? value.schedule.form.value.precision
      : undefined;
  if (
    fixed?.case === "dayStart" &&
    fixed.value.date !== undefined &&
    fixed.value.time !== undefined
  ) {
    snapshot.schedule = { ...fixed.value.date, ...fixed.value.time };
  }
  return snapshot;
}

function toMaterial(
  value: Awaited<ReturnType<MeetupsRpc["getMeetup"]>>["materials"][number],
): MeetupMaterial {
  const source = value.source?.source;
  if (source?.case === "messageLink") {
    return {
      id: value.id,
      title: value.title,
      source: { kind: "message-link", url: source.value },
    };
  }
  if (source?.case === "fileId") {
    return {
      id: value.id,
      title: value.title,
      source: { kind: "file", fileId: source.value },
    };
  }
  throw new Error(`Meetups returned material ${value.id} without a source`);
}

function toLifecycle(
  value: MeetupLifecycle,
): NonNullable<MeetupSnapshot["lifecycle"]> {
  switch (value) {
    case MeetupLifecycle.PLANNED:
      return "planned";
    case MeetupLifecycle.HELD:
      return "held";
    case MeetupLifecycle.CANCELLED:
      return "cancelled";
    default:
      throw new Error(`Meetups returned unsupported lifecycle ${value}`);
  }
}

function toVisibility(
  value: MeetupVisibility,
): NonNullable<MeetupSnapshot["visibility"]> {
  switch (value) {
    case MeetupVisibility.HIDDEN:
      return "hidden";
    case MeetupVisibility.VISIBLE:
      return "visible";
    default:
      throw new Error(`Meetups returned unsupported visibility ${value}`);
  }
}
