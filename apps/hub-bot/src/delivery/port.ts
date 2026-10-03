import type { RenderableContent } from "./notification.js";

// Запись журнала попыток по notification_id. Окончательные состояния —
// «доставлено» и «отброшено»: встретив их, повторно доставленное шиной
// сообщение подтверждается без похода в Telegram. «Повтор» не окончательный и
// только называет, сколько попыток уже было и почему.
export type DeliveryState = "delivered" | "dropped" | "retrying";

export type DeliveryRecord = {
  state: DeliveryState;
  attempts: number;
  reason?: string;
  at: string;
};

export type JournalReadResult =
  | { kind: "ok"; record: DeliveryRecord | undefined }
  | { kind: "unavailable"; cause: unknown };

export type JournalWriteResult =
  | { kind: "ok" }
  | { kind: "unavailable"; cause: unknown };

export type DeliveryJournal = {
  read(notificationId: string): Promise<JournalReadResult>;
  write(
    notificationId: string,
    record: DeliveryRecord,
  ): Promise<JournalWriteResult>;
};

// Отказы Telegram по классам, а не по кодам: решение о повторе принимает юзкейс,
// а какой ответ Bot API к какому классу относится, знает только представление.
export type SendResult =
  | { kind: "sent" }
  | { kind: "bot-blocked"; cause: unknown }
  | { kind: "rate-limited"; retryAfterMs: number; cause: unknown }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; cause: unknown };

export type NotificationSender = {
  send(input: {
    telegramUserId: bigint;
    content: RenderableContent;
  }): Promise<SendResult>;
};
