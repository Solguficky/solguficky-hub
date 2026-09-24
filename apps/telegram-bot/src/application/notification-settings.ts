import type { Meetups } from "../meetups/port.js";
import type {
  GlobalPreferences,
  MeetupPreferences,
  NotificationFailure,
  Notifications,
} from "../notifications/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type {
  ExecuteResult,
  NotificationCategoryView,
  NotificationRequest,
} from "./types.js";

export type NotificationSettings = (
  request: NotificationRequest,
) => Promise<ExecuteResult>;

export function createNotificationSettings(
  meetups: Meetups,
  notifications: Notifications,
): NotificationSettings {
  // Кадр сходки собирается из трёх источников: сама сходка даёт заголовок,
  // снимок сходки — действующие значения и признак подписки, глобальный снимок
  // — то, с чем эти значения сравниваются. Сравнение и есть единственный способ
  // показать расхождение: контракт намеренно не сообщает, чем получено
  // значение, поэтому «значение отличается» бот доказать может, а «здесь стоит
  // переопределение» — нет.
  const meetupFrame = async (
    request: NotificationRequest & { meetupId: string },
    preferences: MeetupPreferences,
  ): Promise<ExecuteResult> => {
    const meta = rpcMeta(request);
    const card = await meetups.get(request.identity, request.meetupId, meta);
    if (card.kind === "not-found") return { kind: "meetup-not-found" };
    if (card.kind !== "ok") return rejection(card);
    const global = await notifications.getGlobalPreferences(
      request.identity.identityId,
      meta,
    );
    if (global.kind !== "ok") return rejection(global);
    return {
      kind: "meetup-notification-settings",
      meetup: card.meetup,
      subscribed: preferences.subscribed,
      categories: compare(preferences, global.preferences),
    };
  };
  const readMeetup = async (
    request: NotificationRequest & { meetupId: string },
    command: () => Promise<
      Awaited<ReturnType<Notifications["getMeetupPreferences"]>>
    >,
  ): Promise<ExecuteResult> => {
    const preferences = await command();
    return preferences.kind === "ok"
      ? meetupFrame(request, preferences.preferences)
      : rejection(preferences);
  };
  const globalFrame = (
    result: Awaited<ReturnType<Notifications["getGlobalPreferences"]>>,
  ): ExecuteResult =>
    result.kind === "ok"
      ? {
          kind: "global-notification-settings",
          categories: result.preferences.categories,
        }
      : rejection(result);

  return async (request) => {
    const meta = rpcMeta(request);
    const identityId = request.identity.identityId;
    switch (request.intent) {
      case "view-global-notifications":
        return globalFrame(
          await notifications.getGlobalPreferences(identityId, meta),
        );
      case "set-global-category":
        return globalFrame(
          await notifications.setGlobalCategory(
            identityId,
            request.category,
            request.enabled,
            meta,
          ),
        );
      case "view-meetup-notifications":
        return readMeetup(request, () =>
          notifications.getMeetupPreferences(
            identityId,
            request.meetupId,
            meta,
          ),
        );
      // Подписка возвращает карточку, а не кадр настроек: нажали её в P-04, и
      // человек остаётся там же. Глобальный снимок для этого не нужен —
      // сравнивать нечего, и лишнего вызова не делается.
      case "set-meetup-subscription": {
        const changed = await notifications.setSubscription(
          identityId,
          request.meetupId,
          request.subscribed,
          meta,
        );
        if (changed.kind !== "ok") return rejection(changed);
        const card = await meetups.get(
          request.identity,
          request.meetupId,
          meta,
        );
        if (card.kind === "not-found") return { kind: "meetup-not-found" };
        if (card.kind !== "ok") return rejection(card);
        return {
          kind: "meetup-card",
          meetup: card.meetup,
          subscribed: changed.preferences.subscribed,
        };
      }
      case "set-meetup-category":
        return readMeetup(request, () =>
          notifications.setMeetupCategory(
            identityId,
            request.meetupId,
            request.category,
            request.enabled,
            meta,
          ),
        );
      default: {
        const _exhaustive: never = request;
        return { kind: "rejected", reason: String(_exhaustive) };
      }
    }
  };
}

function compare(
  meetup: MeetupPreferences,
  global: GlobalPreferences,
): readonly NotificationCategoryView[] {
  return meetup.categories.map((entry) => {
    const counterpart = global.categories.find(
      (candidate) => candidate.category === entry.category,
    );
    return {
      category: entry.category,
      enabled: entry.enabled,
      // Глобального значения нет в снимке — сравнивать не с чем, и расхождение
      // не заявляется: молчание честнее выдуманного «как везде».
      differsFromGlobal:
        counterpart !== undefined && counterpart.enabled !== entry.enabled,
    };
  });
}

function rejection(failure: NotificationFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? {
        kind: "dependency-rejected",
        reason: "invalid",
        message: failure.message,
      }
    : { kind: "dependency-rejected", reason: failure.kind };
}
