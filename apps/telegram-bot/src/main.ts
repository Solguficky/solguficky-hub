import { createDispatcher } from "./application/dispatcher.js";
import { parseTimeZone } from "./community-time.js";
import { createIdentityClient } from "./identity/client.js";
import { createLogger, serviceName } from "./logging.js";
import { createMeetupsClient } from "./meetups/client.js";
import { createNotificationsClient } from "./notifications/client.js";
import { createBot, parseTelegramEnvironment } from "./presentation/bot.js";
import { createShutdown } from "./shutdown.js";
import { type Logs, startLogs, startMetrics } from "./telemetry.js";

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
  const logLevel = readEnv("TELEGRAM_BOT_LOG_LEVEL") ?? "info";
  const logger = createLogger(logLevel, logs.logger);
  const token = readEnv("TELEGRAM_BOT_TOKEN");
  if (token === undefined || token === "") {
    logger.error("TELEGRAM_BOT_TOKEN is not set");
    return 1;
  }
  const environment = parseTelegramEnvironment(
    readEnv("TELEGRAM_BOT_ENVIRONMENT"),
  );
  if (environment === undefined) {
    logger.error("TELEGRAM_BOT_ENVIRONMENT must be prod or test");
    return 1;
  }
  const identityUrl = readEnv("IDENTITY_GRPC_URL") ?? "http://127.0.0.1:50051";
  const meetupsUrl = readEnv("MEETUPS_GRPC_URL") ?? "http://127.0.0.1:50052";
  const notificationsUrl =
    readEnv("NOTIFICATIONS_GRPC_URL") ?? "http://127.0.0.1:50053";
  const presentationRaw = readEnv("TELEGRAM_BOT_PRESENTATION") ?? "rich";
  if (presentationRaw !== "rich" && presentationRaw !== "plain") {
    logger.error("TELEGRAM_BOT_PRESENTATION must be rich or plain");
    return 1;
  }
  // Пояс проверяется на старте, как у Meetups: без него карточка не может
  // показать назначенный момент публикации, а опечатка в имени пояса иначе
  // всплыла бы только на первом черновике с назначенной публикацией.
  const communityTimeZone = parseTimeZone(
    readEnv("TELEGRAM_BOT_COMMUNITY_TIME_ZONE"),
  );
  if (communityTimeZone === undefined) {
    logger.error(
      "TELEGRAM_BOT_COMMUNITY_TIME_ZONE must be an IANA time zone name",
    );
    return 1;
  }
  const meetups = createMeetupsClient(meetupsUrl, communityTimeZone);
  const notifications = createNotificationsClient(notificationsUrl);
  const metrics = startMetrics();
  const dispatcher = createDispatcher(meetups, notifications);
  const identity = createIdentityClient(identityUrl);
  const bot = createBot({
    token,
    dispatcher,
    identity,
    logger,
    presentation: presentationRaw,
    environment,
  });
  const shutdown = createShutdown({
    bot,
    resources: {
      async close() {
        identity.close();
        meetups.close();
        notifications.close();
        await metrics.shutdown();
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

  try {
    if (shutdown.requested) {
      return 0;
    }
    logger.info("telegram-bot starting", {
      service: serviceName,
      telegram_environment: environment,
    });
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
    return 0;
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
