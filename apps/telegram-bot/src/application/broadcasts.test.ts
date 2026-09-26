import { describe, expect, it, vi } from "vitest";
import type { Notifications } from "../notifications/port.js";
import {
  broadcastBodyLimit,
  checkBroadcastBody,
  createBroadcasts,
} from "./broadcasts.js";
import type { BroadcastRequest, Person } from "./types.js";

const identity: Person = { identityId: "identity-id", globalRoles: ["admin"] };

function request(overrides: Partial<BroadcastRequest> = {}): BroadcastRequest {
  return {
    identity,
    intent: "send-broadcast",
    audience: { kind: "meetup", meetupId: "meetup-id" },
    broadcastId: "broadcast-id",
    body: "Переносим на час позже",
    ...overrides,
  };
}

function notificationsStub(
  overrides: Partial<
    Pick<Notifications, "broadcastToMeetupSubscribers" | "broadcastToCommunity">
  >,
) {
  return {
    broadcastToMeetupSubscribers: vi.fn(),
    broadcastToCommunity: vi.fn(),
    ...overrides,
  };
}

describe("broadcast body", () => {
  it("trims the text and accepts it up to the Telegram limit", () => {
    expect(checkBroadcastBody("  Сбор в субботу \n")).toEqual({
      kind: "ok",
      body: "Сбор в субботу",
    });
    expect(checkBroadcastBody("я".repeat(broadcastBodyLimit)).kind).toBe("ok");
  });

  it("rejects what Notifications would reject, before the confirmation frame", () => {
    expect(checkBroadcastBody("   ")).toEqual({ kind: "empty" });
    expect(checkBroadcastBody("я".repeat(broadcastBodyLimit + 1))).toEqual({
      kind: "too-long",
    });
    expect(checkBroadcastBody("до\u0000после")).toEqual({ kind: "nul" });
  });

  // Предел считается в UTF-16-единицах, как у сервиса: эмодзи занимает две.
  it("counts the limit in UTF-16 units", () => {
    expect(checkBroadcastBody("😀".repeat(broadcastBodyLimit / 2)).kind).toBe(
      "ok",
    );
    expect(
      checkBroadcastBody(`${"😀".repeat(broadcastBodyLimit / 2)}!`).kind,
    ).toBe("too-long");
  });
});

describe("broadcasts", () => {
  it("sends a meetup broadcast to that meetup's subscribers only", async () => {
    const notifications = notificationsStub({
      broadcastToMeetupSubscribers: vi
        .fn()
        .mockResolvedValue({ kind: "ok", created: true }),
    });

    const result = await createBroadcasts(notifications)(request());

    expect(result).toEqual({
      kind: "broadcast-accepted",
      audience: { kind: "meetup", meetupId: "meetup-id" },
    });
    expect(notifications.broadcastToMeetupSubscribers).toHaveBeenCalledWith(
      {
        identityId: "identity-id",
        meetupId: "meetup-id",
        broadcastId: "broadcast-id",
        body: "Переносим на час позже",
      },
      undefined,
    );
    expect(notifications.broadcastToCommunity).not.toHaveBeenCalled();
  });

  it("reports a repeated key as already accepted rather than sent again", async () => {
    const notifications = notificationsStub({
      broadcastToCommunity: vi
        .fn()
        .mockResolvedValue({ kind: "ok", created: false }),
    });

    const result = await createBroadcasts(notifications)(
      request({ audience: { kind: "community" } }),
    );

    expect(result).toEqual({
      kind: "broadcast-accepted",
      audience: { kind: "community" },
      repeated: true,
    });
  });

  it("passes a Notifications refusal through as a dependency rejection", async () => {
    const notifications = notificationsStub({
      broadcastToMeetupSubscribers: vi
        .fn()
        .mockResolvedValue({ kind: "forbidden" }),
    });

    const result = await createBroadcasts(notifications)(request());

    expect(result).toEqual({
      kind: "dependency-rejected",
      reason: "forbidden",
    });
  });
});
