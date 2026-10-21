import type { AuctionCancelled } from "../../../gen/notifications/v1/notifications_pb.js";
import { money } from "../format.js";
import { type NoticeMoney, toMoney } from "./lot-notice.js";

// Извещение об отмене аукциона после старта торгов (ADR-047, дополнение
// 2026-10-12; PER-604) — одна весть каждому, кто вёл лот аукциона, и
// покупателю его проданных лотов. У двух ботов она одна: участнику её
// доставляет бот хаба, гостю — бот аукциона, маршрут по кругу получателя
// выбирает Notifications. Здесь разбор ветки, текст и кнопка; данные кнопки
// каждая поверхность кодирует своим следом, как у итога розыгрыша.
//
// Права `place-bids` получателя канал не спрашивает: весть о том, что торги
// оборвались, а покупателю — что купленное осталось за ним; знать это нужно и
// тому, у кого право сняли после.

export type AuctionCancelledNotice = {
  kind: "auction-cancelled";
  auctionId: string;
  // Цены лотов, которые купил получатель; пусто — у остальных.
  purchases: readonly NoticeMoney[];
};

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Факт — ввод соседа: кривой идентификатор аукциона или лота и покупка без
// цены — дефект издателя, и разбор отвечает `undefined`, как у остальных
// веток. Названий в факте нет (notifications.proto), и весть их не читает.
export function auctionCancelledNoticeOf(
  value: AuctionCancelled,
): AuctionCancelledNotice | undefined {
  if (!CANONICAL_UUID.test(value.auctionId)) return undefined;
  const purchases: NoticeMoney[] = [];
  for (const purchase of value.purchases) {
    const price = toMoney(purchase.price);
    if (!CANONICAL_UUID.test(purchase.lotId) || price === undefined) {
      return undefined;
    }
    purchases.push(price);
  }
  return { kind: "auction-cancelled", auctionId: value.auctionId, purchases };
}

// Кнопка следа: корень аукциона приходит новым сообщением, весть остаётся в
// истории. Там же лоты — и купленные с названиями.
export type AuctionCancelledButton = { auctionId: string; text: string };

export type AuctionCancelledView = {
  text: string;
  button: AuctionCancelledButton;
};

const toAuctionLabel = "К аукциону";

// Одна-две фразы на «ты», без заголовка и разметки (дизайн-код, «Уведомления
// аукциона»). Строку о покупке получает только покупатель: одна покупка — её
// цена, несколько — число и сумма.
export function renderAuctionCancelledNotice(
  notice: AuctionCancelledNotice,
): AuctionCancelledView {
  return {
    text: [
      "Аукцион отменили: торги по лотам остановлены, ставки больше не действуют.",
      ...purchaseLine(notice.purchases),
    ].join("\n"),
    button: { auctionId: notice.auctionId, text: toAuctionLabel },
  };
}

function purchaseLine(purchases: readonly NoticeMoney[]): string[] {
  const [first] = purchases;
  if (first === undefined) return [];
  if (purchases.length === 1) {
    return [`Твоя покупка за ${money(first)} остаётся за тобой.`];
  }
  // Валюта у аукциона одна; другая валюта в покупках — сумма не складывается,
  // и строка называет одно число лотов.
  const sameCurrency = purchases.every(
    (each) => each.currency === first.currency,
  );
  const count = `${purchases.length} ${lotWord(purchases.length)}`;
  if (!sameCurrency) return [`Твои покупки — ${count} — остаются за тобой.`];
  const total = purchases.reduce((sum, each) => sum + each.minorUnits, 0);
  return [
    `Твои покупки — ${count} на ${money({ minorUnits: total, currency: first.currency })} — остаются за тобой.`,
  ];
}

function lotWord(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "лотов";
  if (ones === 1) return "лот";
  if (ones >= 2 && ones <= 4) return "лота";
  return "лотов";
}
