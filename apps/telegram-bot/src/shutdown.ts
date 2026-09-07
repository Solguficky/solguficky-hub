import type { Logger } from "./logging.js";

export type Stoppable = {
  isRunning(): boolean;
  stop(): Promise<void>;
};

export type Closable = {
  close(): void;
};

export type Shutdown = {
  readonly requested: boolean;
  request(signal: string): Promise<void>;
  complete(): Promise<void>;
};

export function createShutdown(options: {
  bot: Stoppable;
  resources: Closable;
  logger: Logger;
  timeoutMs: number;
  exit: (code: number) => void;
}): Shutdown {
  let requested = false;
  let inFlight: Promise<void> | undefined;

  const request = async (signal: string): Promise<void> => {
    const first = !requested;
    requested = true;
    if (first) {
      options.logger.info("shutdown signal received", {
        signal,
        timeout: options.timeoutMs,
      });
    }
    if (inFlight !== undefined) {
      return inFlight;
    }
    if (!options.bot.isRunning()) {
      return;
    }
    inFlight = settle();
    return inFlight;
  };

  const complete = async (): Promise<void> => {
    requested = true;
    if (inFlight === undefined) {
      inFlight = settle();
    }
    return inFlight;
  };

  async function settle(): Promise<void> {
    const force = setTimeout(() => {
      options.logger.error("graceful shutdown timed out, exiting");
      options.exit(1);
    }, options.timeoutMs);
    try {
      // Отказ самого стопа не отменяет остальную остановку: раньше он уносил с
      // собой и закрытие ресурсов, и запись в лог, а finally гасил сторожевой
      // таймер — процесс оставался с открытой HTTP/2-сессией и без диагностики.
      if (options.bot.isRunning()) {
        try {
          await options.bot.stop();
        } catch (cause) {
          options.logger.error("bot stop failed", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      options.resources.close();
      options.logger.info("graceful shutdown complete");
    } finally {
      clearTimeout(force);
    }
  }

  return {
    get requested() {
      return requested;
    },
    request,
    complete,
  };
}
