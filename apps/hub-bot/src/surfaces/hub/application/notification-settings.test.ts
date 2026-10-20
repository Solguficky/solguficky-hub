import { describe, expect, it, vi } from "vitest";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import { createNotificationSettings } from "./notification-settings.js";
import type { Person } from "./types.js";

const identity: Person = {
  identityId: "identity-id",
  rights: [],
};
const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf";

const meetup: MeetupSnapshot = {
  id: meetupId,
  title: "Настолки у Лёши",
  description: "",
  venue: "",
  lifecycle: "planned",
  visibility: "visible",
  author: "0192f0a0-0000-7000-8000-00000000a001",
  version: 1,
  materials: [],
};

function meetupsStub(
  result: Awaited<ReturnType<Meetups["get"]>> = { kind: "ok", meetup },
): Meetups {
  return { get: vi.fn().mockResolvedValue(result) } as unknown as Meetups;
}

function notificationsStub(overrides: Partial<Notifications>): Notifications {
  return {
    getGlobalPreferences: vi.fn().mockResolvedValue({
      kind: "ok",
      preferences: {
        categories: [
          { category: "changes", enabled: true },
          { category: "material", enabled: true },
          { category: "reminder", enabled: false },
          { category: "organizer", enabled: true },
        ],
      },
    }),
    getMeetupPreferences: vi.fn(),
    setSubscription: vi.fn(),
    setGlobalCategory: vi.fn(),
    setMeetupCategory: vi.fn(),
    getAuctionNotifications: vi.fn(),
    setAuctionNotifications: vi.fn(),
    broadcastToMeetupSubscribers: vi.fn(),
    broadcastToCommunity: vi.fn(),
    previewMeetupBroadcast: vi.fn(),
    previewCommunityBroadcast: vi.fn(),
    ...overrides,
  };
}

