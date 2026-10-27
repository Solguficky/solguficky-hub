import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type { ReleaseSummary as WireReleaseSummary } from "../../../../gen/notifications/v1/notifications_pb.js";
import {
  NotificationsService,
  type AuctionNotificationPreferences as WireAuctionPreferences,
  AuctionNoticeAudience as WireAudience,
  NotificationCategory as WireCategory,
} from "../../../../gen/notifications/v1/notifications_service_pb.js";
import type {
  FavoritesPort,
  ProxyExplainerPort,
} from "../../../auction-ui/index.js";
import { createFavoritesPort } from "../../../core/notifications/favorites.js";
import {
  wireAnnouncementButton,
  wireAnnouncementPhoto,
} from "../../../core/notifications/organizer-announcement.js";
import {
  auctionNotificationsOf,
  auctionNotificationsToWire,
} from "../../../core/notifications/outbid.js";
import { createProxyExplainerPort } from "../../../core/notifications/proxy-explainer.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
  type RpcMetadata,
} from "../../../core/rpc-metadata.js";
import { type RpcClientOptions, traceRpc } from "../../../core/tracing.js";
import type {
  AnnouncementAudience,
  AuctionAnnouncements,
} from "../application/auction-announcements.js";
import type {
  AuctionNotificationsResult,
  BroadcastAudienceCount,
  BroadcastResult,
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
  | "getAuctionNotificationPreferences"
  | "setAuctionNotificationPreferences"
  | "broadcastToMeetupSubscribers"
  | "broadcastToCommunity"
  | "previewMeetupBroadcast"
  | "previewCommunityBroadcast"
  | "broadcastAuctionNotice"
  | "previewAuctionNotice"
  | "reportReleaseNotes"
  | "listReleaseSummaries"
  | "getReleaseSummary"
>;

// Избранные лоты (PER-495) — порт аукционного дерева на том же соединении:
// участник отмечает лоты в боте хаба. Собирается на каждый update, чтобы
// `request_id` и бюджет действия уехали в вызов.
export type NotificationsClient = Notifications & {
  favorites(
    meta?: RpcMetadata,
    onListRefused?: (cause: unknown) => void,
  ): FavoritesPort;
  // Пояснение автоставки (PER-517) на том же соединении.
  proxyExplainer(
    meta?: RpcMetadata,
    onRefused?: (cause: unknown) => void,
  ): ProxyExplainerPort;
  // Объявление аукциона (PER-765) на том же соединении.
  announcements: AuctionAnnouncements;
  close(): void;
};

export function createNotificationsClient(
  baseUrl: string,
  { tracing, serviceToken, timeoutMs = 3_000 }: RpcClientOptions,
): NotificationsClient {
  const sessionManager = new Http2SessionManager(baseUrl);
  const rpc = createClient(
    NotificationsService,
    createGrpcTransport({
      baseUrl,
      defaultTimeoutMs: timeoutMs,
      sessionManager,
      interceptors: [presentServiceToken(serviceToken), traceRpc(tracing)],
    }),
  );
  const client = createNotificationsAdapter(rpc, timeoutMs);
  return {
    ...client,
    favorites: (meta, onListRefused) =>
      createFavoritesPort(
        rpc,
        () => ({
          timeoutMs: callTimeoutMs(meta, timeoutMs),
          ...callHeaders(meta),
        }),
        onListRefused,
      ),
    proxyExplainer: (meta, onRefused) =>
      createProxyExplainerPort(
        rpc,
        () => ({
          timeoutMs: callTimeoutMs(meta, timeoutMs),
          ...callHeaders(meta),
        }),
        onRefused,
      ),
    announcements: createAuctionAnnouncementsAdapter(rpc, timeoutMs),
    close: () => sessionManager.abort(),
  };
}

// Аудитория объявления (PER-778): «всем» уходит явным значением, а не
// пустым полем.
const wireAudiences: Readonly<Record<AnnouncementAudience, WireAudience>> = {
  all: WireAudience.ALL,
  "not-in-raffle": WireAudience.NOT_IN_RAFFLE,
  "without-predictions": WireAudience.WITHOUT_PREDICTIONS,
  "not-in-raffle-or-without-predictions":
    WireAudience.NOT_IN_RAFFLE_OR_WITHOUT_PREDICTIONS,
};

// Объявление аукциона (PER-765, контракт PER-764): тот же механизм приёма и
// счётчика, что у двух рассылок, и те же переводы отказов. Адресат —
// сходка: связи «аукцион — сходка» у Notifications нет.
export function createAuctionAnnouncementsAdapter(
  rpc: Pick<
    NotificationsRpc,
    "broadcastAuctionNotice" | "previewAuctionNotice"
  >,
  timeoutMs = 3_000,
): AuctionAnnouncements {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  return {
    async previewAuctionAnnouncement(person, meetupId, audience, meta) {
      try {
        const response = await rpc.previewAuctionNotice(
          {
            identityId: person.identityId,
            meetupId,
            audience: wireAudiences[audience],
          },
          options(meta),
        );
        return Number.isInteger(response.recipientCount) &&
          response.recipientCount >= 0
          ? { kind: "ok", recipientCount: response.recipientCount }
          : { kind: "invalid", cause: response.recipientCount };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async announceAuction(person, command, meta) {
      try {
        const response = await rpc.broadcastAuctionNotice(
          {
            identityId: person.identityId,
            meetupId: command.meetupId,
            id: command.announcementId,
            body: command.text,
            audience: wireAudiences[command.audience],
            ...(command.button === undefined
              ? {}
              : { button: wireAnnouncementButton(command.button) }),
            ...(command.photo === undefined
              ? {}
              : { photo: wireAnnouncementPhoto(command.photo) }),
          },
          options(meta),
        );
        return { kind: "ok", created: response.created };
      } catch (cause) {
        return toFailure(cause);
      }
    },
  };
}

export function createNotificationsAdapter(
  rpc: NotificationsRpc,
  timeoutMs = 3_000,
): Notifications {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
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
  const broadcast = async (
    operation: () => Promise<{ created: boolean }>,
  ): Promise<BroadcastResult> => {
    try {
      const response = await operation();
      return { kind: "ok", created: response.created };
    } catch (cause) {
      return toFailure(cause);
    }
  };
  const audience = async (
    operation: () => Promise<{ recipientCount: number }>,
  ): Promise<BroadcastAudienceCount> => {
    try {
      const response = await operation();
      return Number.isInteger(response.recipientCount) &&
        response.recipientCount >= 0
        ? { kind: "ok", recipientCount: response.recipientCount }
        : { kind: "invalid", cause: response.recipientCount };
    } catch (cause) {
      return toFailure(cause);
    }
  };
  // Частота вне словаря — `UNSPECIFIED` или число новее бота — ответ вне
  // контракта: сервер отдаёт умолчание `EVERY` сам, и бот его не додумывает.
  const auctionSettings = async (
    operation: () => Promise<WireAuctionPreferences>,
  ): Promise<AuctionNotificationsResult> => {
    try {
      const response = await operation();
      const settings = auctionNotificationsOf(response);
      return settings === undefined
        ? { kind: "unknown", value: response.outbidFrequency }
        : { kind: "ok", settings };
    } catch (cause) {
      return toFailure(cause);
    }
  };
  return {
    getAuctionNotifications: (identityId, meta) =>
      auctionSettings(() =>
        rpc.getAuctionNotificationPreferences({ identityId }, options(meta)),
      ),
    setAuctionNotifications: (identityId, change, meta) =>
      auctionSettings(() =>
        rpc.setAuctionNotificationPreferences(
          { identityId, ...auctionNotificationsToWire(change) },
          options(meta),
        ),
      ),
    broadcastToMeetupSubscribers: (
      { identityId, meetupId, broadcastId, body },
      meta,
    ) =>
      broadcast(() =>
        rpc.broadcastToMeetupSubscribers(
          { identityId, meetupId, id: broadcastId, body },
          options(meta),
        ),
      ),
    broadcastToCommunity: ({ identityId, broadcastId, body }, meta) =>
      broadcast(() =>
        rpc.broadcastToCommunity(
          { identityId, id: broadcastId, body },
          options(meta),
        ),
      ),
    previewMeetupBroadcast: ({ identityId, meetupId }, meta) =>
      audience(() =>
        rpc.previewMeetupBroadcast({ identityId, meetupId }, options(meta)),
      ),
    previewCommunityBroadcast: ({ identityId }, meta) =>
      audience(() =>
        rpc.previewCommunityBroadcast({ identityId }, options(meta)),
      ),
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
    reportReleaseNotes: async (recordIds, meta) => {
      try {
        await rpc.reportReleaseNotes(
          { recordIds: [...recordIds] },
          options(meta),
        );
        return { kind: "ok" };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    listReleaseSummaries: async (pageToken, meta) => {
      try {
        const response = await rpc.listReleaseSummaries(
          { pageToken: pageToken ?? "", pageSize: 0 },
          options(meta),
        );
        const next = response.nextPageToken;
        return {
          kind: "ok",
          page: {
            summaries: response.summaries.map(toReleaseSummary),
            ...(next === "" ? {} : { nextPageToken: next }),
          },
        };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    getReleaseSummary: async (summaryId, meta) => {
      try {
        const response = await rpc.getReleaseSummary(
          { summaryId },
          options(meta),
        );
        const summary = response.summary;
        if (summary === undefined) return { kind: "not-found" };
        const olderId = response.olderSummaryId;
        const newerId = response.newerSummaryId;
        return {
          kind: "ok",
          view: {
            summary: toReleaseSummary(summary),
            ...(olderId === undefined || olderId === "" ? {} : { olderId }),
            ...(newerId === undefined || newerId === "" ? {} : { newerId }),
          },
        };
      } catch (cause) {
        if (cause instanceof ConnectError && cause.code === Code.NotFound) {
          return { kind: "not-found" };
        }
        return toFailure(cause);
      }
    },
  };
}

function toReleaseSummary(summary: WireReleaseSummary): {
  id: string;
  summarizedAt: string;
  recordIds: readonly string[];
} {
  return {
    id: summary.summaryId,
    summarizedAt: summary.summarizedAt,
    recordIds: summary.recordIds,
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
    return { kind: "invalid", cause };
  }
  // ALREADY_EXISTS приходит только на рассылке: тот же `id` уже принят с другим
  // текстом, сходкой или автором. Это конфликт команды, а не недоступность
  // зависимости, и повтор с тем же ключом его не вылечит.
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
  return (
    category === "changes" ||
    category === "material" ||
    category === "reminder" ||
    category === "organizer"
  );
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
    case "access-community":
      return WireCategory.ACCESS_REQUEST_COMMUNITY;
    case "access-auction":
      return WireCategory.ACCESS_REQUEST_AUCTION;
    case "release":
      return WireCategory.RELEASE_NOTES;
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
    case WireCategory.ACCESS_REQUEST_COMMUNITY:
      return "access-community";
    case WireCategory.ACCESS_REQUEST_AUCTION:
      return "access-auction";
    case WireCategory.RELEASE_NOTES:
      return "release";
    default:
      return undefined;
  }
}
