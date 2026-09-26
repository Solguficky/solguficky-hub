import { create, toBinary } from "@bufbuild/protobuf";
import {
  AckPolicy,
  type Consumer,
  DeliverPolicy,
  type JetStreamClient,
  type JsMsg,
  jetstream,
  jetstreamManager,
} from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect, type NatsConnection, nanos } from "@nats-io/transport-node";
import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NotificationSchema } from "../../gen/notifications/v1/notifications_pb.js";
import type { TelegramRecipientResolver } from "../identity/port.js";
import type { Logger } from "../logging.js";
import {
  handleDeliveryMessage,
  notificationStream,
  notificationSubject,
  startNotificationDelivery,
} from "./consumer.js";
import { createDeliverNotification, type DeliveryPolicy } from "./deliver.js";
import { createKvJournal } from "./kv-journal.js";
import type {
  DeliveryJournal,
  NotificationSender,
  SendResult,
} from "./port.js";

// Без Docker набор пропускается локально, но не в CI: там пропуск выглядел бы
// как проверенное потребление (то же правило, что у Notifications).
const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);
const runs = dockerAvailable || process.env["CI"] !== undefined;

// Короткий ack_wait вместо 30 с топологии: потерянный ack возвращается шиной
// за секунды, и сценарий рестарта укладывается в тест. Остальная конфигурация
// повторяет JetStreamTopology AppHost (docs/architecture/integration.md).
const ackWaitMs = 1_500;
const policy: DeliveryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 200,
  maxDelayMs: 200,
};
const recipientId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const recipients: TelegramRecipientResolver = {
  resolveTelegramUserId: async () => ({
    kind: "resolved",
    telegramUserId: 42n,
  }),
};

function scriptedSender(...results: SendResult[]) {
  const send = vi.fn(
    async (): Promise<SendResult> => results.shift() ?? { kind: "sent" },
  );
  return { send } satisfies NotificationSender;
}

function fact(id: number): { id: string; data: Uint8Array } {
  const notificationId = `0198f2a4-7c1e-7d3a-9b21-${String(id).padStart(12, "0")}`;
  const data = toBinary(
    NotificationSchema,
    create(NotificationSchema, {
      notificationId,
      recipientId,
      createdAt: "2026-09-26T10:00:00Z",
      type: {
        case: "meetupPublished",
        value: {
          meetup: {
            id: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cf",
            title: "Настолки у Лёши",
            schedule: { form: { case: "noDate", value: {} } },
          },
        },
      },
    }),
  );
  return { id: notificationId, data };
}

async function waitFor(check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not reached in time");
}

