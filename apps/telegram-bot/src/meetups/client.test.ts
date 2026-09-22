import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  MeetupLifecycle,
  MeetupVisibility,
} from "../../gen/meetups/v1/meetups_pb.js";
import {
  ListVisibleMeetupsResponseSchema,
  MeetupSnapshotSchema,
  MeetupSummarySchema,
} from "../../gen/meetups/v1/meetups_service_pb.js";
import { createMeetupsAdapter } from "./client.js";
import type { MeetupSnapshot } from "./port.js";

const person = { identityId: "viewer-id", globalRoles: [] };

function storedMeetup(version: number): MeetupSnapshot {
  return {
    id: "meetup-id",
    title: "Настолки",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "hidden",
    version,
  };
}

type ListVisibleMeetupsRpc = Parameters<
  typeof createMeetupsAdapter
>[0]["listVisibleMeetups"];

function rpcWithList(listVisibleMeetups: ListVisibleMeetupsRpc) {
  return {
    listVisibleMeetups,
    createMeetupDraft: vi.fn(),
    changeMeetupAttributes: vi.fn(),
    setMeetupSchedule: vi.fn(),
    publishMeetup: vi.fn(),
    unpublishMeetup: vi.fn(),
    cancelMeetup: vi.fn(),
    getMeetup: vi.fn(),
  };
}

describe("Meetups client", () => {
  it("passes the viewer to Meetups and maps every returned meetup", async () => {
    const listVisibleMeetups = vi.fn(async () =>
      create(ListVisibleMeetupsResponseSchema, {
        meetups: [
          create(MeetupSummarySchema, {
            id: "meetup-with-date",
            title: "Настолки",
            schedule: {
              form: {
                case: "fixed",
                value: {
                  precision: {
                    case: "day",
                    value: { year: 2026, month: 8, day: 15 },
                  },
                },
              },
            },
          }),
          create(MeetupSummarySchema, {
            id: "meetup-without-date",
            title: "Без даты",
            schedule: { form: { case: "noDate", value: {} } },
          }),
        ],
      }),
    );
    const meetups = createMeetupsAdapter(rpcWithList(listVisibleMeetups));

    await expect(
      meetups.listVisible(person, { requestId: "request-1" }),
    ).resolves.toEqual({
      kind: "ok",
      meetups: [
        {
          id: "meetup-with-date",
          title: "Настолки",
          schedule: { year: 2026, month: 8, day: 15 },
        },
        { id: "meetup-without-date", title: "Без даты" },
      ],
    });
    expect(listVisibleMeetups).toHaveBeenCalledWith(
      {
        viewer: { identityId: "viewer-id", globalRoles: [] },
      },
      { timeoutMs: 3_000, headers: { "x-request-id": "request-1" } },
    );
  });

  it("passes every known role through and sends an unknown name as unspecified", async () => {
    const listVisibleMeetups = vi.fn(async () =>
      create(ListVisibleMeetupsResponseSchema, { meetups: [] }),
    );
    const meetups = createMeetupsAdapter(rpcWithList(listVisibleMeetups));
    const viewer = {
      identityId: "viewer-id",
      globalRoles: ["maintainer", "admin", "member", "public", "owner"],
    };

    await meetups.listVisible(viewer, { requestId: "request-1" });

    expect(listVisibleMeetups).toHaveBeenCalledWith(
      {
        viewer: {
          identityId: "viewer-id",
          globalRoles: [
            GlobalRole.MAINTAINER,
            GlobalRole.ADMIN,
            GlobalRole.MEMBER,
            GlobalRole.PUBLIC,
            GlobalRole.UNSPECIFIED,
          ],
        },
      },
      { timeoutMs: 3_000, headers: { "x-request-id": "request-1" } },
    );
  });

  it("carries use_case next to the request id", async () => {
    const listVisibleMeetups = vi.fn(async () =>
      create(ListVisibleMeetupsResponseSchema, { meetups: [] }),
    );
    const meetups = createMeetupsAdapter(rpcWithList(listVisibleMeetups));

    await meetups.listVisible(person, {
      requestId: "request-1",
      useCase: "start",
    });
    expect(listVisibleMeetups).toHaveBeenCalledWith(
      {
        viewer: { identityId: "viewer-id", globalRoles: [] },
      },
      {
        timeoutMs: 3_000,
        headers: { "x-request-id": "request-1", "x-use-case": "start" },
      },
    );
  });

  it("sends no use_case header when the edge produced none", async () => {
    const listVisibleMeetups = vi.fn(async () =>
      create(ListVisibleMeetupsResponseSchema, { meetups: [] }),
    );
    const meetups = createMeetupsAdapter(rpcWithList(listVisibleMeetups));

    await meetups.listVisible(person, { requestId: "request-1" });
    expect(listVisibleMeetups).toHaveBeenCalledWith(
      {
        viewer: { identityId: "viewer-id", globalRoles: [] },
      },
      { timeoutMs: 3_000, headers: { "x-request-id": "request-1" } },
    );
  });

  it("keeps an unavailable response distinct from an empty list", async () => {
    const meetups = createMeetupsAdapter(
      rpcWithList(() =>
        Promise.reject(new ConnectError("down", Code.Unavailable)),
      ),
    );

    await expect(meetups.listVisible(person)).resolves.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a missing or hidden meetup to not-found", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.getMeetup.mockRejectedValue(new ConnectError("hidden", Code.NotFound));
    const meetups = createMeetupsAdapter(rpc);

    await expect(meetups.get(person, "meetup-id")).resolves.toEqual({
      kind: "not-found",
    });
  });

  it("carries the aggregate version in both directions", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.changeMeetupAttributes.mockResolvedValue(
      create(MeetupSnapshotSchema, {
        id: "meetup-id",
        title: "Настолки",
        lifecycle: MeetupLifecycle.PLANNED,
        visibility: MeetupVisibility.HIDDEN,
        version: 8n,
      }),
    );
    const meetups = createMeetupsAdapter(rpc);

    const result = await meetups.changeAttributes(person, storedMeetup(7));

    expect(rpc.changeMeetupAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ id: "meetup-id", expectedVersion: 7n }),
      expect.anything(),
    );
    expect(result).toMatchObject({ kind: "ok", meetup: { version: 8 } });
  });

  it("keeps a version conflict distinct from an unavailable response", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.setMeetupSchedule.mockRejectedValue(
      new ConnectError("the meetup changed concurrently", Code.Aborted),
    );
    const meetups = createMeetupsAdapter(rpc);

    await expect(
      meetups.setSchedule(person, storedMeetup(7), {
        year: 2026,
        month: 10,
        day: 3,
        hours: 19,
        minutes: 30,
      }),
    ).resolves.toEqual({ kind: "conflict" });

    expect(rpc.setMeetupSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 7n }),
      expect.anything(),
    );
  });
});
