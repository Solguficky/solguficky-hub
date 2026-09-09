import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  ListVisibleMeetupsResponseSchema,
  MeetupSummarySchema,
} from "../../gen/meetups/v1/meetups_service_pb.js";
import { createMeetupsAdapter } from "./client.js";

const person = { identityId: "viewer-id", globalRoles: [] };

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

    await expect(meetups.listVisible(person, "request-1")).resolves.toEqual({
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
});
