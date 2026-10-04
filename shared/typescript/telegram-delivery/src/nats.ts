import { jetstream } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { watchBusStatus } from "./bus-status.js";
import {
  type NotificationDelivery,
  notificationDurable,
  notificationStream,
  startNotificationDelivery,
} from "./consumer.js";
import type { DeliverNotification, DeliveryPolicy } from "./deliver.js";
import { createKvJournal } from "./kv-journal.js";
import type { ChannelContent, DecodeNotification } from "./notification.js";
import {
  type CountFailure,
  type DeliveryLogger,
  deliveryOutcomes,
} from "./observe.js";
import type { DeliveryJournal } from "./port.js";

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

// Журнал попыток канала (ADR-052, имена — ADR-044).
export function deliveryJournalBucket(channel: string): string {
  return `${channel}-deliveries`;
}

export type NatsDelivery = NotificationDelivery & {
  close(): Promise<void>;
};

// Durable и bucket объявляет платформа (ADR-050, ADR-052): бот к ним только
// привязывается и без них не стартует, а не заводит их со своими настройками —
// иначе настройки хранения разошлись бы с таблицей топологии молча.
//
// `channel` — имя канала, оно же имя сервиса бота: из него выводятся durable
// `<channel>-notifications-events`, bucket журнала `<channel>-deliveries` и
// счётчик `<channel с подчёркиванием>.notification.deliveries`.
export async function startNatsDelivery<C extends ChannelContent>(options: {
  url: string;
  channel: string;
  logger: DeliveryLogger;
  countFailure: CountFailure;
  decode: DecodeNotification<C>;
  deliver: (journal: DeliveryJournal) => DeliverNotification<C>;
  policy?: DeliveryPolicy;
}): Promise<NatsDelivery> {
  // Переподключение без предела: рестарт NATS не должен останавливать бота,
  // который продолжает отвечать людям, а доставка сама возобновится с позиции
  // durable.
  const nats: NatsConnection = await connect({
    ...natsConnectOptions(options.url),
    name: options.channel,
    maxReconnectAttempts: -1,
  });
  // Итератор кончается с закрытием соединения, поэтому наблюдатель живёт ровно
  // столько, сколько клиент, и отдельной остановки не требует. Отказ самой
  // записи не должен ронять процесс необработанным отказом промиса: бот без
  // этой записи продолжает и отвечать людям, и доставлять.
  void watchBusStatus(nats.status(), options).catch(() => {});
  try {
    const consumer = await jetstream(nats).consumers.get(
      notificationStream,
      notificationDurable(options.channel),
    );
    const store = await new Kvm(nats).open(
      deliveryJournalBucket(options.channel),
    );
    // open только привязывается и существования bucket не проверяет: без этой
    // проверки его отсутствие всплыло бы повтором каждой доставки, а не отказом
    // старта.
    await store.status();
    const delivery = await startNotificationDelivery({
      consumer,
      decode: options.decode,
      deliver: options.deliver(createKvJournal(store)),
      logger: options.logger,
      countFailure: options.countFailure,
      recordOutcome: deliveryOutcomes({
        counter: `${options.channel.replaceAll("-", "_")}.notification.deliveries`,
        service: options.channel,
      }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
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
