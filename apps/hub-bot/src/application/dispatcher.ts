import type {
  AuctionConsoles,
  LotAdministration,
  MeetupAuctions,
} from "../auction/port.js";
import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import { createAuctionConsole } from "./auction-console.js";
import { createBroadcasts } from "./broadcasts.js";
import { createLotForm } from "./lot-form.js";
import { createMeetupAuction } from "./meetup-auction.js";
import { type CommunityToday, createMeetupForm } from "./meetup-form.js";
import { createMeetupMaterials } from "./meetup-materials.js";
import { createNotificationSettings } from "./notification-settings.js";
import { start } from "./start.js";
import type { ExecuteRequest, ExecuteResult, Person } from "./types.js";

export type Dispatcher = {
  execute(request: ExecuteRequest): ExecuteResult | Promise<ExecuteResult>;
};

export function createDispatcher(
  meetups?: Meetups,
  notifications?: Notifications,
  today?: CommunityToday,
  auctions?: MeetupAuctions,
  lots?: LotAdministration,
  // Пульт аукциона (PER-320): сроки недели вводятся по времени сообщества, а
  // Auction принимает мгновения, поэтому пульту нужен пояс.
  consoles?: { auctions: AuctionConsoles; timeZone: string },
): Dispatcher {
  const lotForm = lots === undefined ? undefined : createLotForm(lots);
  const auctionConsole =
    consoles === undefined
      ? undefined
      : createAuctionConsole(consoles.auctions, consoles.timeZone);
  const meetupAuction =
    auctions === undefined ? undefined : createMeetupAuction(auctions);
  const form =
    meetups === undefined ? undefined : createMeetupForm(meetups, today);
  // Кадры уведомлений читают и сходку тоже: заголовок кадра берётся из Meetups,
  // а значения категорий — из Notifications.
  const settings =
    meetups === undefined || notifications === undefined
      ? undefined
      : createNotificationSettings(meetups, notifications);
  const materials =
    meetups === undefined ? undefined : createMeetupMaterials(meetups);
  const broadcasts =
    notifications === undefined ? undefined : createBroadcasts(notifications);
  // Карточка сходки: сама сходка из Meetups, подписка из Notifications и
  // аукцион из Auction. Отказ соседа сходки карточку не роняет.
  async function viewMeetup(
    request: Extract<ExecuteRequest, { intent: "view-meetup" }>,
    readAuction: boolean,
  ): Promise<ExecuteResult> {
    if (meetups === undefined)
      return { kind: "rejected", reason: "meetups-not-configured" };
    const result = await meetups.get(
      request.identity,
      request.meetupId,
      rpcMeta(request),
    );
    if (result.kind === "ok") {
      const card: Extract<ExecuteResult, { kind: "meetup-card" }> = {
        kind: "meetup-card",
        meetup: result.meetup,
      };
      // Аукцион и подписка читаются параллельно: оба — вторичные ряды
      // карточки, и зависший один не должен съесть бюджет действия другого.
      const [withAuction, preferences] = await Promise.all([
        readAuction && meetupAuction !== undefined
          ? meetupAuction.withAuction(card, request)
          : card,
        notifications?.getMeetupPreferences(
          request.identity.identityId,
          request.meetupId,
          rpcMeta(request),
        ),
      ]);
      // Отказ Notifications карточку не роняет: сходка читается из
      // Meetups и остаётся верной. Состояние подписки при этом не
      // показывается, и кнопки подписки в кадре не будет — вместо
      // выдуманного «выключены» человек видит отсутствие выбора.
      return preferences?.kind === "ok"
        ? {
            ...withAuction,
            subscribed: preferences.preferences.subscribed,
          }
        : withAuction;
    }
    if (result.kind === "not-found") return { kind: "meetup-not-found" };
    return result.kind === "invalid"
      ? {
          kind: "dependency-rejected",
          reason: "invalid",
          cause: result.cause,
        }
      : { kind: "dependency-rejected", reason: result.kind };
  }

  // Карточка, которую вернула команда на ней же — подписка, — несёт и ряд
  // аукциона: иначе нажатие «Подписаться» убирало бы с карточки «Лоты».
  async function withCardAuction(
    result: ExecuteResult,
    request: { identity: Person; requestId?: string; deadlineAt?: number },
  ): Promise<ExecuteResult> {
    return result.kind === "meetup-card" &&
      result.auction === undefined &&
      meetupAuction !== undefined
      ? meetupAuction.withAuction(result, request)
      : result;
  }

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
                  cause: result.cause,
                }
              : { kind: "dependency-rejected", reason: result.kind };
        }
        case "list-archived-meetups": {
          if (meetups === undefined) {
            return { kind: "rejected", reason: "meetups-not-configured" };
          }
          const result = await meetups.listArchived(
            request.identity,
            rpcMeta(request),
          );
          return result.kind === "ok"
            ? { kind: "archived-meetup-list", meetups: result.meetups }
            : result.kind === "invalid"
              ? {
                  kind: "dependency-rejected",
                  reason: "invalid",
                  cause: result.cause,
                }
              : { kind: "dependency-rejected", reason: result.kind };
        }
        case "view-meetup":
          return viewMeetup(request, true);
        case "enable-auction":
          if (meetupAuction === undefined)
            return { kind: "rejected", reason: "auction-not-configured" };
          return meetupAuction.enable(request, () =>
            viewMeetup(
              { ...request, intent: "view-meetup" },
              // Аукцион у карточки уже назван ответом команды.
              false,
            ),
          );
        case "create-meetup":
        case "set-meetup-field":
        case "update-meetup-field":
        case "publish-meetup":
        case "schedule-publication":
        case "change-meetup-state":
          return form === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : form(request);
        case "view-global-notifications":
        case "set-global-category":
        case "view-meetup-notifications":
        case "set-meetup-subscription":
        case "set-meetup-category":
          if (settings === undefined)
            return { kind: "rejected", reason: "notifications-not-configured" };
          return withCardAuction(await settings(request), request);
        case "attach-material":
        case "remove-material":
          return materials === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : materials(request);
        case "create-lot":
        case "view-lot-form":
        case "set-lot-text":
        case "check-lot-price":
        case "set-lot-terms":
        case "set-lot-image":
          return lotForm === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : lotForm(request);
        case "view-auction-console":
        case "schedule-auction-week":
        case "set-auction-final":
        case "start-auction-week":
        case "mark-auction-finalist":
          return auctionConsole === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : auctionConsole(request);
        case "send-broadcast":
          return broadcasts === undefined
            ? { kind: "rejected", reason: "notifications-not-configured" }
            : broadcasts(request);
        default: {
          const _exhaustive: never = request;
          return { kind: "rejected", reason: String(_exhaustive) };
        }
      }
    },
  };
}
