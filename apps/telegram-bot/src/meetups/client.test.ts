import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  MeetupLifecycle,
  MeetupMaterialSchema,
  MeetupVisibility,
} from "../../gen/meetups/v1/meetups_pb.js";
import {
  ListArchivedMeetupsResponseSchema,
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
    materials: [],
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
    attachMaterial: vi.fn(),
    removeMaterial: vi.fn(),
    markMeetupHeld: vi.fn(),
    scheduleMeetupPublication: vi.fn(),
    cancelMeetupPublication: vi.fn(),
    getMeetup: vi.fn(),
    listArchivedMeetups: vi.fn(),
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

  it("sends the publication moment as local community time with the version", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.scheduleMeetupPublication.mockResolvedValue(
      create(MeetupSnapshotSchema, {
        id: "meetup-id",
        lifecycle: MeetupLifecycle.PLANNED,
        visibility: MeetupVisibility.HIDDEN,
        version: 8n,
        scheduledPublishAt: "2026-10-01T16:30:00Z",
      }),
    );
    rpc.cancelMeetupPublication.mockResolvedValue(
      create(MeetupSnapshotSchema, {
        id: "meetup-id",
        lifecycle: MeetupLifecycle.PLANNED,
        visibility: MeetupVisibility.HIDDEN,
        version: 9n,
      }),
    );
    const meetups = createMeetupsAdapter(rpc, 3_000, "Europe/Moscow");

    const scheduled = await meetups.schedulePublication(
      person,
      storedMeetup(7),
      { year: 2026, month: 10, day: 1, hours: 19, minutes: 30 },
    );
    const cancelled = await meetups.cancelPublication(person, storedMeetup(8));

    expect(rpc.scheduleMeetupPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "meetup-id",
        expectedVersion: 7n,
        moment: {
          date: { year: 2026, month: 10, day: 1 },
          time: { hours: 19, minutes: 30 },
        },
      }),
      expect.anything(),
    );
    expect(scheduled).toMatchObject({
      kind: "ok",
      meetup: {
        version: 8,
        publishAt: { year: 2026, month: 10, day: 1, hours: 19, minutes: 30 },
      },
    });
    expect(rpc.cancelMeetupPublication).toHaveBeenCalledWith(
      expect.objectContaining({ id: "meetup-id", expectedVersion: 8n }),
      expect.anything(),
    );
    expect(cancelled.kind === "ok" && cancelled.meetup.publishAt).toBe(
      undefined,
    );
  });

  // Контракт разводит коды намеренно (integration.md): прошедший момент и
  // опубликованная сходка ведут на разные кадры, и различие не должно
  // теряться в адаптере.
  it("keeps a past moment apart from a meetup that cannot be scheduled", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.scheduleMeetupPublication
      .mockRejectedValueOnce(
        new ConnectError("moment in the past", Code.InvalidArgument),
      )
      .mockRejectedValueOnce(
        new ConnectError("already published", Code.FailedPrecondition),
      );
    const meetups = createMeetupsAdapter(rpc);
    const moment = { year: 2026, month: 1, day: 1, hours: 10, minutes: 0 };

    const past = await meetups.schedulePublication(
      person,
      storedMeetup(7),
      moment,
    );
    const published = await meetups.schedulePublication(
      person,
      storedMeetup(7),
      moment,
    );

    expect(past).toEqual({
      kind: "invalid",
      message: expect.stringContaining("moment in the past"),
    });
    expect(published).toEqual({
      kind: "invalid",
      message: expect.stringContaining("already published"),
      precondition: true,
    });
  });

  it("maps ordered message and file materials from a meetup snapshot", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.getMeetup.mockResolvedValue(
      create(MeetupSnapshotSchema, {
        id: "meetup-id",
        title: "Настолки",
        lifecycle: MeetupLifecycle.PLANNED,
        visibility: MeetupVisibility.VISIBLE,
        materials: [
          create(MeetupMaterialSchema, {
            id: "message-id",
            title: "Опрос",
            source: {
              source: {
                case: "messageLink",
                value: "https://t.me/c/42/7",
              },
            },
          }),
          create(MeetupMaterialSchema, {
            id: "file-id",
            title: "Афиша",
            source: { source: { case: "fileId", value: "bot-file-id" } },
          }),
        ],
      }),
    );
    const meetups = createMeetupsAdapter(rpc);

    await expect(meetups.get(person, "meetup-id")).resolves.toMatchObject({
      kind: "ok",
      meetup: {
        materials: [
          {
            id: "message-id",
            title: "Опрос",
            source: {
              kind: "message-link",
              url: "https://t.me/c/42/7",
            },
          },
          {
            id: "file-id",
            title: "Афиша",
            source: { kind: "file", fileId: "bot-file-id" },
          },
        ],
      },
    });
  });

  it("sends attach and remove material requests with caller ids", async () => {
    const rpc = rpcWithList(vi.fn());
    const response = create(MeetupSnapshotSchema, {
      id: "meetup-id",
      lifecycle: MeetupLifecycle.PLANNED,
      visibility: MeetupVisibility.VISIBLE,
    });
    rpc.attachMaterial.mockResolvedValue(response);
    rpc.removeMaterial.mockResolvedValue(response);
    const meetups = createMeetupsAdapter(rpc);

    await meetups.attachMaterial({
      person,
      meetupId: "meetup-id",
      material: {
        id: "material-id",
        title: "Афиша",
        source: { kind: "file", fileId: "bot-file-id" },
      },
    });
    await meetups.removeMaterial({
      person,
      meetupId: "meetup-id",
      materialId: "material-id",
    });

    expect(rpc.attachMaterial).toHaveBeenCalledWith(
      {
        viewer: { identityId: "viewer-id", globalRoles: [] },
        id: "meetup-id",
        materialId: "material-id",
        title: "Афиша",
        source: { source: { case: "fileId", value: "bot-file-id" } },
      },
      { timeoutMs: 3_000 },
    );
    expect(rpc.removeMaterial).toHaveBeenCalledWith(
      {
        viewer: { identityId: "viewer-id", globalRoles: [] },
        id: "meetup-id",
        materialId: "material-id",
      },
      { timeoutMs: 3_000 },
    );
  });

  it("maps archived meetups to their human-distinguishable status", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.listArchivedMeetups.mockResolvedValue(
      create(ListArchivedMeetupsResponseSchema, {
        meetups: [
          create(MeetupSummarySchema, {
            id: "held-meetup",
            title: "Состоявшаяся",
            lifecycle: MeetupLifecycle.HELD,
          }),
          create(MeetupSummarySchema, {
            id: "cancelled-meetup",
            title: "Отменённая",
            lifecycle: MeetupLifecycle.CANCELLED,
          }),
          create(MeetupSummarySchema, {
            id: "past-meetup",
            title: "Прошедшая",
            lifecycle: MeetupLifecycle.PLANNED,
          }),
        ],
      }),
    );
    const meetups = createMeetupsAdapter(rpc);

    await expect(meetups.listArchived(person)).resolves.toEqual({
      kind: "ok",
      meetups: [
        { id: "held-meetup", title: "Состоявшаяся", status: "held" },
        { id: "cancelled-meetup", title: "Отменённая", status: "cancelled" },
        { id: "past-meetup", title: "Прошедшая", status: "past" },
      ],
    });
    expect(rpc.listArchivedMeetups).toHaveBeenCalledWith(
      { viewer: { identityId: "viewer-id", globalRoles: [] } },
      { timeoutMs: 3_000 },
    );
  });

  it("sends a mark-held request carrying the caller's expected version", async () => {
    const rpc = rpcWithList(vi.fn());
    rpc.markMeetupHeld.mockResolvedValue(
      create(MeetupSnapshotSchema, {
        id: "meetup-id",
        lifecycle: MeetupLifecycle.HELD,
        visibility: MeetupVisibility.VISIBLE,
        version: 3n,
      }),
    );
    const meetups = createMeetupsAdapter(rpc);

    await expect(
      meetups.markHeld(person, storedMeetup(2)),
    ).resolves.toMatchObject({ kind: "ok", meetup: { lifecycle: "held" } });
    expect(rpc.markMeetupHeld).toHaveBeenCalledWith(
      {
        viewer: { identityId: "viewer-id", globalRoles: [] },
        id: "meetup-id",
        expectedVersion: 2n,
      },
      { timeoutMs: 3_000 },
    );
  });
});
