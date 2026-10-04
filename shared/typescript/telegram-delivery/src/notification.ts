// Ветка `oneof type`, которую этот канал не рисует. Два случая различаются
// намеренно (docs/architecture/integration.md, «потребитель выбирается по ветке
// `oneof type`»):
//
// - `foreign` — ветка из схемы, которую доставляет другой канал. Это штатная
//   жизнь общего потока: сообщение подтверждается без журнала и без отказа;
// - `unrendered` — ветка, которой канал не знает: из схемы новее этой сборки
//   или ещё не нарисованная. Контракт запрещает доставлять неизвестное молча,
//   поэтому отказ виден в журнале и логах.
export type OtherBranch =
  | { kind: "foreign"; type: string }
  | { kind: "unrendered"; type: string };

// Содержимое своего канала — размеченное объединение бота, `kind` которого
// попадает в лог полем `notification_type`. Виды `foreign` и `unrendered`
// заняты OtherBranch и боту недоступны.
export type ChannelContent = { kind: string };

export function isOtherBranch(content: ChannelContent): content is OtherBranch {
  return content.kind === "foreign" || content.kind === "unrendered";
}

export type DeliveryNotification<C extends ChannelContent> = {
  notificationId: string;
  recipientId: string;
  notAfter?: Date;
  requestId?: string;
  content: C | OtherBranch;
};

export type DecodeResult<C extends ChannelContent> =
  | { kind: "ok"; notification: DeliveryNotification<C> }
  | { kind: "malformed"; error: string };

export type DecodeNotification<C extends ChannelContent> = (
  data: Uint8Array,
) => DecodeResult<C>;

// Конверт `notifications.v1.Notification` в той мере, в какой он общий для
// всех каналов. Сгенерированный тип бота подходит сюда как есть: пакет схем не
// генерирует, а разбор ветки остаётся боту.
export type NotificationEnvelope = {
  notificationId: string;
  recipientId: string;
  notAfter?: string | undefined;
  requestId?: string | undefined;
};

// Инварианты конверта, которые схема выразить не может. Нарушение — дефект
// издателя, и повтор его не лечит. `content` undefined — ветка своего канала,
// у которой бот не собрал содержимого.
export function toDeliveryNotification<C extends ChannelContent>(
  envelope: NotificationEnvelope,
  content: C | OtherBranch | undefined,
): DecodeResult<C> {
  if (envelope.notificationId === "") return malformed("notification_id");
  if (envelope.recipientId === "") return malformed("recipient_id");
  if (content === undefined) return malformed("notification body");
  const notification: DeliveryNotification<C> = {
    notificationId: envelope.notificationId,
    recipientId: envelope.recipientId,
    content,
  };
  if (envelope.notAfter !== undefined) {
    const notAfter = new Date(envelope.notAfter);
    if (Number.isNaN(notAfter.getTime())) return malformed("not_after");
    notification.notAfter = notAfter;
  }
  if (envelope.requestId !== undefined && envelope.requestId !== "") {
    notification.requestId = envelope.requestId;
  }
  return { kind: "ok", notification };
}

export function malformed(field: string): {
  kind: "malformed";
  error: string;
} {
  return { kind: "malformed", error: `invalid ${field}` };
}
