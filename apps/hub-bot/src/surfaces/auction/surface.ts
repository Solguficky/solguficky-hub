import {
  reportLiveEditFailure,
  reportWatchFailure,
} from "../../core/auction/live-failures.js";
import { createAuctionWatches } from "../../core/auction/watch.js";
import { createEditLimiter } from "../../core/bot/edit-limiter.js";
import {
  createDeliverNotification,
  startNatsDelivery,
} from "../../core/delivery/index.js";
import { countFailure } from "../../core/failures.js";
import { createMediaChat } from "../../core/media-chat.js";
import { logMissingTitle } from "../../core/notifications/lot-notice.js";
import {
  createAnnouncementPhotos,
  logMissingAnnouncementPhoto,
} from "../../core/notifications/organizer-announcement.js";
import type { SurfaceDefinition } from "../../core/process.js";
import { createUuidV7 } from "../../core/uuid-v7.js";
import { createBot } from "./bot.js";
import { createClients } from "./clients.js";
import { readAuctionConfig } from "./config.js";
import {
  createNotificationApi,
  createNotificationSender,
  createRenderMessage,
} from "./delivery/message.js";
import { decodeNotification } from "./delivery/notification.js";
import { commandsFor } from "./menu-commands.js";

// Поверхность аукциона (ADR-064, п. 18): процесс с `BOT_SURFACE=auction`.
// Здесь — порты дерева поверх клиентов Identity и Auction, настройка
// «перебили» поверх Notifications (PER-515), бот и разбор веток
// уведомлений аукциона (PER-328); процесс вокруг них общий
// (`src/core/process.ts`). Поверхность хаба — отдельный процесс со своим
// токеном: остановка одного поллера другой не трогает.
export const auctionSurface: SurfaceDefinition = ({
  env,
  config,
  logger,
  tracing,
}) => {
  const loaded = readAuctionConfig(env);
  if (!loaded.ok) return loaded;
  const auction = loaded.config;
  const clients = createClients({
    onAchievementsRefused: (cause, meta) =>
      logger.warn("achievement screen unavailable", {
        ...(meta?.requestId === undefined ? {} : { request_id: meta.requestId }),
        error_category: "dependency_unavailable",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ...(auction.achievementsUrl === undefined
      ? {}
      : { achievementsUrl: auction.achievementsUrl }),
    identityUrl: config.identityUrl,
    auctionUrl: auction.auctionUrl,
    ...(auction.notificationsUrl === undefined
      ? {}
      : { notificationsUrl: auction.notificationsUrl }),
    serviceToken: config.serviceToken,
    tracing,
    onNamesRefused: (cause, requestId) =>
      logger.warn("display names unavailable", {
        request_id: requestId,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    // Карточка без кнопки избранного — деградация, а не отказ экрана.
    onFavoritesRefused: (cause, requestId) =>
      logger.warn("favorite lots unavailable", {
        request_id: requestId,
        error_category: "dependency_unavailable",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    // Без отметки вопрос лимита объясняет автоставку ещё раз.
    onProxyExplainerRefused: (cause, requestId) =>
      logger.warn("proxy explainer mark unavailable", {
        request_id: requestId,
        error_category: "dependency_unavailable",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    // Лента без кнопки «Розыгрыш» — деградация, а не отказ экрана.
    onRaffleRefused: (cause, requestId) =>
      logger.warn("raffle unavailable", {
        request_id: requestId,
        error_category: "dependency_unavailable",
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  if (auction.notificationsUrl === undefined) {
    logger.info(
      "NOTIFICATIONS_GRPC_URL is not set: favorite lots and outbid settings are off",
    );
  }
  // Карточки финала (PER-336): поток аукциона и темп правок живут столько же,
  // сколько процесс, и гасятся до клиентов.
  const watches = createAuctionWatches({
    source: clients.watch,
    onError: (_auctionId, cause, failure) =>
      reportWatchFailure(logger, cause, failure),
  });
  const limiter = createEditLimiter({
    onError: (_key, cause) =>
      reportLiveEditFailure(
        logger,
        cause instanceof Error ? cause.message : String(cause),
        "unexpected",
      ),
  });
  // Чат медиа ботов (PER-775): своё фото или видео объявления (PER-776) и
  // промо-видео аукциона (PER-774). Без `BOT_MEDIA_CHANNEL_ID` его нет.
  const mediaChat =
    config.mediaChannelId === undefined
      ? undefined
      : createMediaChat({ channelId: config.mediaChannelId, logger });
  const bot = createBot({
    token: config.token,
    environment: config.environment,
    tracing,
    presentation: config.presentation,
    // Корень аукциона ставит «🎬 Промо», только когда пост есть чем показать.
    ports:
      mediaChat === undefined
        ? clients.ports
        : (requestId, deadlineAt) => ({
            ...clients.ports(requestId, deadlineAt),
            media: true as const,
          }),
    ...(mediaChat === undefined ? {} : { media: mediaChat }),
    faq: auction.faq,
    logger,
    ...(auction.supportBotUsername === undefined
      ? {}
      : { supportBotUsername: auction.supportBotUsername }),
    timeZone: config.communityTimeZone,
    live: {
      watches,
      limiter,
      // Имена правки вне update: свой `request_id` у каждого чтения.
      names: {
        getDisplayNames: (request) =>
          clients.ports(createUuidV7()).auction.getDisplayNames(request),
      },
    },
  });
  // Фото лота объявления аукциона (PER-765) — правами получателя: адресата
  // выбрал издатель по праву ставок, а без него Auction фото не отдаёт.
  const announcementPhotos = createAnnouncementPhotos(
    (photo, identityId) =>
      clients.ports(createUuidV7()).image.getLotPhoto({
        viewer: { identityId, rights: ["place-bids"] },
        ...photo,
      }),
    logMissingAnnouncementPhoto(logger),
  );
  // Своё фото или видео объявления (PER-776) — пост чата медиа ботов; без
  // `BOT_MEDIA_CHANNEL_ID` объявление с постом уходит текстом.
  const sender = createNotificationSender(
    createNotificationApi(config.token, config.environment),
    announcementPhotos,
    mediaChat,
  );
  return {
    ok: true,
    config: {
      bot,
      commands: commandsFor(auction.notificationsUrl !== undefined),
      startDelivery: (options) =>
        startNatsDelivery({
          ...options,
          countFailure,
          decode: decodeNotification,
          deliver: (journal) =>
            createDeliverNotification({
              journal,
              recipients: clients.delivery.recipients,
              render: createRenderMessage(
                clients.delivery.reads,
                logMissingTitle(logger),
                clients.outbidSettings,
                config.communityTimeZone,
              ),
              sender,
            }),
        }),
      close() {
        limiter.close();
        watches.close();
        clients.close();
      },
    },
  };
};
