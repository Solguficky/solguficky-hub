import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  MeetupLifecycle,
  MeetupsService,
  MeetupVisibility,
} from "../../gen/meetups/v1/meetups_service_pb.js";
import type { Person } from "../application/types.js";
import { requestIdHeader } from "../identity/client.js";
import type {
  MeetupListResult,
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
  | "getMeetup"
  | "listVisibleMeetups"
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
        cause.code === Code.InvalidArgument
      ) {
        return { kind: "invalid", message: cause.message };
      }
      return { kind: "unavailable", cause };
    }
  };
  const options = (requestId?: string) => ({
    timeoutMs,
    ...(requestId === undefined
      ? {}
      : { headers: { [requestIdHeader]: requestId } }),
  });
  return {
    listVisible: async (person, requestId): Promise<MeetupListResult> => {
      try {
        const response = await rpc.listVisibleMeetups(
          { viewer: viewer(person) },
          options(requestId),
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
    createDraft: (person, id, requestId) =>
      call(async () =>
        toSnapshot(
          await rpc.createMeetupDraft(
            { viewer: viewer(person), id },
            options(requestId),
          ),
        ),
      ),
    get: async (person, id, requestId) => {
      try {
        return {
          kind: "ok",
          meetup: toSnapshot(
            await rpc.getMeetup(
              { viewer: viewer(person), id },
              options(requestId),
            ),
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
    changeAttributes: (person, meetup, requestId) =>
      call(async () =>
        toSnapshot(
          await rpc.changeMeetupAttributes(
            {
              viewer: viewer(person),
              id: meetup.id,
              title: meetup.title,
              description: meetup.description,
              venue: meetup.venue,
              kind: "",
              calendarLink: "",
            },
            options(requestId),
          ),
        ),
      ),
    setSchedule: (person, id, schedule, requestId) =>
      call(async () =>
        toSnapshot(
          await rpc.setMeetupSchedule(
            {
              viewer: viewer(person),
              id,
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
            options(requestId),
          ),
        ),
      ),
    publish: (person, id, requestId) =>
      call(async () =>
        toSnapshot(
          await rpc.publishMeetup(
            { viewer: viewer(person), id },
            options(requestId),
          ),
        ),
      ),
  };
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
    globalRoles: person.globalRoles.map((role) =>
      role === "admin" ? GlobalRole.ADMIN : GlobalRole.UNSPECIFIED,
    ),
  };
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
