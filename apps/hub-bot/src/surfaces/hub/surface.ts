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
import {
  createFinalNoticeRender,
  isFinalNotice,
} from "../../core/notifications/final-notice.js";
import {
  createLotNoticeRender,
  isLotNotice,
  type LotNoticeReads,
  logMissingTitle,
} from "../../core/notifications/lot-notice.js";
import type { SurfaceDefinition } from "../../core/process.js";
import { rpcMeta } from "../../core/rpc-metadata.js";
import { createUuidV7 } from "../../core/uuid-v7.js";
import { createDispatcher } from "./application/dispatcher.js";
import { createAuctionClient } from "./auction/client.js";
import { communityDay } from "./community-time.js";
import { readHubConfig } from "./config.js";
import {
  createAccessRequestRender,
  logBodyMissing,
} from "./delivery/access-request.js";
import { decodeNotification } from "./delivery/notification.js";
import { createIdentityClient } from "./identity/client.js";
import { createMeetupsClient } from "./meetups/client.js";
import { createNotificationsClient } from "./notifications/client.js";
import { createBot } from "./presentation/bot.js";
import { botCommands } from "./presentation/commands.js";
import {
  createNotificationApi,
  createNotificationSender,
} from "./presentation/notification-message.js";
import { releaseTraceDay } from "./presentation/screens/release-notes.js";
import { toReleaseTrace } from "./release-lines.js";
import { startReleaseNotesReport } from "./release-report.js";

