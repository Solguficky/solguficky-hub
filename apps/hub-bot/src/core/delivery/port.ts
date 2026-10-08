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

// Обратный путь канала: уведомление несёт внутренний идентификатор, а писать
// можно только по Telegram id. Отсутствующий и заблокированный профиль — разные
// исходы: оба окончательные, но в журнале и логах различимы, а недоступность
// Identity, в отличие от них, лечится повтором. Клиента Identity держит бот:
// `request_id` цепочки он кладёт в заголовок вызова сам.
export type TelegramRecipientResult =
  | { kind: "resolved"; telegramUserId: bigint }
  | { kind: "not-found" }
  | { kind: "blocked" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type TelegramRecipientResolver = {
  resolveTelegramUserId(
    identityId: string,
    requestId?: string,
  ): Promise<TelegramRecipientResult>;
};

// Сборка сообщения из содержимого своего канала. Бот, которому для текста
// нужны соседи, ходит к ним здесь: недоступный сосед — повтор, получатель, у
// которого нет права на то, о чём сообщение, — окончательный отказ, а отказ
// соседа, который повтор не изменит, — дефект, снимаемый без повторов.
export type RenderResult<M> =
  | { kind: "ready"; message: M }
  | { kind: "ineligible" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; cause: unknown };

export type RenderContext = {
  recipientId: string;
  requestId?: string;
};

export type RenderMessage<C, M> = (
  content: C,
  context: RenderContext,
) => Promise<RenderResult<M>>;

// Отказы Telegram по классам, а не по кодам: решение о повторе принимает юзкейс,
// а какой ответ Bot API к какому классу относится — classifyTelegramFailure.
export type SendResult =
  | { kind: "sent" }
  | { kind: "bot-blocked"; cause: unknown }
  | { kind: "rate-limited"; retryAfterMs: number; cause: unknown }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; cause: unknown };

export type NotificationSender<M> = {
  send(input: { telegramUserId: bigint; message: M }): Promise<SendResult>;
};
