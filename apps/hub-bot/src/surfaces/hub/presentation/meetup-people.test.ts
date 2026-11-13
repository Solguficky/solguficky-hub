import { describe, expect, it, vi } from "vitest";
import type { AccessRight } from "../../../auction-ui/index.js";
import type { Dispatcher } from "../application/dispatcher.js";
import type { ExecuteResult } from "../application/types.js";
import type {
  OrganizerResolver,
  OrganizerUsernameResult,
} from "../identity/port.js";
import type { MeetupSnapshot } from "../meetups/port.js";
import {
  canOrganizeMeetups,
  meetupViewer,
  withMeetupPeople,
} from "./meetup-people.js";

const viewer = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "place-bids", "organize-meetups"] as AccessRight[],
};
const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce";
const leshaId = "0192f0a0-0000-7000-8000-00000000a001";
const mashaId = "0192f0a0-0000-7000-8000-00000000a002";

function snapshot(
  author: string,
  organizers: readonly string[] = [author],
): MeetupSnapshot {
  return {
    id: meetupId,
    author,
    title: "Настолки",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "visible",
    version: 1,
    materials: [],
    organizers,
  };
}

function dispatcherReturning(result: ExecuteResult): Dispatcher {
  return { execute: async () => result };
}

function identityAnswering(
  answers: Readonly<Record<string, OrganizerUsernameResult>>,
) {
  const resolveOrganizerUsername = vi.fn<
    OrganizerResolver["resolveOrganizerUsername"]
  >(async (_, contact) => answers[contact.identityId] ?? { kind: "not-found" });
  return { resolveOrganizerUsername };
}

function view(
  result: ExecuteResult,
  organizers: Partial<OrganizerResolver> = {},
  person = viewer,
) {
  return withMeetupPeople(dispatcherReturning(result), organizers).execute({
    identity: person,
    intent: "view-meetup",
    meetupId,
    requestId: "req-1",
  });
}

