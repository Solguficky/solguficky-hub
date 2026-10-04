import { createDispatcher } from "./application/dispatcher.js";
import { communityDay, parseTimeZone } from "./community-time.js";
import { createDeliverNotification } from "./delivery/deliver.js";
import { startNatsDelivery } from "./delivery/nats.js";
import { createIdentityClient } from "./identity/client.js";
import { createLogger, serviceName } from "./logging.js";
import { createMeetupsClient } from "./meetups/client.js";
import { createNotificationsClient } from "./notifications/client.js";
import { createBot, parseTelegramEnvironment } from "./presentation/bot.js";
import { registerCommands } from "./presentation/commands.js";
import {
  createNotificationApi,
  createNotificationSender,
} from "./presentation/notification-message.js";
import { isTelegramBotUsername } from "./presentation/source-deep-link.js";
import { createShutdown } from "./shutdown.js";
import {
  type Logs,
  startLogs,
  startMetrics,
  startTraces,
} from "./telemetry.js";

const shutdownTimeoutMs = 15_000;
const logsShutdownTimeoutMs = 5_000;

function readEnv(name: string): string | undefined {
  return process.env[name];
}

// Провайдер логов живёт дольше main: его закрывают последним, чтобы записи о
// самой остановке и об отказе конфигурации успели уйти по OTLP. Создаётся он
// внутри main, чтобы отказ его настройки дошёл до общего .catch.
let logs: Logs = { shutdown: async () => {} };

// Недоступный dashboard не должен держать процесс после остановки: экспорт
// ждал бы своего таймаута уже после снятого сторожевого таймера.
function closeLogs(): Promise<void> {
  return Promise.race([
    logs.shutdown(),
    new Promise<void>((resolve) => {
      setTimeout(resolve, logsShutdownTimeoutMs).unref();
    }),
  ]).catch(() => {});
}

