import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { AuctionNoticeView as WireNoticeView } from "../../../../gen/notifications/v1/notifications_pb.js";
import {
  NotificationCategory as WireCategory,
  OutbidFrequency as WireOutbidFrequency,
} from "../../../../gen/notifications/v1/notifications_service_pb.js";
import {
  createAuctionAnnouncementsAdapter,
  createNotificationsAdapter,
} from "./client.js";

type Rpc = Parameters<typeof createNotificationsAdapter>[0];

function adapter(overrides: Partial<Rpc>) {
  return createNotificationsAdapter({
    subscribeToMeetup: vi.fn(),
    unsubscribeFromMeetup: vi.fn(),
    setGlobalCategoryPreference: vi.fn(),
    setMeetupCategoryPreference: vi.fn(),
    getGlobalNotificationPreferences: vi.fn(),
    getMeetupNotificationPreferences: vi.fn(),
    broadcastToMeetupSubscribers: vi.fn(),
    broadcastToCommunity: vi.fn(),
    ...overrides,
  } as unknown as Rpc);
}

describe("notifications client", () => {
  it("translates the wire dictionary into the short aliases the frames use", async () => {
    const notifications = adapter({
      getGlobalNotificationPreferences: vi.fn().mockResolvedValue({
        categories: [
          { category: WireCategory.MEETUP_PUBLISHED, enabled: true },
          { category: WireCategory.MEETUP_CHANGED, enabled: false },
          { category: WireCategory.MEETUP_MATERIAL, enabled: true },
          { category: WireCategory.MEETUP_REMINDER, enabled: false },
          { category: WireCategory.ORGANIZER_MESSAGE, enabled: true },
          { category: WireCategory.COMMUNITY_ANNOUNCEMENT, enabled: true },
          { category: WireCategory.ACCESS_REQUEST_COMMUNITY, enabled: false },
        ],
      }),
    });

    const result = await notifications.getGlobalPreferences("identity-id");

    expect(result).toEqual({
      kind: "ok",
      preferences: {
        categories: [
          { category: "published", enabled: true },
          { category: "changes", enabled: false },
          { category: "material", enabled: true },
          { category: "reminder", enabled: false },
          { category: "organizer", enabled: true },
          { category: "announcement", enabled: true },
          { category: "access-community", enabled: false },
        ],
      },
    });
  });

  // Словарь расширяется контрактом, и старый бот обязан дорисовать остальные
  // категории, а не уронить кадр на незнакомом значении.
  it("drops a category it does not know instead of failing the frame", async () => {
    const notifications = adapter({
      getGlobalNotificationPreferences: vi.fn().mockResolvedValue({
        categories: [
          { category: WireCategory.MEETUP_CHANGED, enabled: true },
          { category: 99 as WireCategory, enabled: true },
        ],
      }),
    });

    const result = await notifications.getGlobalPreferences("identity-id");

    expect(result).toEqual({
      kind: "ok",
      preferences: { categories: [{ category: "changes", enabled: true }] },
    });
  });

  // Снимок сходки несёт только категории, которые сходка может нести. Если
  // глобальная всё же доехала, рисовать её в кадре сходки нечем.
  it("keeps only meetup-scoped categories in the meetup snapshot", async () => {
    const notifications = adapter({
      getMeetupNotificationPreferences: vi.fn().mockResolvedValue({
        subscribed: true,
        categories: [
          { category: WireCategory.MEETUP_CHANGED, enabled: true },
          { category: WireCategory.COMMUNITY_ANNOUNCEMENT, enabled: true },
          { category: WireCategory.ACCESS_REQUEST_AUCTION, enabled: true },
        ],
      }),
    });

    const result = await notifications.getMeetupPreferences(
      "identity-id",
      "meetup-id",
    );

    expect(result).toEqual({
      kind: "ok",
      preferences: {
        meetupId: "meetup-id",
        subscribed: true,
        categories: [{ category: "changes", enabled: true }],
      },
    });
  });

  it("sends the category of the meetup command on the wire", async () => {
    const setMeetupCategoryPreference = vi.fn().mockResolvedValue({
      subscribed: true,
      categories: [],
    });
    const notifications = adapter({ setMeetupCategoryPreference });

    await notifications.setMeetupCategory(
      "identity-id",
      "meetup-id",
      "reminder",
      true,
    );

    expect(setMeetupCategoryPreference).toHaveBeenCalledWith(
      {
        identityId: "identity-id",
        meetupId: "meetup-id",
        category: WireCategory.MEETUP_REMINDER,
        enabled: true,
      },
      expect.objectContaining({ timeoutMs: 3_000 }),
    );
  });

  // Запросы доступа меняет только тот, кто решает заявки этой очереди:
  // остальным сервис отвечает `PERMISSION_DENIED`, и это отказ по праву, а не
  // недоступность.
  it("sends access requests on the wire and reads a refusal as forbidden", async () => {
    const setGlobalCategoryPreference = vi
      .fn()
      .mockRejectedValue(new ConnectError("admin only", Code.PermissionDenied));
    const notifications = adapter({ setGlobalCategoryPreference });

    const result = await notifications.setGlobalCategory(
      "identity-id",
      "access-community",
      false,
    );

    expect(result).toEqual({ kind: "forbidden" });
    expect(setGlobalCategoryPreference).toHaveBeenCalledWith(
      {
        identityId: "identity-id",
        category: WireCategory.ACCESS_REQUEST_COMMUNITY,
        enabled: false,
      },
      expect.anything(),
    );
  });

  it("calls the opposite rpc for the target subscription state", async () => {
    const subscribeToMeetup = vi
      .fn()
      .mockResolvedValue({ subscribed: true, categories: [] });
    const unsubscribeFromMeetup = vi
      .fn()
      .mockResolvedValue({ subscribed: false, categories: [] });
    const notifications = adapter({ subscribeToMeetup, unsubscribeFromMeetup });

    await notifications.setSubscription("identity-id", "meetup-id", true);
    await notifications.setSubscription("identity-id", "meetup-id", false);

    expect(subscribeToMeetup).toHaveBeenCalledOnce();
    expect(unsubscribeFromMeetup).toHaveBeenCalledOnce();
  });

  it.each([
    [Code.DeadlineExceeded, "timeout"],
    [Code.PermissionDenied, "forbidden"],
    [Code.InvalidArgument, "invalid"],
    [Code.FailedPrecondition, "invalid"],
    [Code.AlreadyExists, "conflict"],
    [Code.Unavailable, "unavailable"],
    [Code.Internal, "unavailable"],
  ])("maps gRPC %s to the %s failure", async (code, kind) => {
    const notifications = adapter({
      getGlobalNotificationPreferences: vi
        .fn()
        .mockRejectedValue(new ConnectError("rejected", code)),
    });

    const result = await notifications.getGlobalPreferences("identity-id");

    expect(result.kind).toBe(kind);
  });

  it("sends the broadcast key as the request id and reports a repeat", async () => {
    const broadcastToMeetupSubscribers = vi
      .fn()
      .mockResolvedValue({ id: "b", acceptedAt: "t", created: false });
    const notifications = adapter({ broadcastToMeetupSubscribers });

    const result = await notifications.broadcastToMeetupSubscribers({
      identityId: "identity-id",
      meetupId: "meetup-id",
      broadcastId: "broadcast-id",
      body: "Переносим на час позже",
    });

    expect(result).toEqual({ kind: "ok", created: false });
    expect(broadcastToMeetupSubscribers).toHaveBeenCalledWith(
      {
        identityId: "identity-id",
        meetupId: "meetup-id",
        id: "broadcast-id",
        body: "Переносим на час позже",
      },
      expect.anything(),
    );
  });

  it("reads a recipient count and rejects a count that is not a whole number", async () => {
    const previewMeetupBroadcast = vi
      .fn()
      .mockResolvedValueOnce({ recipientCount: 3 })
      .mockResolvedValueOnce({ recipientCount: -1 });
    const notifications = adapter({ previewMeetupBroadcast });

    await expect(
      notifications.previewMeetupBroadcast({
        identityId: "identity-id",
        meetupId: "meetup-id",
      }),
    ).resolves.toEqual({ kind: "ok", recipientCount: 3 });
    await expect(
      notifications.previewMeetupBroadcast({
        identityId: "identity-id",
        meetupId: "meetup-id",
      }),
    ).resolves.toEqual({ kind: "invalid", cause: -1 });
  });

  it.each([
    [Code.PermissionDenied, "forbidden"],
    [Code.AlreadyExists, "conflict"],
    [Code.InvalidArgument, "invalid"],
    [Code.Unavailable, "unavailable"],
    [Code.DeadlineExceeded, "timeout"],
  ])("maps a community announcement refusal %s to %s", async (code, kind) => {
    const notifications = adapter({
      broadcastToCommunity: vi
        .fn()
        .mockRejectedValue(new ConnectError("refused", code)),
    });

    const result = await notifications.broadcastToCommunity({
      identityId: "identity-id",
      broadcastId: "broadcast-id",
      body: "Сбор в субботу",
    });

    expect(result.kind).toBe(kind);
  });
});

