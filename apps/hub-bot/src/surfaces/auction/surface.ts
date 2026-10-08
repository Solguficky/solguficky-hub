import {
  createDeliverNotification,
  startNatsDelivery,
} from "../../core/delivery/index.js";
import { countFailure } from "../../core/failures.js";
import type { SurfaceDefinition } from "../../core/process.js";
import { createBot } from "./bot.js";
import { createClients } from "./clients.js";
import { readAuctionConfig } from "./config.js";
import {
  createNotificationApi,
  createNotificationSender,
  createRenderMessage,
} from "./delivery/message.js";
import { decodeNotification } from "./delivery/notification.js";
import { botCommands } from "./menu-commands.js";

// Поверхность аукциона (ADR-064, п. 18): процесс с `BOT_SURFACE=auction`.
// Здесь — порты дерева поверх клиентов Identity и Auction, бот и разбор веток
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
    identityUrl: config.identityUrl,
    auctionUrl: auction.auctionUrl,
    serviceToken: config.serviceToken,
    tracing,
    onNamesRefused: (cause, requestId) =>
      logger.warn("display names unavailable", {
        request_id: requestId,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const bot = createBot({
    token: config.token,
    environment: config.environment,
    tracing,
    presentation: config.presentation,
    ports: clients.ports,
    faq: auction.faq,
    logger,
    timeZone: config.communityTimeZone,
  });
  const sender = createNotificationSender(
    createNotificationApi(config.token, config.environment),
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
              recipients: clients.delivery.recipients,
              render: createRenderMessage(
                clients.delivery.reads,
                (cause, requestId) =>
                  logger.warn("lot title unavailable", {
                    ...(requestId === undefined
                      ? {}
                      : { request_id: requestId }),
                    error_category: "dependency_unavailable",
                    error:
                      cause instanceof Error ? cause.message : String(cause),
                  }),
              ),
              sender,
            }),
        }),
      close() {
        clients.close();
      },
    },
  };
};
