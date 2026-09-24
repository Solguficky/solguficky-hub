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
  lifecycle: "planned",
  visibility: "hidden",
  version: 1,
  materials: [],
};

function harness() {
  let snapshot = empty;
  const meetups: Meetups = {
    listVisible: vi.fn(async () => ({ kind: "ok" as const, meetups: [] })),
    listArchived: vi.fn(async () => ({ kind: "ok" as const, meetups: [] })),
    createDraft: vi.fn(async (_person, id) => ({
      kind: "ok" as const,
      meetup: { ...snapshot, id },
    })),
    get: vi.fn(async () => ({ kind: "ok" as const, meetup: snapshot })),
    changeAttributes: vi.fn(async (_person, meetup) => {
      snapshot = meetup;
      return { kind: "ok" as const, meetup };
    }),
    setSchedule: vi.fn(async (_person, meetup, schedule) => {
      snapshot = { ...meetup, schedule };
      return { kind: "ok" as const, meetup: snapshot };
    }),
    publish: vi.fn(async () => ({ kind: "ok" as const, meetup: snapshot })),
    unpublish: vi.fn(async () => {
      snapshot = { ...snapshot, visibility: "hidden" };
      return { kind: "ok" as const, meetup: snapshot };
    }),
    cancel: vi.fn(async () => {
      snapshot = { ...snapshot, lifecycle: "cancelled" };
      return { kind: "ok" as const, meetup: snapshot };
    }),
    markHeld: vi.fn(async () => {
      snapshot = { ...snapshot, lifecycle: "held" };
      return { kind: "ok" as const, meetup: snapshot };
    }),
    attachMaterial: vi.fn(async () => ({
      kind: "ok" as const,
      meetup: snapshot,
    })),
    removeMaterial: vi.fn(async () => ({
      kind: "ok" as const,
      meetup: snapshot,
    })),
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
      empty,
      undefined,
    );
    expect(meetups.publish).toHaveBeenNthCalledWith(
      2,
      identity,
      empty,
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

  it("re-asks the schedule within the edit flow when Meetups rejects its value", async () => {
    const { dispatcher, meetups } = harness();
    meetups.setSchedule = vi.fn(async () => ({
      kind: "invalid" as const,
      message: "schedule is in the past",
    }));

    await expect(
      dispatcher.execute({
        identity,
        intent: "update-meetup-field",
        field: "schedule",
        value: "21.09.2026 19:30",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "edit-ask",
      field: "schedule",
      error: "Не получилось сохранить значение: schedule is in the past",
    });
  });

  it("updates exactly one selected field and returns to the meetup card", async () => {
    const { dispatcher, meetups } = harness();

    await expect(
      dispatcher.execute({
        identity,
        intent: "update-meetup-field",
        field: "venue",
        value: "Новый зал",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-updated",
      meetup: { venue: "Новый зал" },
    });
    expect(meetups.changeAttributes).toHaveBeenCalledOnce();
    expect(meetups.setSchedule).not.toHaveBeenCalled();
  });

  it("does not mutate an already cancelled meetup from an old edit question", async () => {
    const { dispatcher, meetups } = harness();
    meetups.get = vi.fn(async () => ({
      kind: "ok" as const,
      meetup: { ...empty, lifecycle: "cancelled" as const },
    }));

    await expect(
      dispatcher.execute({
        identity,
        intent: "update-meetup-field",
        field: "title",
        value: "Позднее изменение",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "edit-unavailable",
      reason: "cancelled",
    });
    expect(meetups.changeAttributes).not.toHaveBeenCalled();
  });

  it("changes state once and treats an old cancel action as already complete", async () => {
    const { dispatcher, meetups } = harness();

    await expect(
      dispatcher.execute({
        identity,
        intent: "change-meetup-state",
        action: "cancel",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-state-changed",
      action: "cancel",
      meetup: { lifecycle: "cancelled" },
    });
    await expect(
      dispatcher.execute({
        identity,
        intent: "change-meetup-state",
        action: "cancel",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-state-unchanged",
      reason: "already-cancelled",
    });
    expect(meetups.cancel).toHaveBeenCalledOnce();
  });

  it("marks a meetup held without the shared already-cancelled precheck", async () => {
    const { dispatcher, meetups } = harness();

    await expect(
      dispatcher.execute({
        identity,
        intent: "change-meetup-state",
        action: "hold",
        meetupId: empty.id,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-state-changed",
      action: "hold",
      meetup: { lifecycle: "held" },
    });
    expect(meetups.markHeld).toHaveBeenCalledOnce();
  });

  it("keeps the typed value and shows the current snapshot on a version conflict", async () => {
    const { meetups, dispatcher } = harness();
    const changed = { ...empty, title: "Чужая правка", version: 2 };
    meetups.changeAttributes = vi.fn(async () => ({
      kind: "conflict" as const,
    }));
    meetups.get = vi.fn(async () => ({ kind: "ok" as const, meetup: changed }));

    await expect(
      dispatcher.execute({
        identity,
        intent: "set-meetup-field",
        field: "title",
        value: "Моя правка",
        meetupId: empty.id,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      meetup: changed,
      field: "title",
      input: "Моя правка",
    });
  });

  it("marks a version conflict from the edit flow so the retry stays an edit", async () => {
    const { meetups, dispatcher } = harness();
    const changed = { ...empty, title: "Чужая правка", version: 2 };
    meetups.changeAttributes = vi.fn(async () => ({
      kind: "conflict" as const,
    }));
    meetups.get = vi.fn(async () => ({ kind: "ok" as const, meetup: changed }));

    await expect(
      dispatcher.execute({
        identity,
        intent: "update-meetup-field",
        field: "title",
        value: "Моя правка",
        meetupId: empty.id,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      meetup: changed,
      field: "title",
      input: "Моя правка",
      editing: true,
    });
  });

  it("asks to confirm publication again on a version conflict", async () => {
    const { meetups, dispatcher } = harness();
    const changed = { ...empty, title: "Чужая правка", version: 2 };
    meetups.publish = vi.fn(async () => ({ kind: "conflict" as const }));
    meetups.get = vi.fn(async () => ({ kind: "ok" as const, meetup: changed }));

    await expect(
      dispatcher.execute({
        identity,
        intent: "publish-meetup",
        meetupId: empty.id,
      }),
    ).resolves.toEqual({ kind: "conflict", meetup: changed });
  });

  it("asks to confirm a state change again on a version conflict", async () => {
    const { meetups, dispatcher } = harness();
    const changed = { ...empty, lifecycle: "held" as const, version: 2 };
    meetups.cancel = vi.fn(async () => ({ kind: "conflict" as const }));
    meetups.get = vi.fn(async () => ({ kind: "ok" as const, meetup: changed }));

    await expect(
      dispatcher.execute({
        identity,
        intent: "change-meetup-state",
        action: "cancel",
        meetupId: empty.id,
      }),
    ).resolves.toEqual({ kind: "conflict", meetup: changed, action: "cancel" });
  });
});
