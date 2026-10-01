import { createBot } from "./bot.js";
import { createClients } from "./clients.js";
import { readConfig } from "./config.js";
import { createLogger, serviceName } from "./logging.js";
import { createShutdown } from "./shutdown.js";

const shutdownTimeoutMs = 15_000;

// Composition root бота аукциона (ADR-044): связывает порты пакета с клиентами
// Identity и Auction, выбирает поверхность `auction` и держит lifecycle своего
// поллера. Бот хаба — отдельный процесс со своим токеном: остановка одного
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
  const clients = createClients(config);
  const bot = createBot({
    token: config.token,
    environment: config.environment,
    ports: clients.ports,
    logger,
  });
  const shutdown = createShutdown({
    bot,
    resources: { close: () => clients.close() },
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

  try {
    if (shutdown.requested) {
      return 0;
    }
    logger.info("auction-bot starting", {
      telegram_environment: config.environment,
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
