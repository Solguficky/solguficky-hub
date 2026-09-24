import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  NotificationsService,
  NotificationCategory as WireCategory,
} from "../../gen/notifications/v1/notifications_service_pb.js";
import { callHeaders, type RpcMetadata } from "../rpc-metadata.js";
import type {
  CategoryState,
  GlobalPreferences,
  GlobalPreferencesResult,
  MeetupCategory,
  MeetupPreferences,
  MeetupPreferencesResult,
  NotificationCategory,
  NotificationFailure,
  Notifications,
} from "./port.js";

type NotificationsRpc = Pick<
  Client<typeof NotificationsService>,
  | "subscribeToMeetup"
  | "unsubscribeFromMeetup"
  | "setGlobalCategoryPreference"
  | "setMeetupCategoryPreference"
  | "getGlobalNotificationPreferences"
  | "getMeetupNotificationPreferences"
>;

export type NotificationsClient = Notifications & { close(): void };

export function createNotificationsClient(
  baseUrl: string,
  timeoutMs = 3_000,
): NotificationsClient {
  const sessionManager = new Http2SessionManager(baseUrl);
  const rpc = createClient(
    NotificationsService,
    createGrpcTransport({
      baseUrl,
      defaultTimeoutMs: timeoutMs,
      sessionManager,
    }),
  );
  const client = createNotificationsAdapter(rpc, timeoutMs);
  return { ...client, close: () => sessionManager.abort() };
}

export function createNotificationsAdapter(
  rpc: NotificationsRpc,
  timeoutMs = 3_000,
): Notifications {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs,
    ...callHeaders(meta),
  });
  const global = async (
    operation: () => Promise<{
      categories: readonly { category: WireCategory; enabled: boolean }[];
    }>,
  ): Promise<GlobalPreferencesResult> => {
    try {
      const response = await operation();
      return { kind: "ok", preferences: toGlobal(response) };
    } catch (cause) {
      return toFailure(cause);
    }
  };
  const meetup = async (
    meetupId: string,
    operation: () => Promise<{
      subscribed: boolean;
      categories: readonly { category: WireCategory; enabled: boolean }[];
    }>,
  ): Promise<MeetupPreferencesResult> => {
    try {
      const response = await operation();
      return { kind: "ok", preferences: toMeetup(meetupId, response) };
    } catch (cause) {
      return toFailure(cause);
    }
  };
  return {
    getGlobalPreferences: (identityId, meta) =>
      global(() =>
        rpc.getGlobalNotificationPreferences({ identityId }, options(meta)),
      ),
    getMeetupPreferences: (identityId, meetupId, meta) =>
      meetup(meetupId, () =>
        rpc.getMeetupNotificationPreferences(
          { identityId, meetupId },
          options(meta),
        ),
      ),
    setSubscription: (identityId, meetupId, subscribed, meta) =>
      meetup(meetupId, () =>
        subscribed
          ? rpc.subscribeToMeetup({ identityId, meetupId }, options(meta))
          : rpc.unsubscribeFromMeetup({ identityId, meetupId }, options(meta)),
      ),
    setGlobalCategory: (identityId, category, enabled, meta) =>
      global(() =>
        rpc.setGlobalCategoryPreference(
          { identityId, category: toWire(category), enabled },
          options(meta),
        ),
      ),
    setMeetupCategory: (identityId, meetupId, category, enabled, meta) =>
      meetup(meetupId, () =>
        rpc.setMeetupCategoryPreference(
          { identityId, meetupId, category: toWire(category), enabled },
          options(meta),
        ),
      ),
  };
}

function toFailure(cause: unknown): NotificationFailure {
  if (cause instanceof ConnectError && cause.code === Code.DeadlineExceeded) {
    return { kind: "timeout", cause };
  }
  if (cause instanceof ConnectError && cause.code === Code.PermissionDenied) {
    return { kind: "forbidden" };
  }
  if (
    cause instanceof ConnectError &&
    (cause.code === Code.InvalidArgument ||
      cause.code === Code.FailedPrecondition)
  ) {
    return { kind: "invalid", message: cause.message };
  }
  // ALREADY_EXISTS приходит только на рассылках, которых у бота нет. Если он
  // всё же доехал, это конфликт команды, а не недоступность зависимости.
  if (cause instanceof ConnectError && cause.code === Code.AlreadyExists) {
    return { kind: "conflict" };
  }
  return { kind: "unavailable", cause };
}

function toGlobal(response: {
  categories: readonly { category: WireCategory; enabled: boolean }[];
}): GlobalPreferences {
  const categories: CategoryState<NotificationCategory>[] = [];
  for (const entry of response.categories) {
    const category = fromWire(entry.category);
    if (category !== undefined) {
      categories.push({ category, enabled: entry.enabled });
    }
  }
  return { categories };
}

function toMeetup(
  meetupId: string,
  response: {
    subscribed: boolean;
    categories: readonly { category: WireCategory; enabled: boolean }[];
  },
): MeetupPreferences {
  const categories: CategoryState<MeetupCategory>[] = [];
  for (const entry of response.categories) {
    const category = fromWire(entry.category);
    // Глобальная категория в снимке сходки — расхождение словарей, а не
    // состояние человека: рисовать её здесь нечем, и кадр обойдётся без неё.
    if (category !== undefined && isMeetupCategory(category)) {
      categories.push({ category, enabled: entry.enabled });
    }
  }
  return { meetupId, subscribed: response.subscribed, categories };
}

function isMeetupCategory(
  category: NotificationCategory,
): category is MeetupCategory {
  return category !== "published" && category !== "announcement";
}

function toWire(category: NotificationCategory): WireCategory {
  switch (category) {
    case "published":
      return WireCategory.MEETUP_PUBLISHED;
    case "changes":
      return WireCategory.MEETUP_CHANGED;
    case "material":
      return WireCategory.MEETUP_MATERIAL;
    case "reminder":
      return WireCategory.MEETUP_REMINDER;
    case "organizer":
      return WireCategory.ORGANIZER_MESSAGE;
    case "announcement":
      return WireCategory.COMMUNITY_ANNOUNCEMENT;
    default: {
      const _exhaustive: never = category;
      throw new Error(`Unsupported notification category ${_exhaustive}`);
    }
  }
}

// Неизвестное значение отбрасывается, а не роняет кадр: словарь расширяется
// контрактом, и старый бот обязан дорисовать остальные категории.
function fromWire(value: WireCategory): NotificationCategory | undefined {
  switch (value) {
    case WireCategory.MEETUP_PUBLISHED:
      return "published";
    case WireCategory.MEETUP_CHANGED:
      return "changes";
    case WireCategory.MEETUP_MATERIAL:
      return "material";
    case WireCategory.MEETUP_REMINDER:
      return "reminder";
    case WireCategory.ORGANIZER_MESSAGE:
      return "organizer";
    case WireCategory.COMMUNITY_ANNOUNCEMENT:
      return "announcement";
    default:
      return undefined;
  }
}
