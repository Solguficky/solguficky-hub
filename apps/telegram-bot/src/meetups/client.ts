import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import { MeetupsService } from "../../gen/meetups/v1/meetups_service_pb.js";
import type { Person } from "../application/types.js";
import { requestIdHeader } from "../identity/client.js";
import type { MeetupResult, MeetupSnapshot, Meetups } from "./port.js";

type MeetupsRpc = Pick<
  Client<typeof MeetupsService>,
  | "createMeetupDraft"
  | "changeMeetupAttributes"
  | "setMeetupSchedule"
  | "publishMeetup"
  | "getMeetup"
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
    createDraft: (person, id, requestId) =>
      call(async () =>
        toSnapshot(
          await rpc.createMeetupDraft(
            { viewer: viewer(person), id },
            options(requestId),
          ),
        ),
      ),
    get: (person, id, requestId) =>
      call(async () =>
        toSnapshot(
          await rpc.getMeetup(
            { viewer: viewer(person), id },
            options(requestId),
          ),
        ),
      ),
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
