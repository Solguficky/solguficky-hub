import { describe, expect, it, vi } from "vitest";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import { createDispatcher } from "./dispatcher.js";

const identity = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles: ["admin"],
};
const empty: MeetupSnapshot = {
  id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce",
  title: "",
  description: "",
  venue: "",
};

function harness() {
  let snapshot = empty;
  const meetups: Meetups = {
    createDraft: vi.fn(async (_person, id) => ({
      kind: "ok" as const,
      meetup: { ...snapshot, id },
    })),
    get: vi.fn(async () => ({ kind: "ok" as const, meetup: snapshot })),
    changeAttributes: vi.fn(async (_person, meetup) => {
      snapshot = meetup;
      return { kind: "ok" as const, meetup };
    }),
    setSchedule: vi.fn(async (_person, _id, schedule) => {
      snapshot = { ...snapshot, schedule };
      return { kind: "ok" as const, meetup: snapshot };
    }),
    publish: vi.fn(async () => ({ kind: "ok" as const, meetup: snapshot })),
  };
  return { meetups, dispatcher: createDispatcher(meetups) };
}

describe("meetup creation form", () => {
  it("creates the draft on entry and persists every completed step", async () => {
    const { dispatcher, meetups } = harness();
    const created = await dispatcher.execute({
      identity,
      intent: "create-meetup",
      meetupId: empty.id,
    });
    expect(created).toMatchObject({ kind: "ask", field: "title" });
    if (created.kind !== "ask") return;
    const titled = await dispatcher.execute({
      identity,
      intent: "set-meetup-field",
      field: "title",
      value: "Осенняя сходка",
      meetupId: created.meetup.id,
    });
    expect(titled).toMatchObject({ kind: "ask", field: "schedule" });
    if (titled.kind !== "ask") return;
    const scheduled = await dispatcher.execute({
      identity,
      intent: "set-meetup-field",
      field: "schedule",
      value: "21.09.2026 19:30",
      meetupId: titled.meetup.id,
    });
    expect(scheduled).toMatchObject({ kind: "ask", field: "venue" });
    expect(meetups.createDraft).toHaveBeenCalledOnce();
    expect(meetups.changeAttributes).toHaveBeenCalledOnce();
    expect(meetups.setSchedule).toHaveBeenCalledOnce();
  });

  it("repeats an unparsed schedule step without changing the saved meetup", async () => {
    const { dispatcher, meetups } = harness();
    await dispatcher.execute({
      identity,
      intent: "set-meetup-field",
      field: "title",
      value: "Сходка",
      meetupId: empty.id,
    });
    const result = await dispatcher.execute({
      identity,
      intent: "set-meetup-field",
      field: "schedule",
      value: "когда-нибудь вечером",
      meetupId: empty.id,
    });
    expect(result).toMatchObject({
      kind: "ask",
      field: "schedule",
      meetup: { title: "Сходка" },
    });
    expect(meetups.setSchedule).not.toHaveBeenCalled();
  });

  it("passes the same meetup id on repeated publication", async () => {
    const { dispatcher, meetups } = harness();
    await dispatcher.execute({
      identity,
      intent: "publish-meetup",
      meetupId: empty.id,
    });
    await dispatcher.execute({
      identity,
      intent: "publish-meetup",
      meetupId: empty.id,
    });
    expect(meetups.publish).toHaveBeenNthCalledWith(
      1,
      identity,
      empty.id,
      undefined,
    );
    expect(meetups.publish).toHaveBeenNthCalledWith(
      2,
      identity,
      empty.id,
      undefined,
    );
  });

  it("forwards an ordinary user and surfaces the Meetups refusal", async () => {
    const meetups = harness().meetups;
    meetups.createDraft = vi.fn(async () => ({ kind: "forbidden" as const }));
    const dispatcher = createDispatcher(meetups);
    await expect(
      dispatcher.execute({
        identity: { ...identity, globalRoles: [] },
        intent: "create-meetup",
        meetupId: empty.id,
      }),
    ).resolves.toEqual({ kind: "dependency-rejected", reason: "forbidden" });
    expect(meetups.createDraft).toHaveBeenCalledOnce();
  });

  it("preserves an invalid argument message for the presentation", async () => {
    const meetups = harness().meetups;
    meetups.publish = vi.fn(async () => ({
      kind: "invalid" as const,
      message: "description is required",
    }));
    const dispatcher = createDispatcher(meetups);
    await expect(
      dispatcher.execute({
        identity,
        intent: "publish-meetup",
        meetupId: empty.id,
      }),
    ).resolves.toEqual({
      kind: "dependency-rejected",
      reason: "invalid",
      message: "description is required",
    });
  });

  it("repeats a field when Meetups rejects its value", async () => {
    const meetups = harness().meetups;
    meetups.changeAttributes = vi.fn(async () => ({
      kind: "invalid" as const,
      message: "title is too long",
    }));
    const dispatcher = createDispatcher(meetups);
    await expect(
      dispatcher.execute({
        identity,
        intent: "set-meetup-field",
        field: "title",
        value: "Слишком длинное название",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "ask",
      field: "title",
      error: "Не получилось сохранить значение: title is too long",
    });
  });
});
