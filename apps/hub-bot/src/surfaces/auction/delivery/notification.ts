import { fromBinary } from "@bufbuild/protobuf";
import {
  ApplicationQueue,
  Circle,
} from "../../../../gen/identity/v1/access_pb.js";
import {
  type Notification,
  NotificationSchema,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import {
  type DeliveryNotification as ChannelNotification,
  type DecodeResult,
  type OtherBranch,
  toDeliveryNotification,
} from "../../../core/delivery/index.js";
import {
  type LotNotice,
  lotNoticeOf,
} from "../../../core/notifications/lot-notice.js";

// Ветки, которые доставляет бот аукциона (integration.md, «потребитель
// выбирается по ветке `oneof type`»). Факт несёт только лот и сумму: название
// лота не входит в домен торгов, и канал читает его у Auction сам. Ветки лотов —
// перебитие, ответ автоставки (PER-473), покупка и сводка (PER-596) — общие с
// ботом хаба (PER-598).
export type AuctionNotificationContent =
  | LotNotice
  // Допуск к аукциону получает сам заявитель (PER-442). Круг здесь всегда
  // public: допуск в хаб доставляет бот хаба.
  | { kind: "access-granted" }
  // Повышение гостя до участника (PER-537): о смене круга сообщает прежний бот
  // — этот, и это последнее его сообщение человеку (RFC-015, С-11). Ссылки на
  // бот хаба весть не несёт, и сохранять в ней нечего: круг приходит в самом
  // факте и всё сказано текстом.
  | { kind: "circle-promoted" };

export type DeliveryNotification =
  ChannelNotification<AuctionNotificationContent>;

// Сообщение шины — ввод соседа: формат проверил рантайм Protobuf, инварианты
// конверта — пакет доставки, а инварианты своих веток — этот разбор.
// Нарушение — дефект издателя, и повтор его не лечит.
export function decodeNotification(
  data: Uint8Array,
): DecodeResult<AuctionNotificationContent> {
  let message: Notification;
  try {
    message = fromBinary(NotificationSchema, data);
  } catch (cause) {
    return {
      kind: "malformed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return toDeliveryNotification(message, toContent(message));
}

function toContent(
  message: Notification,
): AuctionNotificationContent | OtherBranch | undefined {
  const type = message.type;
  switch (type.case) {
    case "lotOutbid":
    case "lotProxyRaised":
    case "lotPurchased":
    case "lotActivityDigest":
    case "lotReminder":
      return lotNoticeOf(type);
    // Допуск доставляет бот той поверхности, куда подана заявка: здесь —
    // заявку в аукцион, а допуск в хаб для аукциона чужой.
    case "accessGranted": {
      const queue = type.value.queue;
      if (queue === ApplicationQueue.AUCTION) return { kind: "access-granted" };
      if (queue === ApplicationQueue.COMMUNITY) {
        return { kind: "foreign", type: type.case };
      }
      return undefined;
    }
    // Смена круга (PER-537): до этой поверхности доходит сторона повышения
    // гостя — её она и доставляет. Обратный переход `member → guest` адресован
    // боту хаба (PER-536) и в этот durable не попадает: subject у каналов свой,
    // и маршрут выбирается по прежнему кругу. Всё равно он разбирается как
    // чужая ветка, а не как отказ — так же ведёт себя и ветка чужого канала.
    // Пустая или неизвестная пара кругов — дефект издателя: `guest ↔ member` —
    // единственные переходы, которые он рождает.
    case "circleChanged": {
      const { previousCircle, currentCircle } = type.value;
      if (previousCircle === Circle.GUEST && currentCircle === Circle.MEMBER) {
        return { kind: "circle-promoted" };
      }
      if (previousCircle === Circle.MEMBER && currentCircle === Circle.GUEST) {
        return { kind: "foreign", type: type.case };
      }
      return undefined;
    }
    // Ветки сходок, ручных рассылок и заявок доставляет бот хаба: общий поток
    // несёт их и сюда, и это не отказ.
    case "meetupPublished":
    case "meetupChanged":
    case "meetupMaterial":
    case "meetupReminder":
    case "organizerMessage":
    case "communityAnnouncement":
    case "meetupUnpublished":
    case "accessRequested":
    case "presetGranted":
      return { kind: "foreign", type: type.case };
    default:
      return { kind: "unrendered", type: type.case ?? "unknown" };
  }
}
