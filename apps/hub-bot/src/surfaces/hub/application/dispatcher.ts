import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  LotAdministration,
  MeetupAuctions,
} from "../auction/port.js";
import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
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
  consoles?: {
    auctions: AuctionConsoles;
    timeZone: string;
    // Часы бота; тест их подменяет.
    now?: () => Date;
  },
): Dispatcher {
  const lotForm = lots === undefined ? undefined : createLotForm(lots);
  const auctionConsole =
    consoles === undefined
      ? undefined
      : createAuctionConsole(
          consoles.auctions,
          consoles.timeZone,
          consoles.now,
        );
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
  // аукцион из Auction — для строки аукциона (PER-594); меню «Расширения» —
  // сходка и аукцион. Отказ соседа сходки экран не роняет.
  async function viewMeetup(
    request: Extract<
      ExecuteRequest,
      { intent: "view-meetup" | "view-meetup-extensions" }
    >,
    readPreferences: boolean,
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
      // Аукцион нужен и карточке, и меню «Расширения» (PER-605, PER-594),
      // подписка — только карточке; вторичные чтения не роняют экран и идут
      // параллельно друг другу.
      const [withAuction, preferences] = await Promise.all([
        meetupAuction !== undefined
          ? meetupAuction.withAuction(card, request)
          : card,
        // Меню «Расширения» подпиской не пользуется: её не читают.
        !readPreferences
          ? undefined
          : notifications?.getMeetupPreferences(
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

  // Карточка, которую команда показывает сразу, — после публикации и смены
  // состояния из «Статуса», — несёт и строку аукциона (PER-594): иначе она
  // пропадала бы до следующего открытия. Остальные команды формы и подписка
  // отвечают экраном исхода, а не карточкой, и аукцион им не нужен.
  // Скрытый черновик и вопросы формы карточкой не показываются, и аукцион им
  // не нужен.
  async function withCardAuction(
    result: ExecuteResult,
    request: { identity: Person; requestId?: string; deadlineAt?: number },
  ): Promise<ExecuteResult> {
    if (meetupAuction === undefined) return result;
    switch (result.kind) {
      case "published":
      case "meetup-state-changed":
        return result.auction === undefined
          ? meetupAuction.withAuction(result, request)
          : result;
      default:
        return result;
    }
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
        // Карточка читает аукцион ради строки его состояния (PER-594;
        // ADR-064, дополнение 2026-10-12), кнопка «Расширения» остаётся без
        // состояния, а меню за ней читает аукцион само (PER-605).
        case "view-meetup":
          return viewMeetup(request, true);
        case "view-meetup-extensions":
          return viewMeetup(request, false);
        case "enable-auction":
          if (meetupAuction === undefined)
            return { kind: "rejected", reason: "auction-not-configured" };
          return meetupAuction.enable(request);
        case "create-meetup":
        case "set-meetup-field":
        case "update-meetup-field":
        case "publish-meetup":
        case "schedule-publication":
        case "change-meetup-state":
          return form === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : withCardAuction(await form(request), request);
        case "view-global-notifications":
        case "set-global-category":
        case "view-auction-notifications":
        case "set-auction-notifications":
        case "view-meetup-notifications":
        case "set-meetup-subscription":
        case "set-meetup-category":
          if (settings === undefined)
            return { kind: "rejected", reason: "notifications-not-configured" };
          return settings(request);
        case "attach-material":
        case "remove-material":
          return materials === undefined
            ? { kind: "rejected", reason: "meetups-not-configured" }
            : materials(request);
        case "create-lot":
        case "view-lot-form":
        case "view-lot-preview":
        case "set-lot-text":
        case "check-lot-price":
        case "set-lot-terms":
        case "set-lot-image":
          return lotForm === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : lotForm(request);
        case "view-auction-console":
        case "ask-auction-week":
        case "prepare-auction-week-start":
        case "schedule-auction-week":
        case "ask-auction-raffle":
        case "set-auction-raffle":
        case "remove-auction-raffle":
        case "set-auction-final":
        case "start-auction-week":
        case "mark-auction-finalist":
        case "prepare-auction-discard":
        case "discard-auction":
        case "start-auction-final":
        case "start-final-lot":
        case "ask-final-price":
        case "advance-final-ask":
        case "prepare-final-close":
        case "close-final-lot":
        case "view-step-windows":
        case "view-step-window":
        case "ask-step-window":
        case "add-step-window":
        case "set-step-window-lot":
        case "remove-step-window":
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
