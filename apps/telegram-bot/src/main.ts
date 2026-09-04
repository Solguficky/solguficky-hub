import { createDispatcher } from "./application/dispatcher.js";
import { createIdentityClient } from "./identity/client.js";
import { createLogger, serviceName } from "./logging.js";
import { createBot } from "./presentation/bot.js";
import { createShutdown } from "./shutdown.js";

const shutdownTimeoutMs = 15_000;

function readEnv(name: string): string | undefined {
  return process.env[name];
}

async function main(): Promise<number> {
  const logLevel = readEnv("TELEGRAM_BOT_LOG_LEVEL") ?? "info";
  const logger = createLogger(logLevel);
  const token = readEnv("TELEGRAM_BOT_TOKEN");
  if (token === undefined || token === "") {
    logger.error("TELEGRAM_BOT_TOKEN is not set");
    return 1;
  }
  const identityUrl = readEnv("IDENTITY_GRPC_URL") ?? "http://127.0.0.1:50051";
  const dispatcher = createDispatcher();
  const identity = createIdentityClient(identityUrl);
  const bot = createBot({ token, dispatcher, identity, logger });
  const shutdown = createShutdown({
    bot,
    resources: identity,
    logger,
    timeoutMs: shutdownTimeoutMs,
    exit: (code) => {
      process.exit(code);
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
    logger.info("telegram-bot starting", { service: serviceName });
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
