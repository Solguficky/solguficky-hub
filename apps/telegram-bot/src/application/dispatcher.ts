import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import { createMeetupForm } from "./meetup-form.js";
import { createNotificationSettings } from "./notification-settings.js";
import { start } from "./start.js";
import type { ExecuteRequest, ExecuteResult } from "./types.js";

export type Dispatcher = {
  execute(request: ExecuteRequest): ExecuteResult | Promise<ExecuteResult>;
};

export function createDispatcher(
  meetups?: Meetups,
  notifications?: Notifications,
): Dispatcher {
  const form = meetups === undefined ? undefined : createMeetupForm(meetups);
  // Кадры уведомлений читают и сходку тоже: заголовок кадра берётся из Meetups,
  // а значения категорий — из Notifications.
  const settings =
    meetups === undefined || notifications === undefined
      ? undefined
      : createNotificationSettings(meetups, notifications);
  return {
    async execute(request) {
      switch (request.intent) {
        case "start":
          return start(request);
        case "list-visible-meetups": {
          if (meetups === undefined) {
            return { kind: "rejected", reason: "meetups-not-configured" };
          }
          const result = await meetups.listVisible(
            request.identity,
            rpcMeta(request),
          );
          return result.kind === "ok"
            ? { kind: "meetup-list", meetups: result.meetups }
            : result.kind === "invalid"
              ? {
                  kind: "dependency-rejected",
                  reason: "invalid",
                  message: result.message,
                }
              : { kind: "dependency-rejected", reason: result.kind };
        }
        case "view-meetup": {
          if (meetups === undefined)
            return { kind: "rejected", reason: "meetups-not-configured" };
          const result = await meetups.get(
            request.identity,
            request.meetupId,
            rpcMeta(request),
          );
          if (result.kind === "ok") {
            const card: ExecuteResult = {
              kind: "meetup-card",
              meetup: result.meetup,
            };
            if (notifications === undefined) return card;
            // Отказ Notifications карточку не роняет: сходка читается из
            // Meetups и остаётся верной. Состояние подписки при этом не
            // показывается, и кнопки подписки в кадре не будет — вместо
            // выдуманного «выключены» человек видит отсутствие выбора.
            const preferences = await notifications.getMeetupPreferences(
              request.identity.identityId,
              request.meetupId,
              rpcMeta(request),
            );
            return preferences.kind === "ok"
              ? { ...card, subscribed: preferences.preferences.subscribed }
              : card;
          }
          if (result.kind === "not-found") return { kind: "meetup-not-found" };
          return result.kind === "invalid"
            ? {
                kind: "dependency-rejected",
                reason: "invalid",
                message: result.message,
              }
            : { kind: "dependency-rejected", reason: result.kind };
        }
        case "create-meetup":
        case "set-meetup-field":
        case "update-meetup-field":
        case "publish-meetup":
        case "change-meetup-state":
          return form === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : form(request);
        case "view-global-notifications":
        case "set-global-category":
        case "view-meetup-notifications":
        case "set-meetup-subscription":
        case "set-meetup-category":
          return settings === undefined
            ? { kind: "rejected", reason: "notifications-not-configured" }
            : settings(request);
        default: {
          const _exhaustive: never = request;
          return { kind: "rejected", reason: String(_exhaustive) };
        }
      }
    },
  };
}
