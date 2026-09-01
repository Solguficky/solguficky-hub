import { createDispatcher } from "./application/dispatcher.js";
import { createIdentityClient } from "./identity/client.js";
import { createLogger, serviceName } from "./logging.js";
import { createBot } from "./presentation/bot.js";

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

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("shutdown signal received", {
      signal,
      timeout: shutdownTimeoutMs,
    });
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out, exiting");
      process.exit(1);
    }, shutdownTimeoutMs);
    force.unref();
    await bot.stop();
    clearTimeout(force);
    logger.info("graceful shutdown complete");
  };

  process.once("SIGINT", () => {
    void stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stop("SIGTERM");
  });

  logger.info("telegram-bot starting", { service: serviceName });
  await bot.start({
    onStart: () => {
      logger.info("long polling started");
    },
  });
  return 0;
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