describe("auction notification settings", () => {
  it("sends the chosen mode alone and answers with the stored settings", async () => {
    const setAuctionNotificationPreferences = vi.fn().mockResolvedValue({
      outbidFrequency: WireOutbidFrequency.AT_MOST_EVERY_60_MINUTES,
      finalAnnouncements: true,
    });
    const notifications = adapter({ setAuctionNotificationPreferences });

    const result = await notifications.setAuctionNotifications("identity-id", {
      kind: "frequency",
      frequency: "60",
    });

    expect(setAuctionNotificationPreferences).toHaveBeenCalledWith(
      {
        identityId: "identity-id",
        outbidFrequency: WireOutbidFrequency.AT_MOST_EVERY_60_MINUTES,
      },
      expect.anything(),
    );
    expect(result).toEqual({
      kind: "ok",
      settings: { frequency: "60", finalAnnouncements: true },
    });
  });

  // Выключатель финала уходит один: частоту сервер не трогает.
  it("sends the final switch alone", async () => {
    const setAuctionNotificationPreferences = vi.fn().mockResolvedValue({
      outbidFrequency: WireOutbidFrequency.EVERY,
      finalAnnouncements: false,
    });
    const notifications = adapter({ setAuctionNotificationPreferences });

    const result = await notifications.setAuctionNotifications("identity-id", {
      kind: "final",
      enabled: false,
    });

    expect(setAuctionNotificationPreferences).toHaveBeenCalledWith(
      { identityId: "identity-id", finalAnnouncements: false },
      expect.anything(),
    );
    expect(result).toEqual({
      kind: "ok",
      settings: { frequency: "every", finalAnnouncements: false },
    });
  });

  // «Перебили в финале» (PER-645) уходит один, и ответ несёт все три.
  it("sends the live final switch alone", async () => {
    const setAuctionNotificationPreferences = vi.fn().mockResolvedValue({
      outbidFrequency: WireOutbidFrequency.OFF,
      finalAnnouncements: true,
      liveFinalOutbids: true,
    });
    const notifications = adapter({ setAuctionNotificationPreferences });

    const result = await notifications.setAuctionNotifications("identity-id", {
      kind: "live",
      enabled: true,
    });

    expect(setAuctionNotificationPreferences).toHaveBeenCalledWith(
      { identityId: "identity-id", liveFinalOutbids: true },
      expect.anything(),
    );
    expect(result).toEqual({
      kind: "ok",
      settings: {
        frequency: "off",
        finalAnnouncements: true,
        liveFinalOutbids: true,
      },
    });
  });

  // Умолчание `EVERY` отдаёт сервер, и бот его не додумывает: незнакомое
  // значение — ответ вне контракта, а не недоступность.
  it("reports a mode outside the dictionary as unknown", async () => {
    const notifications = adapter({
      getAuctionNotificationPreferences: vi.fn().mockResolvedValue({
        outbidFrequency: WireOutbidFrequency.UNSPECIFIED,
        finalAnnouncements: true,
      }),
    });

    expect(await notifications.getAuctionNotifications("identity-id")).toEqual({
      kind: "unknown",
      value: WireOutbidFrequency.UNSPECIFIED,
    });
  });

  it("maps the release-notes category and the summary reads", async () => {
    const reportReleaseNotes = vi.fn().mockResolvedValue({
      acceptedAt: "2026-10-14T12:00:00Z",
    });
    const listReleaseSummaries = vi.fn().mockResolvedValue({
      summaries: [
        {
          summaryId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
          summarizedAt: "2026-10-14T12:00:00Z",
          recordIds: ["known"],
        },
      ],
      nextPageToken: "",
    });
    const getReleaseSummary = vi.fn().mockResolvedValue({
      summary: {
        summaryId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
        summarizedAt: "2026-10-14T12:00:00Z",
        recordIds: ["known"],
      },
      olderSummaryId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402",
    });
    const notifications = adapter({
      reportReleaseNotes,
      listReleaseSummaries,
      getReleaseSummary,
      getGlobalNotificationPreferences: vi.fn().mockResolvedValue({
        categories: [
          { category: WireCategory.MEETUP_PUBLISHED, enabled: true },
          { category: WireCategory.RELEASE_NOTES, enabled: false },
        ],
      }),
    });

    await notifications.reportReleaseNotes(["known"]);
    expect(reportReleaseNotes).toHaveBeenCalledWith(
      { recordIds: ["known"] },
      expect.any(Object),
    );
    await expect(
      notifications.listReleaseSummaries(undefined),
    ).resolves.toEqual({
      kind: "ok",
      page: {
        summaries: [
          {
            id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
            summarizedAt: "2026-10-14T12:00:00Z",
            recordIds: ["known"],
          },
        ],
      },
    });
    await expect(
      notifications.getReleaseSummary("0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401"),
    ).resolves.toMatchObject({
      kind: "ok",
      view: { olderId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402" },
    });
    await expect(
      notifications.getGlobalPreferences("identity-id"),
    ).resolves.toMatchObject({
      preferences: {
        categories: [
          { category: "published", enabled: true },
          { category: "release", enabled: false },
        ],
      },
    });
  });

  it("reports an unreachable Notifications as unavailable", async () => {
    const notifications = adapter({
      getAuctionNotificationPreferences: vi
        .fn()
        .mockRejectedValue(new ConnectError("down", Code.Unavailable)),
    });

    expect(
      await notifications.getAuctionNotifications("identity-id"),
    ).toMatchObject({ kind: "unavailable" });
  });
});

// Объявление аукциона (PER-765, контракт PER-764): адресат — сходка, кнопка и
// фото необязательны, отказы — те же переводы, что у рассылок.
describe("auction announcements", () => {
  const person = {
    identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
    rights: ["run-auctions"] as const,
  };
  const meetupId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa";
  const lotId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d0";

  it("sends the meetup, the key, the text, the lot button and the lot photo", async () => {
    const broadcastAuctionNotice = vi.fn().mockResolvedValue({ created: true });
    const announcements = createAuctionAnnouncementsAdapter({
      broadcastAuctionNotice,
      previewAuctionNotice: vi.fn(),
    } as never);

    await expect(
      announcements.announceAuction(person, {
        meetupId,
        announcementId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ff",
        text: "Ваза ждёт",
        button: { kind: "lot", lotId },
        photo: { lotId, photoId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34d1" },
      }),
    ).resolves.toEqual({ kind: "ok", created: true });
    const [request] = broadcastAuctionNotice.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      identityId: person.identityId,
      meetupId,
      id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ff",
      body: "Ваза ждёт",
      button: { view: WireNoticeView.LOT, lotId },
      photo: { source: { case: "lotPhoto", value: { lotId } } },
    });
  });

  it("sends no button for «Без кнопки»", async () => {
    const broadcastAuctionNotice = vi
      .fn()
      .mockResolvedValue({ created: false });
    const announcements = createAuctionAnnouncementsAdapter({
      broadcastAuctionNotice,
      previewAuctionNotice: vi.fn(),
    } as never);

    await expect(
      announcements.announceAuction(person, {
        meetupId,
        announcementId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ff",
        text: "Текст",
      }),
    ).resolves.toEqual({ kind: "ok", created: false });
    expect(broadcastAuctionNotice.mock.calls[0]?.[0]).not.toHaveProperty(
      "button",
    );
  });

  it("counts the audience and maps refusals as the broadcasts do", async () => {
    const announcements = createAuctionAnnouncementsAdapter({
      broadcastAuctionNotice: vi
        .fn()
        .mockRejectedValue(new ConnectError("no", Code.PermissionDenied)),
      previewAuctionNotice: vi.fn().mockResolvedValue({ recipientCount: 0 }),
    } as never);

    await expect(
      announcements.previewAuctionAnnouncement(person, meetupId),
    ).resolves.toEqual({ kind: "ok", recipientCount: 0 });
    await expect(
      announcements.announceAuction(person, {
        meetupId,
        announcementId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ff",
        text: "Текст",
      }),
    ).resolves.toEqual({ kind: "forbidden" });
  });
});
