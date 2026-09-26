import type { Consumer } from "@nats-io/jetstream";
import { metrics } from "@opentelemetry/api";
import { countFailure, type FailureCategory } from "../failures.js";
import type { LogFields, Logger } from "../logging.js";
import {
  type DeliverNotification,
  type DeliveryDecision,
  type DeliveryPolicy,
  type DropReason,
  defaultDeliveryPolicy,
  retryDelayMs,
} from "./deliver.js";
import { decodeNotification } from "./notification.js";

// Subject адресного факта (docs/architecture/integration.md). Он же `operation`
// записи: у сообщения шины нет продуктового сценария, и `use_case` у него
// отсутствует, а не заполняется заглушкой (logging.md).
export const notificationSubject = "events.notifications.notification_created";
export const notificationStream = "NOTIFICATIONS_EVENTS";
export const notificationDurable = "telegram-bot-notifications-events";

// Бот держит у себя одно сообщение. Таймер ack_wait durable (30 с) идёт с
// выдачи, а обработка последовательная: сообщение, ждущее в буфере за зависшими
// отправками, истекло бы до начала своей попытки, шина выдала бы его снова, и
// счётчик доставок, по которому считаются попытки, рос бы без единой попытки.
const batchSize = 1;

const deliveries = metrics
  .getMeter("solguficky.notifications")
  .createCounter("telegram_bot.notification.deliveries", {
    description:
      "Notifications handled by the Telegram channel, grouped by outcome",
  });

// Сообщение шины в той мере, в какой его знает обработчик: JsMsg сюда подходит
// как есть, а тест обходится без сервера.
export type DeliveryMessage = {
  data: Uint8Array;
  info: { deliveryCount: number };
  ack(): void;
  nak(millis?: number): void;
  term(reason?: string): void;
};

export async function handleDeliveryMessage(
  message: DeliveryMessage,
  deps: {
    deliver: DeliverNotification;
    logger: Logger;
    policy?: DeliveryPolicy;
  },
): Promise<void> {
  const started = performance.now();
  const attempt = message.info.deliveryCount;
  const base: LogFields = { operation: notificationSubject, attempt };
  const decoded = decodeNotification(message.data);
  if (decoded.kind === "malformed") {
    message.term("malformed notification");
    record("malformed");
    countFailure("invariant");
    deps.logger.error("notification malformed", {
      ...base,
      result: "error",
      error_category: "invariant",
      error: decoded.error,
      duration_us: elapsedUs(started),
    });
    return;
  }
  const notification = decoded.notification;
  const fields: LogFields = {
    ...base,
    notification_id: notification.notificationId,
    notification_type:
      notification.content.kind === "unrendered"
        ? notification.content.type
        : notification.content.kind,
    identity_id: notification.recipientId,
    ...(notification.requestId === undefined
      ? {}
      : { request_id: notification.requestId }),
  };
  let decision: DeliveryDecision;
  try {
    decision = await deps.deliver(notification, attempt);
  } catch (cause) {
    // Дефект в самом юзкейсе, а не отказ соседа. Сообщение не теряется молча:
    // оно повторяется, пока не кончатся попытки, и каждый раз видно в логе.
    const policy = deps.policy ?? defaultDeliveryPolicy;
    if (attempt >= policy.maxAttempts) message.term("delivery failed");
    else message.nak(retryDelayMs(attempt, policy));
    record("failed");
    countFailure("unexpected");
    deps.logger.error("notification delivery failed", {
      ...fields,
      result: "error",
      error_category: "unexpected",
      error: errorText(cause),
      ...(cause instanceof Error && cause.stack !== undefined
        ? { stack: cause.stack }
        : {}),
      duration_us: elapsedUs(started),
    });
    return;
  }
  apply(message, decision);
  record(decision.kind === "ack" ? decision.outcome : decision.reason);
  write(deps.logger, decision, {
    ...fields,
    duration_us: elapsedUs(started),
  });
}