describe("meetup notification settings", () => {
  it("marks only the categories whose value diverges from the global one", async () => {
    const notifications = notificationsStub({
      getMeetupPreferences: vi.fn().mockResolvedValue({
        kind: "ok",
        preferences: {
          meetupId,
          subscribed: true,
          categories: [
            // Совпадает с глобальным: переопределение здесь может стоять, но
            // контракт об этом не сообщает, и пометка не заявляется.
            { category: "changes", enabled: true },
            { category: "material", enabled: false },
            { category: "reminder", enabled: true },
            { category: "organizer", enabled: true },
          ],
        },
      }),
    });
    const settings = createNotificationSettings(meetupsStub(), notifications);

    const result = await settings({
      identity,
      intent: "view-meetup-notifications",
      meetupId,
    });

    expect(result).toMatchObject({
      kind: "meetup-notification-settings",
      subscribed: true,
      meetup: { title: "Настолки у Лёши" },
      categories: [
        { category: "changes", enabled: true, differsFromGlobal: false },
        { category: "material", enabled: false, differsFromGlobal: true },
        { category: "reminder", enabled: true, differsFromGlobal: true },
        { category: "organizer", enabled: true, differsFromGlobal: false },
      ],
    });
  });

  // Подписку нажимают в карточке, поэтому ответ — карточка со свежим
  // состоянием, а не кадр настроек: человек остаётся на том же экране.
  it("sends the target subscription state and answers with the card", async () => {
    const setSubscription = vi.fn().mockResolvedValue({
      kind: "ok",
      preferences: { meetupId, subscribed: false, categories: [] },
    });
    const notifications = notificationsStub({ setSubscription });
    const settings = createNotificationSettings(meetupsStub(), notifications);

    const result = await settings({
      identity,
      intent: "set-meetup-subscription",
      meetupId,
      subscribed: false,
    });

    expect(setSubscription).toHaveBeenCalledWith(
      "identity-id",
      meetupId,
      false,
      undefined,
    );
    expect(result).toMatchObject({
      kind: "meetup-card",
      subscribed: false,
      meetup: { title: "Настолки у Лёши" },
    });
    // Сравнивать не с чем: глобальный снимок на этом пути не читается.
    expect(notifications.getGlobalPreferences).not.toHaveBeenCalled();
  });

  // Карточка называет, что будет приходить, по значениям из ответа самой
  // команды: второго вызова ради перечня нет (PER-402).
  it("carries the effective categories returned by the subscription command", async () => {
    const categories = [
      { category: "changes", enabled: true },
      { category: "material", enabled: true },
      { category: "reminder", enabled: false },
      { category: "organizer", enabled: true },
    ] as const;
    const notifications = notificationsStub({
      setSubscription: vi.fn().mockResolvedValue({
        kind: "ok",
        preferences: { meetupId, subscribed: true, categories },
      }),
    });
    const settings = createNotificationSettings(meetupsStub(), notifications);

    const result = await settings({
      identity,
      intent: "set-meetup-subscription",
      meetupId,
      subscribed: true,
    });

    expect(result).toMatchObject({
      kind: "meetup-card",
      subscribed: true,
      categories,
    });
    expect(notifications.getMeetupPreferences).not.toHaveBeenCalled();
  });

  it("reports the refusal instead of the card when the subscription command fails", async () => {
    const settings = createNotificationSettings(
      meetupsStub(),
      notificationsStub({
        setSubscription: vi
          .fn()
          .mockResolvedValue({ kind: "forbidden" as const }),
      }),
    );

    const result = await settings({
      identity,
      intent: "set-meetup-subscription",
      meetupId,
      subscribed: true,
    });

    expect(result).toEqual({
      kind: "dependency-rejected",
      reason: "forbidden",
    });
  });

  // Сходку сняли между отрисовкой кнопки и нажатием: кадр отвечает тем же
  // «не найдено», что и карточка, а не пустым списком категорий.
  it("answers with meetup-not-found when the meetup disappeared", async () => {
    const settings = createNotificationSettings(
      meetupsStub({ kind: "not-found" }),
      notificationsStub({
        getMeetupPreferences: vi.fn().mockResolvedValue({
          kind: "ok",
          preferences: { meetupId, subscribed: false, categories: [] },
        }),
      }),
    );

    const result = await settings({
      identity,
      intent: "view-meetup-notifications",
      meetupId,
    });

    expect(result).toEqual({ kind: "meetup-not-found" });
  });

  it("reports a Notifications refusal instead of an empty frame", async () => {
    const settings = createNotificationSettings(
      meetupsStub(),
      notificationsStub({
        getMeetupPreferences: vi.fn().mockResolvedValue({
          kind: "unavailable",
          cause: new Error("down"),
        }),
      }),
    );

    const result = await settings({
      identity,
      intent: "view-meetup-notifications",
      meetupId,
    });

    expect(result).toEqual({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
  });
});

describe("global notification settings", () => {
  it("answers with the whole dictionary, including the global-only categories", async () => {
    const notifications = notificationsStub({});
    (
      notifications.getGlobalPreferences as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      kind: "ok",
      preferences: {
        categories: [
          { category: "published", enabled: true },
          { category: "changes", enabled: true },
          { category: "reminder", enabled: false },
          { category: "announcement", enabled: true },
        ],
      },
    });
    const settings = createNotificationSettings(meetupsStub(), notifications);

    const result = await settings({
      identity,
      intent: "view-global-notifications",
    });

    expect(result).toMatchObject({
      kind: "global-notification-settings",
      categories: [
        { category: "published", enabled: true },
        { category: "changes", enabled: true },
        { category: "reminder", enabled: false },
        { category: "announcement", enabled: true },
      ],
    });
  });

  it("sends the target state of one category and never a toggle", async () => {
    const setGlobalCategory = vi.fn().mockResolvedValue({
      kind: "ok",
      preferences: { categories: [{ category: "reminder", enabled: true }] },
    });
    const settings = createNotificationSettings(
      meetupsStub(),
      notificationsStub({ setGlobalCategory }),
    );

    await settings({
      identity,
      intent: "set-global-category",
      category: "reminder",
      enabled: true,
    });

    expect(setGlobalCategory).toHaveBeenCalledWith(
      "identity-id",
      "reminder",
      true,
      undefined,
    );
  });
});

describe("auction notification settings", () => {
  it("shows the settings Notifications holds for the person", async () => {
    const stored = {
      frequency: "off",
      finalAnnouncements: false,
      liveFinalOutbids: true,
    } as const;
    const getAuctionNotifications = vi
      .fn()
      .mockResolvedValue({ kind: "ok", settings: stored });
    const notifications = notificationsStub({ getAuctionNotifications });
    const settings = createNotificationSettings(meetupsStub(), notifications);

    const result = await settings({
      identity,
      intent: "view-auction-notifications",
    });

    expect(getAuctionNotifications).toHaveBeenCalledWith(
      identity.identityId,
      undefined,
    );
    expect(result).toEqual({ kind: "auction-notifications", settings: stored });
  });

  // Экран рисует ответ сервиса, а не нажатую кнопку.
  it("answers a choice with what Notifications stored", async () => {
    const stored = {
      frequency: "15",
      finalAnnouncements: true,
      liveFinalOutbids: false,
    } as const;
    const setAuctionNotifications = vi
      .fn()
      .mockResolvedValue({ kind: "ok", settings: stored });
    const settings = createNotificationSettings(
      meetupsStub(),
      notificationsStub({ setAuctionNotifications }),
    );

    const result = await settings({
      identity,
      intent: "set-auction-notifications",
      change: { kind: "frequency", frequency: "15" },
    });

    expect(setAuctionNotifications).toHaveBeenCalledWith(
      identity.identityId,
      { kind: "frequency", frequency: "15" },
      undefined,
    );
    expect(result).toEqual({ kind: "auction-notifications", settings: stored });
  });

  it("rejects a mode outside the dictionary with its value", async () => {
    const settings = createNotificationSettings(
      meetupsStub(),
      notificationsStub({
        getAuctionNotifications: vi
          .fn()
          .mockResolvedValue({ kind: "unknown", value: 7 }),
      }),
    );

    const result = await settings({
      identity,
      intent: "view-auction-notifications",
    });

    expect(result).toEqual({
      kind: "rejected",
      reason: "notifications answered an unknown outbid frequency 7",
    });
  });

  it("reports an unavailable Notifications instead of a stored choice", async () => {
    const settings = createNotificationSettings(
      meetupsStub(),
      notificationsStub({
        setAuctionNotifications: vi
          .fn()
          .mockResolvedValue({ kind: "unavailable", cause: new Error("down") }),
      }),
    );

    const result = await settings({
      identity,
      intent: "set-auction-notifications",
      change: { kind: "final", enabled: false },
    });

    expect(result).toEqual({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
  });
});