describe.skipIf(!runs)("notification delivery over JetStream", () => {
  let container: StartedTestContainer;
  let nats: NatsConnection;
  let js: JetStreamClient;
  let consumer: Consumer;
  let journal: DeliveryJournal;
  let run = 0;

  beforeAll(async () => {
    container = await new GenericContainer("nats:2.10-alpine")
      .withCommand(["-js"])
      .withExposedPorts(4222)
      .withWaitStrategy(Wait.forLogMessage("Server is ready"))
      .start();
    nats = await connect({
      servers: `${container.getHost()}:${container.getMappedPort(4222)}`,
    });
    js = jetstream(nats);
  }, 120_000);

  afterAll(async () => {
    await nats?.close();
    await container?.stop();
  });

  // Свой стрим, durable и bucket на тест: позиция durable живёт на сервере, и
  // сообщение одного теста иначе подтверждал бы другой.
  beforeEach(async () => {
    run += 1;
    const jsm = await jetstreamManager(nats);
    await jsm.streams.delete(notificationStream).catch(() => false);
    await jsm.streams.add({
      name: notificationStream,
      subjects: ["events.notifications.>"],
    });
    const durable = `telegram-bot-notifications-events-${run}`;
    await jsm.consumers.add(notificationStream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: "events.notifications.>",
      ack_wait: nanos(ackWaitMs),
    });
    consumer = await js.consumers.get(notificationStream, durable);
    journal = createKvJournal(
      await new Kvm(nats).create(`telegram-bot-deliveries-${run}`),
    );
  });

  async function publish(...facts: { id: string; data: Uint8Array }[]) {
    for (const item of facts) {
      await js.publish(notificationSubject, item.data, { msgID: item.id });
    }
  }

  async function settled(): Promise<boolean> {
    const info = await consumer.info();
    return info.num_pending === 0 && info.num_ack_pending === 0;
  }

  function deliverWith(sender: NotificationSender) {
    return createDeliverNotification({ journal, recipients, sender, policy });
  }

  // Критерий приёмки: рестарт не отправляет уже доставленное второй раз.
  // Первый процесс отправил и отметил, но умер до ack; шина выдаёт сообщение
  // снова, и второй процесс видит отметку в журнале.
  it("does not send again after a restart lost the acknowledgement", async () => {
    await publish(fact(1));
    const before = scriptedSender();
    const first: JsMsg | null = await consumer.next({ expires: 5_000 });
    if (first === null) throw new Error("the published fact did not arrive");
    // Процесс умер после отметки в журнале и до ack: подтверждение не ушло.
    const lostAck = {
      data: first.data,
      info: { deliveryCount: first.info.deliveryCount },
      ack() {},
      nak() {},
      term() {},
    };
    await handleDeliveryMessage(lostAck, {
      deliver: deliverWith(before),
      logger: silent,
    });
    expect(before.send).toHaveBeenCalledOnce();

    const after = scriptedSender();
    const restarted = await startNotificationDelivery({
      consumer,
      deliver: deliverWith(after),
      logger: silent,
    });
    await waitFor(settled);
    await restarted.stop();
    expect(after.send).not.toHaveBeenCalled();
  }, 30_000);

  // Критерий приёмки: рестарт не теряет накопленное.
  it("delivers what accumulated before the start exactly once", async () => {
    await publish(fact(1), fact(2), fact(3));
    const sender = scriptedSender();
    const delivery = await startNotificationDelivery({
      consumer,
      deliver: deliverWith(sender),
      logger: silent,
    });
    await waitFor(settled);
    await delivery.stop();
    expect(sender.send).toHaveBeenCalledTimes(3);

    const again = scriptedSender();
    const restarted = await startNotificationDelivery({
      consumer,
      deliver: deliverWith(again),
      logger: silent,
    });
    await new Promise((resolve) => setTimeout(resolve, ackWaitMs + 500));
    await restarted.stop();
    expect(again.send).not.toHaveBeenCalled();
  }, 30_000);

  // Критерий приёмки: заблокировавший бота не вызывает бесконечных повторов.
  it("does not redeliver to a recipient who blocked the bot", async () => {
    await publish(fact(1));
    const sender = scriptedSender({
      kind: "bot-blocked",
      cause: new Error("403"),
    });
    const delivery = await startNotificationDelivery({
      consumer,
      deliver: deliverWith(sender),
      logger: silent,
    });
    await waitFor(settled);
    await new Promise((resolve) => setTimeout(resolve, ackWaitMs + 500));
    await delivery.stop();
    expect(sender.send).toHaveBeenCalledOnce();
    await expect(journal.read(fact(1).id)).resolves.toMatchObject({
      record: { state: "dropped", reason: "bot_blocked" },
    });
  }, 30_000);

  // Критерий приёмки: временный отказ Telegram приводит к повтору.
  it("retries a temporary Telegram failure until it goes through", async () => {
    await publish(fact(1));
    const sender = scriptedSender({
      kind: "unavailable",
      cause: new Error("502"),
    });
    const delivery = await startNotificationDelivery({
      consumer,
      deliver: deliverWith(sender),
      logger: silent,
    });
    await waitFor(async () => sender.send.mock.calls.length === 2);
    await waitFor(settled);
    await delivery.stop();
    await expect(journal.read(fact(1).id)).resolves.toMatchObject({
      record: { state: "delivered", attempts: 2 },
    });
  }, 30_000);
});