// Поверхность хаба (ADR-064, п. 18): процесс с `BOT_SURFACE=hub`. Здесь — её
// клиенты, бот и разбор её веток уведомлений; процесс вокруг них общий
// (`src/core/process.ts`).
export const hubSurface: SurfaceDefinition = ({
  env,
  config,
  logger,
  tracing,
  releaseNotes,
}) => {
  const loaded = readHubConfig(env);
  if (!loaded.ok) return loaded;
  const hub = loaded.config;
  const { token, serviceToken, environment, communityTimeZone } = config;
  const meetups = createMeetupsClient(hub.meetupsUrl, {
    communityTimeZone,
    tracing,
    serviceToken,
  });
  const notifications = createNotificationsClient(hub.notificationsUrl, {
    tracing,
    serviceToken,
  });
  // День сообщества считается тем же поясом, что и у Meetups: иначе граница
  // «прошедшей» даты разойдётся с той, по которой сходка уходит в архив.
  const today = () => communityDay(new Date(), communityTimeZone);
  // Отказ `GetDisplayNames` дерево гасит, и карточка лота остаётся без имени;
  // запись на warn делает деградацию видимой.
  const auction =
    hub.auctionUrl === undefined
      ? undefined
      : createAuctionClient(hub.auctionUrl, {
          tracing,
          serviceToken,
          onNamesRefused: (cause, meta) =>
            logger.warn("auction display names unavailable", {
              ...(meta?.requestId === undefined
                ? {}
                : { request_id: meta.requestId }),
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          // Лента без кнопки «Розыгрыш» — деградация, а не отказ экрана.
          onRaffleRefused: (cause, meta) =>
            logger.warn("raffle unavailable", {
              ...(meta?.requestId === undefined
                ? {}
                : { request_id: meta.requestId }),
              error_category: "dependency_unavailable",
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        });
  if (auction === undefined) {
    logger.info("AUCTION_GRPC_URL is not set: meetup auctions are off");
  }
  // Клиент Auction один в трёх ролях диспетчера: оболочка сходки, форма
  // лота и пульт аукциона администратора. Identity создаётся до диспетчера:
  // пульт спрашивает у него настоящий аккаунт победителя (PER-648).
  const identity = createIdentityClient(config.identityUrl, {
    communityTimeZone,
    tracing,
    serviceToken,
    // Настоящий аккаунт победителя гасит экран, и карточка остаётся с
    // псевдонимом (PER-648); warn делает деградацию видимой.
    onParticipantUsernameRefused: (failure) =>
      logger.warn("participant username unavailable", {
        ...(failure.requestId === undefined
          ? {}
          : { request_id: failure.requestId }),
        error_category:
          failure.code === undefined ? "dependency_unavailable" : "invariant",
        error:
          failure.code ??
          (failure.cause instanceof Error
            ? failure.cause.message
            : String(failure.cause)),
      }),
  });
  const dispatcher = createDispatcher(
    meetups,
    notifications,
    today,
    auction,
    auction,
    auction === undefined
      ? undefined
      : {
          auctions: auction,
          timeZone: communityTimeZone,
          usernames: identity,
        },
    releaseNotes,
  );
  const releaseReport = startReleaseNotesReport({
    recordIds: releaseNotes.idsFor("hub"),
    logger,
    report: async (recordIds) => {
      const reported = await notifications.reportReleaseNotes(recordIds);
      if (reported.kind === "ok") return { kind: "ok" };
      return {
        kind: "failed",
        cause: "cause" in reported ? reported.cause : new Error(reported.kind),
      };
    },
  });
  // Карточки финала (PER-336): поток аукциона и темп правок живут столько же,
  // сколько процесс, и гасятся до клиентов.
  const watches =
    auction === undefined
      ? undefined
      : createAuctionWatches({
          source: auction.watch,
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
  const bot = createBot({
    token,
    dispatcher,
    identity,
    logger,
    tracing,
    presentation: config.presentation,
    environment,
    faq: hub.faq,
    today,
    ...(hub.auctionBotUsername === undefined
      ? {}
      : { auctionBotUsername: hub.auctionBotUsername }),
    ...(hub.supportBotUsername === undefined
      ? {}
      : { supportBotUsername: hub.supportBotUsername }),
    communityTimeZone,
    ...(auction === undefined
      ? {}
      : {
          auction,
          ...(watches === undefined
            ? {}
            : {
                live: {
                  watches,
                  limiter,
                  names: {
                    getDisplayNames: (request) =>
                      auction
                        .screenPorts(rpcMeta({ requestId: createUuidV7() }))
                        .auction.getDisplayNames(request),
                  },
                },
              }),
          // Избранное — лоты аукциона: без Auction его нечем показать.
          // Отказ списка карточка гасит, и запись на warn делает это видимым.
          favorites: (meta) =>
            notifications.favorites(meta, (cause) =>
              logger.warn("favorite lots unavailable", {
                ...(meta?.requestId === undefined
                  ? {}
                  : { request_id: meta.requestId }),
                error_category: "dependency_unavailable",
                error: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
          proxyExplainer: (meta) =>
            notifications.proxyExplainer(meta, (cause) =>
              logger.warn("proxy explainer mark unavailable", {
                ...(meta?.requestId === undefined
                  ? {}
                  : { request_id: meta.requestId }),
                error_category: "dependency_unavailable",
                error: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
        }),
  });
  // Без Auction аукционных фактов нет, а пришедший всё равно уходит — без
  // названия и без кнопки частоты: её экран живёт в расширении аукциона.
  const noticeReads: LotNoticeReads | undefined =
    auction === undefined
      ? undefined
      : {
          holdsPlaceBids: (identityId, requestId) =>
            identity.holdsPlaceBids(
              identityId,
              requestId === undefined ? undefined : rpcMeta({ requestId }),
            ),
          lotInfo: (identityId, lotId, requestId) =>
            auction.lotInfo(
              identityId,
              lotId,
              requestId === undefined ? undefined : rpcMeta({ requestId }),
            ),
        };
  const renderLot = createLotNoticeRender({
    reads: noticeReads,
    onTitleMissing: logMissingTitle(logger),
    frequencyButton: auction !== undefined,
    timeZone: communityTimeZone,
  });
  // Анонс финала (PER-478) — тот же общий рендер и те же чтения, что у бота
  // аукциона; у отправителя он едет видом вести о лоте.
  const renderFinal = createFinalNoticeRender({
    reads: noticeReads,
    onTitleMissing: logMissingTitle(logger),
  });
  // Оповещение о заявке несёт её тело (PER-634): карточку бот читает при
  // доставке из очереди правами получателя, тем же вызовом, что экран заявки.
  const renderAccessRequest = createAccessRequestRender({
    read: (identityId, queue, after, requestId) =>
      identity.readApplicationQueue(
        { identityId },
        queue,
        after,
        requestId === undefined ? undefined : rpcMeta({ requestId }),
      ),
    now: Date.now,
    onBodyMissing: logBodyMissing(logger),
  });
  const sender = createNotificationSender(
    createNotificationApi(token, environment),
    hub.auctionBotUsername,
    today,
    communityTimeZone,
  );
  return {
    ok: true,
    config: {
      bot,
      commands: botCommands,
      startDelivery: (options) =>
        startNatsDelivery({
          ...options,
          countFailure,
          decode: decodeNotification,
          deliver: (journal) =>
            createDeliverNotification({
              journal,
              recipients: {
                resolveTelegramUserId: (identityId, requestId) =>
                  identity.resolveTelegramUserId(
                    identityId,
                    requestId === undefined
                      ? undefined
                      : rpcMeta({ requestId }),
                  ),
              },
              // Вести хаба рисует отправитель, соседи им не нужны. Весть о лоте
              // и анонс финала собирают общие рендеры двух ботов (PER-598,
              // PER-478): право получателя у Identity и название лота у
              // Auction. Оповещение о заявке читает её карточку у Identity
              // (PER-634).
              render: async (content, context) => {
                if (content.kind === "release-summary") {
                  const day = releaseTraceDay(
                    content.summarizedAt,
                    communityTimeZone,
                    today(),
                  );
                  if (day === undefined) {
                    return {
                      kind: "rejected",
                      cause: new Error("release summary date"),
                    };
                  }
                  return toReleaseTrace(
                    releaseNotes,
                    content.recordIds,
                    content.summaryId,
                    day,
                  );
                }
                if (content.kind === "access-requested") {
                  return renderAccessRequest(content, context);
                }
                if (!isLotNotice(content) && !isFinalNotice(content)) {
                  return { kind: "ready", message: content };
                }
                const rendered = isFinalNotice(content)
                  ? await renderFinal(content, context)
                  : await renderLot(content, context);
                return rendered.kind === "ready"
                  ? {
                      kind: "ready",
                      message: {
                        kind: "lot-notice" as const,
                        view: rendered.message,
                      },
                    }
                  : rendered;
              },
              sender,
            }),
        }),
      close() {
        releaseReport.close();
        limiter.close();
        watches?.close();
        identity.close();
        meetups.close();
        notifications.close();
        auction?.close();
      },
      // Без имени бота аукциона экран каналов отдаёт только ссылку хаба: по
      // записи старта видно, задумано это или настройка потерялась.
      startFields: {
        auction_bot_links: hub.auctionBotUsername !== undefined,
      },
    },
  };
};
