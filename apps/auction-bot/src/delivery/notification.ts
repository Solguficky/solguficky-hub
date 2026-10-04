import { fromBinary } from "@bufbuild/protobuf";
import type { Money } from "@solguficky/auction-bot-ui";
import {
  type DeliveryNotification as ChannelNotification,
  type DecodeResult,
  type OtherBranch,
  toDeliveryNotification,
} from "@solguficky/telegram-delivery";
import type { Money as WireMoney } from "../../gen/auction/v1/auction_pb.js";
import {
  type Notification,
  NotificationSchema,
} from "../../gen/notifications/v1/notifications_pb.js";

// Ветки, которые доставляет бот аукциона (integration.md, «потребитель
// выбирается по ветке `oneof type`»). Факт несёт только лот и сумму: название
// лота не входит в домен торгов, и канал читает его у Auction сам.
export type AuctionNotificationContent =
  | { kind: "lot-outbid"; lotId: string; currentPrice: Money }
  | { kind: "lot-purchased"; lotId: string; price: Money };

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
    case "lotOutbid": {
      const lotId = canonical(type.value.lotId);
      const currentPrice = toMoney(type.value.currentPrice);
      return lotId === undefined || currentPrice === undefined
        ? undefined
        : { kind: "lot-outbid", lotId, currentPrice };
    }
    case "lotPurchased": {
      const lotId = canonical(type.value.lotId);
      const price = toMoney(type.value.price);
      return lotId === undefined || price === undefined
        ? undefined
        : { kind: "lot-purchased", lotId, price };
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
      return { kind: "foreign", type: type.case };
    default:
      return { kind: "unrendered", type: type.case ?? "unknown" };
  }
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Из идентификатора лота собирается кнопка: не каноническая форма уронила бы
// кодировщик на отправке, а не на разборе.
function canonical(id: string): string | undefined {
  return CANONICAL_UUID.test(id) ? id : undefined;
}

// Сумма без валюты или вне безопасного целого — нарушение контракта: цену в
// уведомлении нельзя показать приблизительно.
function toMoney(money: WireMoney | undefined): Money | undefined {
  if (money === undefined || money.currency === "") return undefined;
  const minorUnits = Number(money.minorUnits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return undefined;
  return { minorUnits, currency: money.currency };
}
