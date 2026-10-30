import { type KV, Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { natsConnectOptions } from "../delivery/index.js";
import type { Logger } from "../logging.js";
import { reportLiveStoreFailure } from "./live-failures.js";

// Соединение процесса с bucket'ом открытых живых экранов (PER-815, PER-826):
// у хаба в нём пульт ведущего, «Ставки зала» и трансляция хода торгов, у бота
// аукциона — трансляция. Открывается лениво, на первой записи или чтении, и
// отдельно от канала уведомлений: отказ шины здесь значит «экраны живут как
// раньше», а не остановку процесса. Bucket объявляет платформа (ADR-050); нет
// его или нет шины — запись в лог и пустое хранилище, следующая операция
// пробует соединиться снова.

export const liveScreensBucket = (service: string): string =>
  `${service}-live-screens`;

export type LiveScreensKv = Pick<KV, "get" | "put" | "delete" | "keys">;

export type LiveKvLink = {
  /** Привязанный bucket; нет — соединиться не вышло, отказ уже записан. */
  kv(): Promise<LiveScreensKv | undefined>;
  close(): Promise<void>;
};

export function createLiveKvLink(options: {
  url: string;
  service: string;
  logger: Logger;
}): LiveKvLink {
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

  return {
    async kv() {
      if (closed) return undefined;
      connection ??= open();
      try {
        return (await connection).kv;
      } catch (cause) {
        connection = null;
        reportLiveStoreFailure(logger, "connect", cause);
        return undefined;
      }
    },
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