describe("people on the meetup card", () => {
  it("names the viewer without asking Identity", async () => {
    const identity = identityAnswering({});
    const result = await view(
      { kind: "meetup-card", meetup: snapshot(viewer.identityId) },
      identity,
    );

    expect(result).toMatchObject({
      kind: "meetup-card",
      people: { author: { kind: "self" }, organizers: [{ kind: "self" }] },
    });
    expect(identity.resolveOrganizerUsername).not.toHaveBeenCalled();
  });

  it("asks Identity once per person, with the meetup of the card", async () => {
    const identity = identityAnswering({
      [leshaId]: { kind: "resolved", telegramUsername: "lesha" },
      [mashaId]: { kind: "resolved", telegramUsername: "masha" },
    });
    const result = await view(
      { kind: "meetup-card", meetup: snapshot(leshaId, [leshaId, mashaId]) },
      identity,
    );

    expect(result).toMatchObject({
      people: {
        author: { kind: "username", telegramUsername: "lesha" },
        organizers: [
          { kind: "username", telegramUsername: "lesha" },
          { kind: "username", telegramUsername: "masha" },
        ],
      },
    });
    expect(identity.resolveOrganizerUsername).toHaveBeenCalledTimes(2);
    expect(identity.resolveOrganizerUsername).toHaveBeenCalledWith(
      viewer,
      { meetupId, identityId: leshaId },
      { requestId: "req-1" },
    );
  });

  it("names the author apart from a roster without them", async () => {
    const identity = identityAnswering({
      [leshaId]: { kind: "resolved", telegramUsername: "lesha" },
      [mashaId]: { kind: "resolved", telegramUsername: "masha" },
    });
    const result = await view(
      { kind: "meetup-card", meetup: snapshot(leshaId, [mashaId]) },
      identity,
    );

    expect(result).toMatchObject({
      people: {
        author: { kind: "username", telegramUsername: "lesha" },
        organizers: [{ kind: "username", telegramUsername: "masha" }],
      },
    });
  });

  it("names the people on a card redrawn after a command", async () => {
    const result = await view(
      {
        kind: "meetup-state-changed",
        action: "hold",
        meetup: snapshot(leshaId),
      },
      identityAnswering({
        [leshaId]: { kind: "resolved", telegramUsername: "lesha" },
      }),
    );

    expect(result).toMatchObject({
      kind: "meetup-state-changed",
      people: { author: { kind: "username", telegramUsername: "lesha" } },
    });
  });

  it.each<[string, OrganizerUsernameResult]>([
    ["has no username", { kind: "resolved" }],
    ["is not confirmed", { kind: "not-found" }],
    ["cannot be reached", { kind: "unavailable", cause: new Error("down") }],
    [
      "rejects the call",
      { kind: "rejected", code: "InvalidArgument", cause: new Error("no") },
    ],
  ])("leaves out a person Identity %s about", async (_, answer) => {
    const result = await view(
      { kind: "meetup-card", meetup: snapshot(leshaId) },
      identityAnswering({ [leshaId]: answer }),
    );

    expect(result).toMatchObject({
      kind: "meetup-card",
      people: { organizers: [] },
    });
    expect(result).not.toHaveProperty("people.author");
  });

  // Identity называет только держателя `organize-meetups` (ADR-076, п. 10):
  // смотрящий, оставшийся в составе без права, не видит себя ни организатором,
  // ни автором — как его не видят остальные.
  it("does not name the viewer who lost organize-meetups", async () => {
    const identity = identityAnswering({});
    const withoutRight = {
      ...viewer,
      rights: ["access-hub", "place-bids"] as AccessRight[],
    };
    const result = await view(
      { kind: "meetup-card", meetup: snapshot(viewer.identityId) },
      identity,
      withoutRight,
    );

    expect(result).toMatchObject({ people: { organizers: [] } });
    expect(result).not.toHaveProperty("people.author");
    expect(identity.resolveOrganizerUsername).not.toHaveBeenCalled();
  });

  it("names every organizer of a large roster", async () => {
    const roster = Array.from(
      { length: 12 },
      (_, index) =>
        `0192f0a0-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
    );
    const identity = identityAnswering(
      Object.fromEntries(
        roster.map((id, index) => [
          id,
          { kind: "resolved", telegramUsername: `person${index}` },
        ]),
      ),
    );
    const result = await view(
      { kind: "meetup-card", meetup: snapshot(roster[0] ?? "", roster) },
      identity,
    );

    expect(
      result.kind === "meetup-card" && result.people?.organizers,
    ).toHaveLength(12);
  });

  it("does not ask Identity for a meetup the viewer cannot see", async () => {
    const identity = identityAnswering({
      [leshaId]: { kind: "resolved", telegramUsername: "lesha" },
    });
    const result = await view({ kind: "meetup-not-found" }, identity);

    expect(result).toEqual({ kind: "meetup-not-found" });
    expect(identity.resolveOrganizerUsername).not.toHaveBeenCalled();
  });

  it("does not ask Identity for the form draft but tells its relation", async () => {
    const identity = identityAnswering({});
    const result = await view(
      { kind: "draft", meetup: snapshot(viewer.identityId) },
      identity,
    );

    expect(result).toEqual({
      kind: "draft",
      meetup: snapshot(viewer.identityId),
      viewer: { manages: true, administrator: false },
    });
    expect(identity.resolveOrganizerUsername).not.toHaveBeenCalled();
  });
});

describe("viewer's relation to the meetup", () => {
  it("lets an organizer from the roster manage the meetup", () => {
    expect(
      meetupViewer(viewer, snapshot(leshaId, [viewer.identityId])),
    ).toEqual({ manages: true, administrator: false });
  });

  it("does not let a member manage a meetup outside their roster", () => {
    expect(meetupViewer(viewer, snapshot(leshaId))).toEqual({
      manages: false,
      administrator: false,
    });
  });

  it("does not take a roster entry without organize-meetups", () => {
    const blocked = { ...viewer, rights: [] as AccessRight[] };
    expect(
      meetupViewer(blocked, snapshot(leshaId, [viewer.identityId])),
    ).toEqual({ manages: false, administrator: false });
  });

  // Автор, вышедший из состава, сходку читает, но не ведёт (ADR-076, п. 9).
  it("does not let the author outside the roster manage the meetup", () => {
    expect(
      meetupViewer(viewer, snapshot(viewer.identityId, [leshaId])),
    ).toEqual({ manages: false, administrator: false });
  });

  it("lets the administrator manage any meetup", () => {
    const admin = {
      ...viewer,
      rights: ["access-hub", "manage-meetups"] as AccessRight[],
    };
    expect(meetupViewer(admin, snapshot(leshaId))).toEqual({
      manages: true,
      administrator: true,
    });
  });

  it("lets either right create a meetup", () => {
    expect(canOrganizeMeetups(viewer)).toBe(true);
    expect(canOrganizeMeetups({ rights: ["manage-meetups"] })).toBe(true);
    expect(canOrganizeMeetups({ rights: ["access-hub", "place-bids"] })).toBe(
      false,
    );
  });
});
