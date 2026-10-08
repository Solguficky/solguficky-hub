import type { Api } from "grammy";
import type { Env, Loaded, ProcessConfig } from "./config.js";
import { readProcessConfig } from "./config.js";
import type { NatsDelivery } from "./delivery/index.js";
import { countFailure } from "./failures.js";
import { createLogger, type LogFields, type Logger } from "./logging.js";
import { type BotCommand, registerCommands } from "./menu-commands.js";
import { bindService } from "./service.js";
import { createShutdown, type Stoppable } from "./shutdown.js";
import type { Surface } from "./surface.js";
import {
  type Logs,
  startLogs,
  startMetrics,
  startTraces,
} from "./telemetry.js";
import type { Tracing } from "./tracing.js";

const shutdownTimeoutMs = 15_000;
const logsShutdownTimeoutMs = 5_000;

// Что общий процесс получает от поверхности. Остальное — конфигурация, логи,
// метрики, трейсы, второй вход из шины, остановка и long polling — у обеих
// поверхностей одно (ADR-064, пп. 18–19).
export type SurfaceProcess = {
  bot: Stoppable & {
    api: Pick<Api, "setMyCommands">;
    start(options: { onStart: () => void }): Promise<void>;
  };
  // Команды кнопки меню клиента этой поверхности.
  commands: readonly BotCommand[];
  // Второй вход: адресные факты Notifications. Поверхность связывает разбор
  // своих веток и отправителя с общей механикой доставки.
  startDelivery(options: {
    url: string;
    channel: string;
    logger: Logger;
  }): Promise<NatsDelivery>;
  // Клиенты сервисов поверхности: закрываются после потребителя шины.
  close(): void;
  // Поля записи о старте сверх общих.
  startFields?: LogFields;
};

export type SurfaceContext = {
  env: Env;
  config: ProcessConfig;
  logger: Logger;
  tracing: Tracing;
};

export type SurfaceDefinition = (
  context: SurfaceContext,
) => Loaded<SurfaceProcess>;

// Провайдер логов живёт дольше процесса поверхности: его закрывают последним,
// чтобы записи о самой остановке и об отказе конфигурации успели уйти по OTLP.
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

async function main(
  surface: Surface,
  define: SurfaceDefinition,
  env: Env,
): Promise<number> {
  const service = bindService(surface);
  logs = startLogs(service);
  const loaded = readProcessConfig(env, surface);
  // Уровень берётся из конфигурации, а при её отказе — по умолчанию: запись
  // об отказе должна уйти в любом случае.
  const logger = createLogger(loaded.ok ? loaded.config.logLevel : "info", {
    service,
    ...(logs.logger === undefined ? {} : { otlp: logs.logger }),
  });
  if (!loaded.ok) {
    logger.error(loaded.error);
    return 1;
  }
  const { config } = loaded;
  const metrics = startMetrics();
  const tracing = startTraces();
  const defined = define({ env, config, logger, tracing });
  if (!defined.ok) {
    logger.error(defined.error);
    await Promise.allSettled([tracing.shutdown(), metrics.shutdown()]);
    return 1;
  }
  const { bot } = defined.config;
  // Второй вход стартует до поллера, чтобы отказ шины остановил процесс сразу,
  // а не после того, как бот уже начал отвечать людям без канала уведомлений.
  const delivery = await defined.config.startDelivery({
    url: config.natsUrl,
    channel: service,
    logger,
  });
  let failed = false;
  const shutdown = createShutdown({
    bot,
    resources: {
      async close() {
        // Потребитель гасится первым: сообщение в обработке дописывается в
        // журнал, пока клиенты Identity и Telegram ещё открыты.
        await delivery.close();
        defined.config.close();
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
    countFailure("dependency_unavailable");
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
    logger.info(`${service} starting`, {
      service,
      telegram_environment: config.environment,
      ...defined.config.startFields,
    });
    // Меню пишется без ожидания: медленный или отказавший Telegram не должен
    // задерживать polling и остановку, а отказ registerCommands пишет в лог сам.
    void registerCommands(bot.api, defined.config.commands, logger);
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

// Процесс одной поверхности (ADR-064, п. 18): поверхность выбирает
// `src/main.ts` по `BOT_SURFACE`, а её определение отдаёт бот, команды, канал
// уведомлений и клиенты.
export function runProcess(
  surface: Surface,
  define: SurfaceDefinition,
  env: Env = process.env,
): void {
  main(surface, define, env)
    .finally(closeLogs)
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(
        `${JSON.stringify({ service: bindService(surface), level: "error", msg: "process failed", error: message })}\n`,
      );
      process.exit(1);
    });
}
