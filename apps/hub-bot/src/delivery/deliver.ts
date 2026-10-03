import type { TelegramRecipientResolver } from "../identity/port.js";
import { rpcMeta } from "../rpc-metadata.js";
import type { DeliveryNotification } from "./notification.js";
import type {
  DeliveryJournal,
  DeliveryRecord,
  NotificationSender,
} from "./port.js";

export type DropReason =
  | "expired"
  | "unrendered_type"
  | "recipient_not_found"
  | "recipient_blocked"
  | "recipient_rejected"
  | "bot_blocked"
  | "telegram_rejected"
  | "attempts_exhausted";

export type RetryReason =
  | "journal_unavailable"
  | "identity_unavailable"
  | "telegram_unavailable"
  | "telegram_rate_limited";

// Решение по одному сообщению шины. Юзкейс не знает JetStream: «подтвердить»,
// «повторить с задержкой» и «снять без повторов» переводит в ack, nak и term
// адаптер потребителя.
export type DeliveryDecision =
  | {
      kind: "ack";
      outcome: "delivered" | "already_delivered" | "already_dropped";
      // Доставлено, но отметка не легла: повтор этого сообщения шиной
      // отправил бы его второй раз. Это видимый дефект журнала, а не отказ.
      journalMissed?: boolean;
    }
  | { kind: "retry"; delayMs: number; reason: RetryReason; cause?: unknown }
  | { kind: "drop"; reason: DropReason; cause?: unknown };

export type DeliveryPolicy = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

// Двадцать попыток с удвоением от 5 с до потолка в 10 мин покрывают около двух
// с половиной часов недоступности Telegram или Identity. Дольше факт о новой
// сходке теряет смысл, а бесконечный повтор держал бы место в очереди durable.
export const defaultDeliveryPolicy: DeliveryPolicy = {
  maxAttempts: 20,
  baseDelayMs: 5_000,
  maxDelayMs: 600_000,
};

export function retryDelayMs(attempt: number, policy: DeliveryPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}

export type DeliverNotification = (
  notification: DeliveryNotification,
  attempt: number,
) => Promise<DeliveryDecision>;

// Выбор «риск дубля против риска потери» сделан в пользу дубля (ADR-052):
// отметка «доставлено» пишется после ответа Telegram, поэтому падение между
// отправкой и отметкой повторит сообщение, а не потеряет его.
export function createDeliverNotification(deps: {
  journal: DeliveryJournal;
  recipients: TelegramRecipientResolver;
  sender: NotificationSender;
  policy?: DeliveryPolicy;
  now?: () => Date;
}): DeliverNotification {
  const policy = deps.policy ?? defaultDeliveryPolicy;
  const now = deps.now ?? (() => new Date());
  const record = (
    state: DeliveryRecord["state"],
    attempts: number,
    reason?: string,
  ): DeliveryRecord => ({
    state,
    attempts,
    at: now().toISOString(),
    ...(reason === undefined ? {} : { reason }),
  });

  const drop = async (
    notification: DeliveryNotification,
    attempt: number,
    reason: DropReason,
    cause?: unknown,
  ): Promise<DeliveryDecision> => {
    // Отметка об отказе — диагностика, а не условие: не легла — повтор шиной
    // придёт к тому же отказу и снова снимется, ничего не отправив.
    await deps.journal.write(
      notification.notificationId,
      record("dropped", attempt, reason),
    );
    return cause === undefined
      ? { kind: "drop", reason }
      : { kind: "drop", reason, cause };
  };

  const retry = async (
    notification: DeliveryNotification,
    attempt: number,
    reason: RetryReason,
    delayMs: number,
    cause: unknown,
  ): Promise<DeliveryDecision> => {
    if (attempt >= policy.maxAttempts) {
      return drop(notification, attempt, "attempts_exhausted", cause);
    }
    await deps.journal.write(
      notification.notificationId,
      record("retrying", attempt, reason),
    );
    return { kind: "retry", delayMs, reason, cause };
  };

  return async (notification, attempt) => {
    const seen = await deps.journal.read(notification.notificationId);
    if (seen.kind === "unavailable") {
      // Без журнала нельзя отличить новое сообщение от уже доставленного, а
      // отправка вслепую и есть тот дубль, от которого журнал защищает.
      return retry(
        notification,
        attempt,
        "journal_unavailable",
        retryDelayMs(attempt, policy),
        seen.cause,
      );
    }
    if (seen.record?.state === "delivered") {
      return { kind: "ack", outcome: "already_delivered" };
    }
    if (seen.record?.state === "dropped") {
      return { kind: "ack", outcome: "already_dropped" };
    }
    if (
      notification.notAfter !== undefined &&
      notification.notAfter.getTime() < now().getTime()
    ) {
      return drop(notification, attempt, "expired");
    }
    const content = notification.content;
    if (content.kind === "unrendered") {
      return drop(notification, attempt, "unrendered_type");
    }
    const recipient = await deps.recipients.resolveTelegramUserId(
      notification.recipientId,
      notification.requestId === undefined
        ? undefined
        : rpcMeta({ requestId: notification.requestId }),
    );
    switch (recipient.kind) {
      case "resolved":
        break;
      case "not-found":
        return drop(notification, attempt, "recipient_not_found");
      case "blocked":
        return drop(notification, attempt, "recipient_blocked");
      case "rejected":
        return drop(
          notification,
          attempt,
          "recipient_rejected",
          recipient.cause,
        );
      case "unavailable":
        return retry(
          notification,
          attempt,
          "identity_unavailable",
          retryDelayMs(attempt, policy),
          recipient.cause,
        );
      default: {
        const _exhaustive: never = recipient;
        return _exhaustive;
      }
    }
    const sent = await deps.sender.send({
      telegramUserId: recipient.telegramUserId,
      content,
    });
    switch (sent.kind) {
      case "sent": {
        const written = await deps.journal.write(
          notification.notificationId,
          record("delivered", attempt),
        );
        return written.kind === "ok"
          ? { kind: "ack", outcome: "delivered" }
          : { kind: "ack", outcome: "delivered", journalMissed: true };
      }
      case "bot-blocked":
        return drop(notification, attempt, "bot_blocked", sent.cause);
      case "rejected":
        return drop(notification, attempt, "telegram_rejected", sent.cause);
      case "rate-limited":
        return retry(
          notification,
          attempt,
          "telegram_rate_limited",
          // Пауза Telegram — нижняя граница, а не вся задержка: иначе долгая
          // серия 429 съела бы попытки с постоянным шагом.
          Math.max(sent.retryAfterMs, retryDelayMs(attempt, policy)),
          sent.cause,
        );
      case "unavailable":
        return retry(
          notification,
          attempt,
          "telegram_unavailable",
          retryDelayMs(attempt, policy),
          sent.cause,
        );
      default: {
        const _exhaustive: never = sent;
        return _exhaustive;
      }
    }
  };
}
