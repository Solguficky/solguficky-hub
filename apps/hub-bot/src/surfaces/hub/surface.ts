import {
  createDeliverNotification,
  startNatsDelivery,
} from "../../core/delivery/index.js";
import { countFailure } from "../../core/failures.js";
import type { SurfaceDefinition } from "../../core/process.js";
import { rpcMeta } from "../../core/rpc-metadata.js";
import { createDispatcher } from "./application/dispatcher.js";
import { createAuctionClient } from "./auction/client.js";
import { communityDay } from "./community-time.js";
import { readHubConfig } from "./config.js";
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

// Поверхность хаба (ADR-064, п. 18): процесс с `BOT_SURFACE=hub`. Здесь — её
// клиенты, бот и разбор её веток уведомлений; процесс вокруг них общий
// (`src/core/process.ts`).
export const hubSurface: SurfaceDefinition = ({
  env,
  config,
  logger,
  tracing,
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
        });
  if (auction === undefined) {
    logger.info("AUCTION_GRPC_URL is not set: meetup auctions are off");
  }
  // Клиент Auction один в трёх ролях диспетчера: оболочка сходки, форма
  // лота и пульт аукциона администратора.
  const dispatcher = createDispatcher(
    meetups,
    notifications,
    today,
    auction,
    auction,
    auction === undefined
      ? undefined
      : { auctions: auction, timeZone: communityTimeZone },
  );
  const identity = createIdentityClient(config.identityUrl, {
    communityTimeZone,
    tracing,
    serviceToken,
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
    communityTimeZone,
    ...(auction === undefined ? {} : { auction }),
  });
  const sender = createNotificationSender(
    createNotificationApi(token, environment),
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
              // Хабу для текста соседи не нужны: содержимое рисует отправитель.
              render: async (content) => ({ kind: "ready", message: content }),
              sender,
            }),
        }),
      close() {
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
