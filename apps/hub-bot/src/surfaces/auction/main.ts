import {
  createDeliverNotification,
  startNatsDelivery,
} from "@solguficky/telegram-delivery";
import { createBot } from "./bot.js";
import { createClients } from "./clients.js";
import { readConfig } from "./config.js";
import {
  createNotificationApi,
  createNotificationSender,
  createRenderMessage,
} from "./delivery/message.js";
import { decodeNotification } from "./delivery/notification.js";
import { createLogger, serviceName } from "./logging.js";
import { registerCommands } from "./menu-commands.js";
import { createShutdown } from "./shutdown.js";

const shutdownTimeoutMs = 15_000;

// Composition root бота аукциона (ADR-044): связывает порты пакета с клиентами
// Identity и Auction, выбирает поверхность `auction`, держит lifecycle своего
// поллера и второй вход — уведомления аукциона из шины (PER-328). Бот хаба — отдельный процесс со своим токеном: остановка одного
// поллера другой не трогает.
async function main(): Promise<number> {
  const loaded = readConfig(process.env);
  // Уровень берётся из конфигурации, а при её отказе — по умолчанию: запись
  // об отказе должна уйти в любом случае.
  const logger = createLogger(loaded.ok ? loaded.config.logLevel : "info");
  if (!loaded.ok) {
    logger.error(loaded.error);
    return 1;
  }
  const { config } = loaded;
  const clients = createClients({
    ...config,
    onNamesRefused: (cause, requestId) =>
      logger.warn("display names unavailable", {
        request_id: requestId,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const bot = createBot({
    token: config.token,
    environment: config.environment,
    presentation: config.presentation,
    ports: clients.ports,
    faq: config.faq,
    logger,
    timeZone: config.communityTimeZone,
  });
  // Второй вход: адресные факты Notifications. Он стартует до поллера, чтобы
  // отказ шины остановил процесс сразу, а не после того, как бот начал
  // отвечать людям без канала уведомлений.
  const delivery = await startNatsDelivery({
    url: config.natsUrl,
    channel: serviceName,
    logger,
    // Метрик у бота аукциона пока нет (AGENTS.md бота): счётчик сбоев не
    // ведётся, а записи в лог пакет пишет сам.
    countFailure: () => {},
    decode: decodeNotification,
    deliver: (journal) =>
      createDeliverNotification({
        journal,
        recipients: clients.delivery.recipients,
        render: createRenderMessage(
          clients.delivery.reads,
          (cause, requestId) =>
            logger.warn("lot title unavailable", {
              ...(requestId === undefined ? {} : { request_id: requestId }),
              error_category: "dependency_unavailable",
              error: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
        sender: createNotificationSender(
          createNotificationApi(config.token, config.environment),
        ),
      }),
  });
  let failed = false;
  const shutdown = createShutdown({
    bot,
    resources: {
      // Потребитель гасится первым: сообщение в обработке дописывается в
      // журнал, пока клиенты Identity и Auction ещё открыты.
      async close() {
        await delivery.close();
        clients.close();
      },
    },
    logger,
    timeoutMs: shutdownTimeoutMs,
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", () => {
    void shutdown.request("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown.request("SIGTERM");
  });
  // Поток сообщений кончился сам — durable или стрим удалены. Бот без канала
  // уведомлений молча терял бы их, поэтому процесс останавливается с отказом.
  // Недоступность NATS сюда не приводит: клиент переподключается без предела.
  delivery.done.catch((cause: unknown) => {
    failed = true;
    logger.error("notification delivery stopped", {
      error_category: "dependency_unavailable",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    void shutdown.request("delivery-stopped");
  });

  try {
    // Канал уведомлений мог отказать раньше старта поллера: такая остановка —
    // отказ, а не штатный выход.
    if (shutdown.requested) {
      return failed ? 1 : 0;
    }
    logger.info("auction-bot starting", {
      telegram_environment: config.environment,
    });
    // Запись меню поллер не задерживает: она не бросает, а отказ пишет сама.
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
