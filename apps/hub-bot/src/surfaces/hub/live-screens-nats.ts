import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { reportLiveStoreFailure } from "../../core/auction/live-failures.js";
import { natsConnectOptions } from "../../core/delivery/index.js";
import type { Logger } from "../../core/logging.js";
import type { LiveScreenStore } from "./presentation/live-screens.js";
import {
  createLiveScreenKvStore,
  type LiveScreensKv,
  liveScreensBucket,
} from "./presentation/live-screens-kv.js";

// Соединение хаба с bucket'ом открытых живых экранов (PER-815). Открывается
// лениво, на первой записи или чтении, и отдельно от канала уведомлений: отказ
// шины здесь значит «экраны живут как раньше», а не остановку процесса.
// Bucket объявляет платформа (ADR-050); нет его или нет шины — запись в лог и
// пустое хранилище, следующая операция пробует соединиться снова.
export type LiveScreensNats = {
  screens(kind: "console" | "floor"): LiveScreenStore;
  close(): Promise<void>;
};

export function createLiveScreensNats(options: {
  url: string;
  service: string;
  logger: Logger;
}): LiveScreensNats {
  const { logger } = options;
  let connection: Promise<{ nats: NatsConnection; kv: LiveScreensKv }> | null =
    null;
  let closed = false;

  const open = async () => {
    const nats = await connect({
      ...natsConnectOptions(options.url),
      name: `${options.service}-live-screens`,
      maxReconnectAttempts: -1,
    });
    try {
      const kv = await new Kvm(nats).open(liveScreensBucket(options.service));
      // open только привязывается: без проверки отсутствие bucket'а всплыло бы
      // на каждой записи, а не одной записью о соединении.
      await kv.status();
      return { nats, kv };
    } catch (cause) {
      await nats.close();
      throw cause;
    }
  };

  const kv = async (): Promise<LiveScreensKv | undefined> => {
    if (closed) return undefined;
    connection ??= open();
    try {
      return (await connection).kv;
    } catch (cause) {
      connection = null;
      reportLiveStoreFailure(logger, "connect", cause);
      return undefined;
    }
  };

  const store = (kind: "console" | "floor"): LiveScreenStore => {
    const lazy = async <T>(
      use: (store: LiveScreenStore) => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      const bound = await kv();
      if (bound === undefined) return fallback;
      return use(
        createLiveScreenKvStore({
          kv: bound,
          kind,
          onError: (operation, cause) =>
            reportLiveStoreFailure(logger, operation, cause),
        }),
      );
    };
    return {
      save: (target) => lazy((each) => each.save(target), undefined),
      remove: (chatId) => lazy((each) => each.remove(chatId), undefined),
      list: () => lazy((each) => each.list(), []),
    };
  };

  return {
    screens: store,
    async close() {
      closed = true;
      const pending = connection;
      connection = null;
      if (pending === null) return;
      const opened = await pending.catch(() => undefined);
      if (opened !== undefined && !opened.nats.isClosed()) {
        await opened.nats.drain().catch(() => opened.nats.close());
      }
    },
  };
}