async function main(): Promise<number> {
  logs = startLogs(serviceName);
  const logLevel = readEnv("HUB_BOT_LOG_LEVEL") ?? "info";
  const logger = createLogger(logLevel, logs.logger);
  const token = readEnv("HUB_BOT_TOKEN");
  if (token === undefined || token === "") {
    logger.error("HUB_BOT_TOKEN is not set");
    return 1;
  }
  // Токен вызывающего (ADR-056) проверяется на старте: без него каждый вызов
  // сервиса получил бы UNAUTHENTICATED, и дефект развёртывания всплыл бы на
  // первом человеке, а не в отказе процесса. В запись идёт только имя.
  // Пробелы по краям Headers срезает молча: такой токен ушёл бы искажённым,
  // и вызывающий снова получил бы отказ на каждом вызове при зелёном старте.
  const serviceToken = readEnv("HUB_BOT_SERVICE_TOKEN");
  if (serviceToken === undefined || serviceToken.trim() === "") {
    logger.error("HUB_BOT_SERVICE_TOKEN is not set");
    return 1;
  }
  if (serviceToken !== serviceToken.trim()) {
    logger.error("HUB_BOT_SERVICE_TOKEN has surrounding whitespace");
    return 1;
  }
  const environment = parseTelegramEnvironment(readEnv("HUB_BOT_ENVIRONMENT"));
  if (environment === undefined) {
    logger.error("HUB_BOT_ENVIRONMENT must be prod or test");
    return 1;
  }
  const identityUrl = readEnv("IDENTITY_GRPC_URL") ?? "http://127.0.0.1:50051";
  const meetupsUrl = readEnv("MEETUPS_GRPC_URL") ?? "http://127.0.0.1:50052";
  const notificationsUrl =
    readEnv("NOTIFICATIONS_GRPC_URL") ?? "http://127.0.0.1:50053";
  const natsUrl = readEnv("HUB_BOT_NATS_URL") ?? "nats://127.0.0.1:4222";
  const presentationRaw = readEnv("HUB_BOT_PRESENTATION") ?? "rich";
  if (presentationRaw !== "rich" && presentationRaw !== "plain") {
    logger.error("HUB_BOT_PRESENTATION must be rich or plain");
    return 1;
  }
  // Пояс проверяется на старте, как у Meetups: без него карточка не может
  // показать назначенный момент публикации, а опечатка в имени пояса иначе
  // всплыла бы только на первом черновике с назначенной публикацией.
  const communityTimeZone = parseTimeZone(
    readEnv("HUB_BOT_COMMUNITY_TIME_ZONE"),
  );
  if (communityTimeZone === undefined) {
    logger.error("HUB_BOT_COMMUNITY_TIME_ZONE must be an IANA time zone name");
    return 1;
  }
  // Имя бота аукциона нужно только экрану каналов прихода (PER-441). Опечатка
  // дала бы администратору ссылку в чужой или несуществующий бот, поэтому
  // форма проверяется на старте, а не молча.
  const auctionBotUsername =
    readEnv("HUB_BOT_AUCTION_BOT_USERNAME") || undefined;
  if (
    auctionBotUsername !== undefined &&
    !isTelegramBotUsername(auctionBotUsername)
  ) {
    logger.error(
      "HUB_BOT_AUCTION_BOT_USERNAME must be a Telegram bot username",
    );
    return 1;
  }
  const metrics = startMetrics();
  const tracing = startTraces();
  const meetups = createMeetupsClient(meetupsUrl, {
    communityTimeZone,
    tracing,
    serviceToken,
  });
  const notifications = createNotificationsClient(notificationsUrl, {
    tracing,
    serviceToken,
  });
  // День сообщества считается тем же поясом, что и у Meetups: иначе граница
  // «прошедшей» даты разойдётся с той, по которой сходка уходит в архив.
  const today = () => communityDay(new Date(), communityTimeZone);
  const dispatcher = createDispatcher(meetups, notifications, today);
  const identity = createIdentityClient(identityUrl, {
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
    presentation: presentationRaw,
    environment,
    today,
    ...(auctionBotUsername === undefined ? {} : { auctionBotUsername }),
  });
  // Второй вход компонента: адресные факты Notifications из шины. Он стартует
  // до поллера, чтобы отказ шины остановил процесс сразу, а не после того, как
  // бот уже начал отвечать людям без канала уведомлений.
  const sender = createNotificationSender(
    createNotificationApi(token, environment),
  );
  const delivery = await startNatsDelivery({
    url: natsUrl,
    logger,
    deliver: (journal) =>
      createDeliverNotification({ journal, recipients: identity, sender }),
  });
  let failed = false;
  const shutdown = createShutdown({
    bot,
    resources: {
      async close() {
        // Потребитель гасится первым: сообщение в обработке дописывается в
        // журнал, пока клиенты Identity и Telegram ещё открыты.
        await delivery.close();
        identity.close();
        meetups.close();
        notifications.close();
        // Трейсы и метрики закрываются последними и независимо: недоступный
        // collector роняет сброс одного сигнала, но не отменяет сброс другого
        // и не делает остановку неуспешной. Update, который ещё обрабатывается,
        // своих последних спанов не отправит: bot.stop его не ждёт.
        const closed = await Promise.allSettled([
          tracing.shutdown(),
          metrics.shutdown(),
        ]);
        for (const [index, result] of closed.entries()) {
          if (result.status === "rejected") {
            logger.warn("telemetry shutdown failed", {
              operation: index === 0 ? "traces" : "metrics",
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            });
          }
        }
      },
    },
    logger,
    timeoutMs: shutdownTimeoutMs,
    // Сторожевой выход идёт мимо finally у main, поэтому буфер логов
    // сбрасывается здесь: иначе запись о зависшей остановке не дойдёт.
    exit: (code) => {
      void closeLogs().finally(() => process.exit(code));
    },
  });

  process.on("SIGINT", () => {
    void shutdown.request("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown.request("SIGTERM");
  });
  // Поток сообщений кончился сам — durable или стрим удалены. Бот без канала
  // уведомлений молча терял бы их, поэтому процесс останавливается с отказом, и
  // оркестратор это видит. Недоступность NATS сюда не приводит: клиент
  // переподключается без предела.
  delivery.done.catch((cause: unknown) => {
    failed = true;
    logger.error("notification delivery stopped", {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    void shutdown.request("delivery-stopped");
  });

  try {
    if (shutdown.requested) {
      return 0;
    }
    logger.info(`${serviceName} starting`, {
      service: serviceName,
      telegram_environment: environment,
      // Без имени бота аукциона экран каналов отдаёт только ссылку хаба: по
      // записи старта видно, задумано это или настройка потерялась.
      auction_bot_links: auctionBotUsername !== undefined,
    });
    // Меню пишется без ожидания: медленный или отказавший Telegram не должен
    // задерживать polling и остановку, а отказ registerCommands пишет в лог сам.
    void registerCommands(bot.api, logger);
    try {
      await bot.start({
        onStart: () => {
          if (shutdown.requested) {
            void shutdown.request("startup-aborted");
            return;
          }
          logger.info("long polling started");
        },
      });
    } catch (cause) {
      if (!shutdown.requested) {
        throw cause;
      }
    }
    return failed ? 1 : 0;
  } finally {
    await shutdown.complete();
  }
}

main()
  .finally(closeLogs)
  .then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  })
  .catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(
      `${JSON.stringify({ service: serviceName, level: "error", msg: "process failed", error: message })}\n`,
    );
    process.exit(1);
  });
