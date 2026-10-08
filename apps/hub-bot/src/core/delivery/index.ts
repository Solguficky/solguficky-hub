// Публичная граница пакета: механика доставки адресных фактов Notifications в
// Telegram, общая для бота хаба и бота аукциона. Разбор своих веток `oneof`,
// текст и клавиатура остаются у бота.

export { type BusStatus, busConnectionOperation } from "./bus-status.js";
export {
  type DeliveryHandlerDeps,
  type DeliveryMessage,
  handleDeliveryMessage,
  type NotificationDelivery,
  notificationDurable,
  notificationStream,
  notificationSubject,
  startNotificationDelivery,
} from "./consumer.js";
export {
  createDeliverNotification,
  type DeliverNotification,
  type DeliveryDecision,
  type DeliveryPolicy,
  type DropReason,
  defaultDeliveryPolicy,
  type RetryReason,
  retryDelayMs,
} from "./deliver.js";
export { classifyRecipientFailure, isPermanentFailure } from "./identity.js";
export { createKvJournal, type JournalStore } from "./kv-journal.js";
export {
  deliveryJournalBucket,
  type NatsDelivery,
  natsConnectOptions,
  startNatsDelivery,
} from "./nats.js";
export {
  type ChannelContent,
  type DecodeNotification,
  type DecodeResult,
  type DeliveryNotification,
  isOtherBranch,
  malformed,
  type NotificationEnvelope,
  type OtherBranch,
  toDeliveryNotification,
} from "./notification.js";
export type {
  CountFailure,
  DeliveryLogFields,
  DeliveryLogger,
  FailureCategory,
  RecordOutcome,
} from "./observe.js";
export type {
  DeliveryJournal,
  DeliveryRecord,
  DeliveryState,
  JournalReadResult,
  JournalWriteResult,
  NotificationSender,
  RenderContext,
  RenderMessage,
  RenderResult,
  SendResult,
  TelegramRecipientResolver,
  TelegramRecipientResult,
} from "./port.js";
export { classifyTelegramFailure } from "./telegram.js";
