import { fromBinary } from "@bufbuild/protobuf";
import {
  type DeliveryNotification as ChannelNotification,
  type DecodeResult,
  type OtherBranch,
  toDeliveryNotification,
} from "@solguficky/telegram-delivery";
import type { Money as WireMoney } from "../../../../gen/auction/v1/auction_pb.js";
import { GlobalRole } from "../../../../gen/identity/v1/roles_pb.js";
import {
  type Notification,
  NotificationSchema,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import type { Money } from "../../../auction-ui/index.js";

// Ветки, которые доставляет бот аукциона (integration.md, «потребитель
// выбирается по ветке `oneof type`»). Факт несёт только лот и сумму: название
// лота не входит в домен торгов, и канал читает его у Auction сам.
export type AuctionNotificationContent =
  | { kind: "lot-outbid"; lotId: string; currentPrice: Money }
  // Автоставка получателя ответила чужой команде и подняла цену; он лидер
  // (PER-473).
  | { kind: "lot-proxy-raised"; lotId: string; currentPrice: Money }
  | { kind: "lot-purchased"; lotId: string; price: Money }
  // Допуск к аукциону получает сам заявитель (PER-442). Круг здесь всегда
  // public: допуск в хаб доставляет бот хаба.
  | { kind: "access-granted" };

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
    case "lotProxyRaised": {
      const lotId = canonical(type.value.lotId);
      const currentPrice = toMoney(type.value.currentPrice);
      return lotId === undefined || currentPrice === undefined
        ? undefined
        : { kind: "lot-proxy-raised", lotId, currentPrice };
    }
    case "lotPurchased": {
      const lotId = canonical(type.value.lotId);
      const price = toMoney(type.value.price);
      return lotId === undefined || price === undefined
        ? undefined
        : { kind: "lot-purchased", lotId, price };
    }
    // Допуск доставляет бот той поверхности, куда подана заявка: здесь —
    // заявку в public, а допуск в хаб для аукциона чужой.
    case "accessGranted": {
      const circle = type.value.circle;
      if (circle === GlobalRole.GUEST) return { kind: "access-granted" };
      if (circle === GlobalRole.MEMBER) {
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
    case "roleGranted":
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

// Сумма без кода валюты ISO 4217 или вне безопасного целого — нарушение
// контракта: цену в уведомлении нельзя показать приблизительно, а код не той
// формы уронил бы форматирование на каждой попытке.
const CURRENCY = /^[A-Z]{3}$/;

function toMoney(money: WireMoney | undefined): Money | undefined {
  if (money === undefined || !CURRENCY.test(money.currency)) return undefined;
  const minorUnits = Number(money.minorUnits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) return undefined;
  return { minorUnits, currency: money.currency };
}
