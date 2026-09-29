import { describe, expect, it, vi } from "vitest";
import type {
  OrganizerResolver,
  OrganizerUsernameResult,
} from "../identity/port.js";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import { createDispatcher } from "./dispatcher.js";

const viewer = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles: ["member"],
};
const organizerId = "0192f0a0-0000-7000-8000-00000000a001";

function snapshot(author: string): MeetupSnapshot {
  return {
    id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
    author,
    title: "Настолки",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "visible",
    version: 1,
    materials: [],
  };
}

function meetupsReturning(result: Awaited<ReturnType<Meetups["get"]>>) {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const meetups: Meetups = {
    listVisible: notUsed,
    listArchived: notUsed,
    createDraft: notUsed,
    get: async () => result,
    changeAttributes: notUsed,
    setSchedule: notUsed,
    publish: notUsed,
    unpublish: notUsed,
    cancel: notUsed,
    markHeld: notUsed,
    schedulePublication: notUsed,
    cancelPublication: notUsed,
    attachMaterial: notUsed,
    removeMaterial: notUsed,
  };
  return meetups;
}

function organizersAnswering(result: OrganizerUsernameResult) {
  const resolveOrganizerUsername = vi
    .fn<OrganizerResolver["resolveOrganizerUsername"]>()
    .mockResolvedValue(result);
  return { resolveOrganizerUsername };
}

function view(meetups: Meetups, organizers?: OrganizerResolver) {
  return createDispatcher(meetups, undefined, undefined, organizers).execute({
    identity: viewer,
    intent: "view-meetup",
    meetupId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
    requestId: "req-1",
  });
}

describe("meetup author on the card", () => {
  it("names the viewer as the author without asking Identity", async () => {
    const organizers = organizersAnswering({ kind: "resolved" });
    const result = await view(
      meetupsReturning({ kind: "ok", meetup: snapshot(viewer.identityId) }),
      organizers,
    );

    expect(result).toMatchObject({
      kind: "meetup-card",
      author: { kind: "self" },
    });
    expect(organizers.resolveOrganizerUsername).not.toHaveBeenCalled();
  });

  it("names another author by the username Identity returns", async () => {
    const organizers = organizersAnswering({
      kind: "resolved",
      telegramUsername: "organizer",
    });
    const result = await view(
      meetupsReturning({ kind: "ok", meetup: snapshot(organizerId) }),
      organizers,
    );

    expect(result).toMatchObject({
      kind: "meetup-card",
      author: { kind: "organizer", telegramUsername: "organizer" },
    });
    expect(organizers.resolveOrganizerUsername).toHaveBeenCalledWith(
      viewer,
      organizerId,
      { requestId: "req-1" },
    );
  });

  it.each<[string, OrganizerUsernameResult]>([
    ["has no username", { kind: "resolved" }],
    ["is not an active organizer", { kind: "not-found" }],
    ["cannot be reached", { kind: "unavailable", cause: new Error("down") }],
    [
      "rejects the call",
      { kind: "rejected", code: "PermissionDenied", cause: new Error("no") },
    ],
  ])(
    "keeps the card without an author line when the author %s",
    async (_, answer) => {
      const result = await view(
        meetupsReturning({ kind: "ok", meetup: snapshot(organizerId) }),
        organizersAnswering(answer),
      );

      expect(result).toMatchObject({ kind: "meetup-card" });
      expect(result).not.toHaveProperty("author");
    },
  );

  it("does not ask Identity for a meetup the viewer cannot see", async () => {
    const organizers = organizersAnswering({
      kind: "resolved",
      telegramUsername: "organizer",
    });
    const result = await view(
      meetupsReturning({ kind: "not-found" }),
      organizers,
    );

    expect(result).toEqual({ kind: "meetup-not-found" });
    expect(organizers.resolveOrganizerUsername).not.toHaveBeenCalled();
  });
});
