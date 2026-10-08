import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { NotificationCategory as WireCategory } from "../../../../gen/notifications/v1/notifications_service_pb.js";
import { createNotificationsAdapter } from "./client.js";

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
          { category: WireCategory.ACCESS_REQUEST, enabled: false },
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
          { category: "access", enabled: false },
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
          { category: WireCategory.ACCESS_REQUEST, enabled: true },
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

  // Запросы доступа меняет только администратор: остальным сервис отвечает
  // `PERMISSION_DENIED`, и это отказ по праву, а не недоступность.
  it("sends access requests on the wire and reads a refusal as forbidden", async () => {
    const setGlobalCategoryPreference = vi
      .fn()
      .mockRejectedValue(new ConnectError("admin only", Code.PermissionDenied));
    const notifications = adapter({ setGlobalCategoryPreference });

    const result = await notifications.setGlobalCategory(
      "identity-id",
      "access",
      false,
    );

    expect(result).toEqual({ kind: "forbidden" });
    expect(setGlobalCategoryPreference).toHaveBeenCalledWith(
      {
        identityId: "identity-id",
        category: WireCategory.ACCESS_REQUEST,
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
