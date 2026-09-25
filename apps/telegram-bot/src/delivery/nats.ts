import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { Logger } from "../logging.js";
import { serviceName } from "../logging.js";
import {
  type NotificationDelivery,
  notificationDurable,
  notificationStream,
  startNotificationDelivery,
} from "./consumer.js";
import type { DeliverNotification } from "./deliver.js";
import { createKvJournal, deliveryJournalBucket } from "./kv-journal.js";

export type NatsConnectOptions = {
  servers: string;
  user?: string;
  pass?: string;
};

// Aspire отдаёт строку подключения URL-ом с учётными данными
// (`nats://user:pass@host:port`), а клиент nats.js их из адреса сервера не
// берёт: без разбора бот ходил бы на сервер анонимно и получал отказ.
export function natsConnectOptions(url: string): NatsConnectOptions {
  const parsed = new URL(url);
  const options: NatsConnectOptions = {
    servers: `${parsed.hostname}:${parsed.port === "" ? "4222" : parsed.port}`,
  };
  if (parsed.username !== "") {
    options.user = decodeURIComponent(parsed.username);
  }
  if (parsed.password !== "") {
    options.pass = decodeURIComponent(parsed.password);
  }
  return options;
}

export type NatsDelivery = NotificationDelivery & {
  close(): Promise<void>;
};

// Durable и bucket объявляет платформа (ADR-050): бот к ним только
// привязывается и без них не стартует, а не заводит их со своими настройками.
export async function startNatsDelivery(options: {
  url: string;
  logger: Logger;
  deliver: (journal: ReturnType<typeof createKvJournal>) => DeliverNotification;
}): Promise<NatsDelivery> {
  // Переподключение без предела: рестарт NATS не должен останавливать бота,
  // который продолжает отвечать людям, а доставка сама возобновится с позиции
  // durable.
  const nats: NatsConnection = await connect({
    ...natsConnectOptions(options.url),
    name: serviceName,
    maxReconnectAttempts: -1,
  });
  try {
    const consumer = await jetstream(nats).consumers.get(
      notificationStream,
      notificationDurable,
    );
    const store = await new Kvm(nats).open(deliveryJournalBucket);
    // open только привязывается и существования bucket не проверяет: без этой
    // проверки его отсутствие всплыло бы повтором каждой доставки, а не отказом
    // старта.
    await store.status();
    const delivery = await startNotificationDelivery({
      consumer,
      deliver: options.deliver(createKvJournal(store)),
      logger: options.logger,
    });
    return {
      done: delivery.done,
      stop: () => delivery.stop(),
      // Не бросает: закрытие идёт внутри общей остановки, и отказ здесь оборвал
      // бы закрытие остальных клиентов и сброс логов.
      async close() {
        await delivery.stop();
        if (!nats.isClosed()) {
          await nats.drain().catch(() => nats.close());
        }
      },
    };
  } catch (cause) {
    await nats.close();
    throw cause;
  }
}