function apply(message: DeliveryMessage, decision: DeliveryDecision): void {
  switch (decision.kind) {
    case "ack":
      message.ack();
      return;
    case "retry":
      message.nak(decision.delayMs);
      return;
    case "drop":
      message.term(decision.reason);
      return;
    default:
      unreachable(decision);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled delivery decision: ${JSON.stringify(value)}`);
}

function write(
  logger: Logger,
  decision: DeliveryDecision,
  fields: LogFields,
): void {
  if (decision.kind === "ack") {
    if (decision.outcome !== "delivered") {
      logger.debug("notification already settled", {
        ...fields,
        result: "ok",
      });
      return;
    }
    if (decision.journalMissed === true) {
      logger.warn("notification delivered, journal not updated", {
        ...fields,
        result: "ok",
        error: "journal_unavailable",
      });
      return;
    }
    logger.info("notification delivered", { ...fields, result: "ok" });
    return;
  }
  if (decision.kind === "retry") {
    countFailure("dependency_unavailable");
    logger.warn("notification delivery retried", {
      ...fields,
      result: "error",
      error_category: "dependency_unavailable",
      error: decision.reason,
      retry_delay_ms: decision.delayMs,
      ...causeField(decision.cause),
    });
    return;
  }
  const category = dropCategory[decision.reason];
  countFailure(category);
  const entry: LogFields = {
    ...fields,
    result: "error",
    error_category: category,
    error: decision.reason,
    ...causeField(decision.cause),
  };
  // Ожидаемые отказы получателя — нормальная жизнь канала; нарушение контракта
  // и исчерпанные попытки — то, что оператор обязан увидеть.
  if (expectedDrops.has(decision.reason)) {
    logger.warn("notification dropped", entry);
  } else {
    logger.error("notification dropped", entry);
  }
}

const dropCategory: Record<DropReason, FailureCategory> = {
  expired: "timeout",
  unrendered_type: "invariant",
  recipient_not_found: "visibility",
  recipient_blocked: "authorization",
  recipient_rejected: "invariant",
  bot_blocked: "authorization",
  telegram_rejected: "invariant",
  attempts_exhausted: "dependency_unavailable",
};

const expectedDrops: ReadonlySet<DropReason> = new Set([
  "expired",
  "unrendered_type",
  "recipient_not_found",
  "recipient_blocked",
  "bot_blocked",
]);

function causeField(cause: unknown): LogFields {
  return cause === undefined ? {} : { reply_error: errorText(cause) };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function record(outcome: string): void {
  deliveries.add(1, { service: "telegram-bot", outcome });
}

function elapsedUs(started: number): number {
  return Math.round((performance.now() - started) * 1_000);
}

export type NotificationDelivery = {
  // Отказывает, когда поток сообщений кончился сам: durable или стрим удалены.
  // Недоступность сервера потока не кончает — клиент переподключается и
  // продолжает. Штатная остановка идёт через stop и отказом не считается.
  readonly done: Promise<void>;
  stop(): Promise<void>;
};

export async function startNotificationDelivery(options: {
  consumer: Pick<Consumer, "consume">;
  deliver: DeliverNotification;
  logger: Logger;
}): Promise<NotificationDelivery> {
  // Без abort_on_missing_resource клиент молча ждал бы возврата удалённого
  // durable, и бот жил бы без канала уведомлений, ничего о том не сказав.
  const messages = await options.consumer.consume({
    max_messages: batchSize,
    abort_on_missing_resource: true,
  });
  let stopping = false;
  const done = (async () => {
    // Обработка последовательная: Telegram ограничивает частоту отправки, и
    // параллельная рассылка упиралась бы в 429 раньше, чем ускорялась.
    for await (const message of messages) {
      await handleDeliveryMessage(message, options);
    }
    if (!stopping) {
      throw new Error("notification consumer stopped unexpectedly");
    }
  })();
  return {
    done,
    async stop() {
      stopping = true;
      await messages.close();
      await done.catch(() => {});
    },
  };
}
