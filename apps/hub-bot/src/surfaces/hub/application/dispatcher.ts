import type { ReleaseNotes } from "../../../core/release-notes.js";
import { rpcMeta } from "../../../core/rpc-metadata.js";
import type {
  AuctionConsoles,
  LotAdministration,
  MeetupAuctions,
} from "../auction/port.js";
import type { ParticipantUsernameResolver } from "../identity/port.js";
import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import {
  type AuctionAnnouncements,
  createAuctionAnnouncements,
} from "./auction-announcements.js";
import { createAuctionConsole } from "./auction-console.js";
import { createAuctionInvoices } from "./auction-invoices.js";
import { createBroadcasts } from "./broadcasts.js";
import { createFloorBids } from "./floor-bids.js";
import { createLotForm } from "./lot-form.js";
import { createLotLayout } from "./lot-layout.js";
import { createLotSets } from "./lot-sets.js";
import { createMeetupAuction } from "./meetup-auction.js";
import { type CommunityToday, createMeetupForm } from "./meetup-form.js";
import { createMeetupMaterials } from "./meetup-materials.js";
import { createNotificationSettings } from "./notification-settings.js";
import { createParticipantRemoval } from "./participant-removal.js";
import { createPromoVideo } from "./promo-video.js";
import { createRafflePrizeChange } from "./raffle-prize-change.js";
import { createRafflePrizePhoto } from "./raffle-prize-photo.js";
import { createRaffleWinner } from "./raffle-winner.js";
import { createReleaseNotes } from "./release-notes.js";
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
    // Настоящий аккаунт победителя для пульта (PER-648): его отдаёт Identity
    // по праву ведущего.
    usernames?: ParticipantUsernameResolver;
    // Приём объявления аукциона (PER-765) — Notifications; нет — пульт без
    // «Объявления».
    announcements?: AuctionAnnouncements;
    // Чат медиа ботов включён (PER-776): шаг фото объявления предлагает своё
    // фото или видео.
    media?: boolean;
  },
  releaseNotes?: ReleaseNotes,
): Dispatcher {
  // Форма лота читает пульт аукциона (PER-716): реестр и сеты нужны копиям,
  // удалению и правке всего сета; без пульта она — форма одного лота.
  const lotForm =
    lots === undefined ? undefined : createLotForm(lots, consoles?.auctions);
  const auctionConsole =
    consoles === undefined
      ? undefined
      : createAuctionConsole(
          consoles.auctions,
          consoles.timeZone,
          consoles.now,
          consoles.usernames,
          meetups,
        );
  // «Ставки зала» помощника (PER-565) — тот же порт, что у пульта: оба
  // пускает право вести аукцион.
  const floorBids =
    consoles === undefined ? undefined : createFloorBids(consoles.auctions);
  // Снятие участника с лота (PER-659) — тот же порт: команды администратора
  // пускает право вести аукцион.
  const participantRemoval =
    consoles === undefined
      ? undefined
      : createParticipantRemoval(consoles.auctions);
  // Сеты лотов (PER-509) — тот же порт: команды сета пускает право вести
  // аукцион.
  const lotSets =
    consoles === undefined ? undefined : createLotSets(consoles.auctions);
  // Порядок и разделы ленты (PER-719) — тот же порт: раскладку пускает право
  // вести аукцион.
  const lotLayout =
    consoles === undefined ? undefined : createLotLayout(consoles.auctions);
  // Счета аукциона (PER-321) — тот же порт: сводку и отметки пускает право
  // вести аукцион.
  const auctionInvoices =
    consoles === undefined
      ? undefined
      : createAuctionInvoices(consoles.auctions, consoles.now);
  // Итог розыгрыша вручную (PER-727) — тот же порт: назначение победителя
  // пускает право вести аукцион.
  const raffleWinner =
    consoles === undefined ? undefined : createRaffleWinner(consoles.auctions);
  // Смена приза идущего розыгрыша (PER-737) — тот же порт и то же право.
  const rafflePrizeChange =
    consoles === undefined
      ? undefined
      : createRafflePrizeChange(consoles.auctions);
  // Фото приза идущего розыгрыша (PER-773) — тот же порт и то же право.
  const rafflePrizePhoto =
    consoles === undefined
      ? undefined
      : createRafflePrizePhoto(consoles.auctions);
  // Промо-видео (PER-774) — тот же порт и то же право.
  const promoVideo =
    consoles === undefined ? undefined : createPromoVideo(consoles.auctions);
  // Объявление аукциона (PER-765): пульт читает тот же порт, а приём —
  // Notifications.
  const auctionAnnouncements =
    consoles?.announcements === undefined
      ? undefined
      : createAuctionAnnouncements(consoles.auctions, consoles.announcements, {
          media: consoles.media === true,
          ...(consoles.now === undefined ? {} : { now: consoles.now }),
        });
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
  const releaseNotesView =
    notifications === undefined || releaseNotes === undefined
      ? undefined
      : createReleaseNotes(notifications, releaseNotes);
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
      const cancelConsequence =
        request.intent === "view-meetup" &&
        request.withCancelConsequence === true &&
        meetupAuction !== undefined
          ? await meetupAuction.cancelConsequence(withAuction.auction, request)
          : undefined;
      const shown =
        cancelConsequence === undefined
          ? withAuction
          : { ...withAuction, cancelConsequence };
      return preferences?.kind === "ok"
        ? {
            ...shown,
            subscribed: preferences.preferences.subscribed,
          }
        : shown;
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
        case "keep-lot-step":
        case "add-lot-photo":
        case "remove-lot-photo":
        case "retry-lot-set":
        case "copy-lot":
        case "remove-lot":
          return lotForm === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : lotForm(request);
        case "view-auction-console":
        case "view-day-summary":
        case "ask-auction-week":
        case "prepare-auction-week-start":
        case "schedule-auction-week":
        case "ask-auction-raffle":
        case "set-auction-raffle":
        case "remove-auction-raffle":
        case "ask-auction-raffle-prize":
        case "set-auction-raffle-prize":
        case "remove-auction-raffle-prize":
        case "ask-auction-payment-term":
        case "set-auction-payment-term":
        case "set-auction-final":
        case "set-auction-visibility":
        case "ask-auction-final-time":
        case "set-auction-final-time":
        case "remove-auction-final-time":
        case "start-auction-week":
        case "mark-auction-finalist":
        case "prepare-auction-discard":
        case "discard-auction":
        case "prepare-auction-cancel":
        case "cancel-auction":
        case "order-final-lineup":
        case "freeze-final-lineup":
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
        case "ask-step-window-launch":
        case "add-step-window-launch":
        case "set-step-window-launch-lot":
        case "view-step-window-launch":
        case "launch-step-window":
          return auctionConsole === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : auctionConsole(request);
        case "view-floor-bids":
        case "ask-floor-search":
        case "prepare-floor-bid":
        case "place-floor-bid":
          return floorBids === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : floorBids(request);
        case "view-lot-removal":
        case "prepare-participant-removal":
        case "remove-participant":
          return participantRemoval === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : participantRemoval(request);
        case "view-lot-sets":
        case "ask-lot-set":
        case "add-lot-set":
        case "view-lot-set":
        case "set-lot-set-lot":
        case "prepare-lot-set-delete":
        case "delete-lot-set":
          return lotSets === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : lotSets(request);
        case "view-lot-layout":
        case "view-lot-layout-list":
        case "view-lot-layout-lot":
        case "move-lot-layout-lot":
        case "place-lot-layout-lot":
        case "ask-lot-section":
        case "name-lot-section":
        case "move-lot-section":
        case "prepare-lot-section-delete":
        case "delete-lot-section":
          return lotLayout === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : lotLayout(request);
        case "view-auction-invoices":
        case "view-auction-invoice":
        case "prepare-invoice-mark":
        case "mark-invoice":
        case "ask-auction-payment-text":
        case "set-auction-payment-text":
        case "remove-auction-payment-text":
          return auctionInvoices === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : auctionInvoices(request);
        case "view-raffle-winner":
        case "ask-raffle-winner":
        case "pick-raffle-winner":
        case "prepare-raffle-winner":
        case "assign-raffle-winner":
          return raffleWinner === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : raffleWinner(request);
        case "ask-raffle-prize-change":
        case "pick-raffle-prize-change":
        case "change-raffle-prize":
          return rafflePrizeChange === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : rafflePrizeChange(request);
        case "view-raffle-prize-photo":
        case "ask-raffle-prize-photo":
        case "set-raffle-prize-photo":
        case "remove-raffle-prize-photo":
          return rafflePrizePhoto === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : rafflePrizePhoto(request);
        case "view-promo-video":
        case "set-promo-video":
          return promoVideo === undefined
            ? { kind: "rejected", reason: "auction-not-configured" }
            : promoVideo(request);
        case "open-announcement":
        case "list-announcement-windows":
        case "list-announcement-lots":
        case "ask-announcement":
        case "answer-announcement":
        case "pick-announcement-button":
        case "ask-announcement-media":
        case "ask-announcement-audience":
        case "preview-announcement":
        case "send-announcement":
          return auctionAnnouncements === undefined
            ? { kind: "rejected", reason: "notifications-not-configured" }
            : auctionAnnouncements(request);
        case "send-broadcast":
        case "preview-broadcast":
          return broadcasts === undefined
            ? { kind: "rejected", reason: "notifications-not-configured" }
            : broadcasts(request);
        case "view-release-notes":
          return releaseNotesView === undefined
            ? { kind: "rejected", reason: "notifications-not-configured" }
            : releaseNotesView(request);
        default: {
          const _exhaustive: never = request;
          return { kind: "rejected", reason: String(_exhaustive) };
        }
      }
    },
  };
}
