import {
  classifyTelegramFailure,
  isPermanentFailure,
  type NotificationSender,
  type RenderMessage,
} from "@solguficky/telegram-delivery";
import { Api } from "grammy";
import {
  encodeAuctionCallback,
  parseAuctionCallback,
} from "../../../auction-ui/index.js";
import type { TelegramEnvironment } from "../config.js";
import { money, truncate } from "../entry-screen.js";
import { entryCallback, parseEntryCallback } from "../faq.js";
import { screenMark } from "../screen-catalog.js";
import type { AuctionNotificationContent } from "./notification.js";

export type NotificationMessage = {
  text: string;
  button: { text: string; callback_data: string };
};

// Кнопка под следом (дизайн-код, «Доставка»): карточка лота приходит новым
// сообщением, а уведомление остаётся в истории целым. Внутри — обычная кнопка
// лота общего пакета, поэтому маршрут и шлюз доступа у неё те же; префикс
// говорит краю только одно — не править и не удалять сообщение, под которым
// нажали. Первая страница ленты — родитель лота, на который ведёт возврат.
const tracePrefix = "v1:t:";

// След опознаётся по префиксу, а не по успеху разбора: кнопка следа, которую
// эта сборка уже не читает, всё равно не должна затереть уведомление.
export function isTraceCallback(data: string): boolean {
  return data.startsWith(tracePrefix);
}

export function traceLotCallback(lotId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({ kind: "lot", lotId, page: 0 })}`;
}

// Вход в аукцион из следа — тот же путь, что пункт меню «Аукционы»: FAQ, если
// человек его ещё не прошёл, иначе список активных аукционов (PER-442,
// PER-453).
export function traceAuctionsCallback(): string {
  return `${tracePrefix}${entryCallback("auctions")}`;
}

// Кнопка внутри следа: лот или пункт входа. Не след или след без читаемой
// кнопки — undefined: такую кнопку край разбирает как обычную.
export function parseTraceCallback(data: string): string | undefined {
  if (!data.startsWith(tracePrefix)) return undefined;
  const inner = data.slice(tracePrefix.length);
  if (parseEntryCallback(inner) !== undefined) return inner;
  const parsed = parseAuctionCallback(inner);
  return parsed.ok && parsed.intent.kind === "lot" ? inner : undefined;
}

// Чтения, которые нужны тексту уведомления. Название лота отдаёт Auction
// только зрителю с ролью `public` (Viewer.isParticipant), а роль получателя
// канал не придумывает — спрашивает у Identity.
export type NotificationReads = {
  // true — роль есть, false — нет; недоступность Identity — исключение.
  hasPublicRole(identityId: string, requestId?: string): Promise<boolean>;
  // Название лота глазами получателя; любой отказ — исключение со своим кодом.
  lotTitle(
    identityId: string,
    lotId: string,
    requestId?: string,
  ): Promise<string>;
};

// Сборка сообщения. Без роли `public` уведомление не отправляется вовсе:
// кнопка упёрлась бы в тот же отказ, а человек, у которого роль сняли, о
// торгах больше не слышит. Недоступный Auction названия не роняет: перебитие
// ценно вовремя, а название видно в карточке по кнопке. Отказ, который повтор
// не изменит, — лот не найден или не виден получателю с ролью, — дефект: такое
// уведомление снимается, а не уходит с кнопкой в тот же отказ.
export function createRenderMessage(
  reads: NotificationReads,
  onTitleMissing: (cause: unknown, requestId?: string) => void,
): RenderMessage<AuctionNotificationContent, NotificationMessage> {
  return async (content, { recipientId, requestId }) => {
    let eligible: boolean;
    try {
      eligible = await reads.hasPublicRole(recipientId, requestId);
    } catch (cause) {
      return isPermanentFailure(cause)
        ? { kind: "rejected", cause }
        : { kind: "unavailable", cause };
    }
    if (!eligible) return { kind: "ineligible" };
    if (content.kind === "access-granted") {
      return { kind: "ready", message: renderNotification(content) };
    }
    let title: string | undefined;
    try {
      title = await reads.lotTitle(recipientId, content.lotId, requestId);
    } catch (cause) {
      if (isPermanentFailure(cause)) return { kind: "rejected", cause };
      onTitleMissing(cause, requestId);
    }
    return { kind: "ready", message: renderNotification(content, title) };
  };
}

// Название лота у Auction ничем не ограничено, а сообщение длиннее предела
// Telegram отвергается окончательно: уведомление потерялось бы целиком.
const TITLE_LIMIT = 200;

export function renderNotification(
  content: AuctionNotificationContent,
  title?: string,
): NotificationMessage {
  if (content.kind === "access-granted") {
    return {
      text: "Тебя допустили к аукциону.",
      button: {
        text: "Открыть аукцион",
        callback_data: traceAuctionsCallback(),
      },
    };
  }
  const lot =
    title === undefined || title === ""
      ? undefined
      : `«${truncate(title, TITLE_LIMIT)}»`;
  const text = notificationText(content, lot);
  return {
    text,
    button: { text: "К лоту", callback_data: traceLotCallback(content.lotId) },
  };
}

function notificationText(
  content: Exclude<AuctionNotificationContent, { kind: "access-granted" }>,
  lot: string | undefined,
): string {
  switch (content.kind) {
    case "lot-outbid":
      return `Твою ставку на ${lot ?? "лот"} перебили. Текущая цена — ${money(content.currentPrice)}.`;
    case "lot-proxy-raised":
      return `Твоя автоставка на ${lot ?? "лот"} подняла цену до ${money(content.currentPrice)}: лидируешь ты.`;
    case "lot-purchased":
      return `Лот ${lot === undefined ? "" : `${lot} `}твой за ${money(content.price)}.`;
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

// Вызов Bot API обязан уложиться в ack_wait durable (30 с): иначе шина выдаст
// то же сообщение второй раз, пока первая отправка ещё висит. Умолчание grammY
// рассчитано на long polling, поэтому у доставки свой клиент со своим
// таймаутом — как у бота хаба.
const sendTimeoutSeconds = 10;

export function createNotificationApi(
  token: string,
  environment: TelegramEnvironment,
): Api {
  return new Api(token, { environment, timeoutSeconds: sendTimeoutSeconds });
}

export type SendMessageApi = Pick<Api, "sendMessage">;

export function createNotificationSender(
  api: SendMessageApi,
): NotificationSender<NotificationMessage> {
  return {
    async send({ telegramUserId, message }) {
      try {
        // Личный чат с человеком имеет id самого человека. Telegram держит id в
        // 52 битах, поэтому переход из bigint в number точен. Метка каталога —
        // чтобы линтер test kit видел и эту отправку: она идёт мимо адаптера
        // экранов.
        await api.sendMessage(Number(telegramUserId), message.text, {
          ...screenMark("notification"),
          reply_markup: { inline_keyboard: [[message.button]] },
          link_preview_options: { is_disabled: true },
        });
        return { kind: "sent" };
      } catch (cause) {
        return classifyTelegramFailure(cause);
      }
    },
  };
}
