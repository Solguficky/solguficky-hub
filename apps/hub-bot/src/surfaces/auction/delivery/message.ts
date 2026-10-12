import { Api } from "grammy";
import {
  encodeAuctionCallback,
  parseAuctionCallback,
} from "../../../auction-ui/index.js";
import type { TelegramEnvironment } from "../../../core/config.js";
import {
  classifyTelegramFailure,
  isPermanentFailure,
  type NotificationSender,
  type RenderMessage,
} from "../../../core/delivery/index.js";
import { money, truncate } from "../entry-screen.js";
import { entryCallback, notifyCallback, parseEntryCallback } from "../faq.js";
import { screenMark } from "../screen-catalog.js";
import type { AuctionNotificationContent } from "./notification.js";

type TraceButton = { text: string; callback_data: string };

// `settings` — «Реже» рядом с «К лоту» у перебития (PER-515): пара одним
// рядом, единственная вторая кнопка следа (дизайн-код, «Уведомления
// аукциона»).
export type NotificationMessage = {
  text: string;
  button: TraceButton;
  settings?: TraceButton;
};

// Кнопка под следом (дизайн-код, «Доставка»): карточка лота приходит новым
// сообщением, а уведомление остаётся в истории целым. Внутри — обычная кнопка
// лота аукционного дерева, поэтому маршрут и шлюз доступа у неё те же; префикс
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

// Вход в аукцион из следа сообщения о допуске — FAQ, тем же путём, что
// команда `/faq`: впереди у допущенного правила, и подпись это и обещает
// (PER-592). «Аукционы» под FAQ ставят отметку и открывают список.
export function traceFaqCallback(): string {
  return `${tracePrefix}${entryCallback("faq")}`;
}

// «Реже» под перебитием — экран частоты тем же путём, что команда
// `/notifications`, новым сообщением (PER-515).
export function traceNotifyCallback(): string {
  return `${tracePrefix}${notifyCallback()}`;
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
// только зрителю с правом `auction` (Viewer.isParticipant), а право получателя
// канал не придумывает — спрашивает у Identity.
export type NotificationReads = {
  // true — право есть, false — нет; недоступность Identity — исключение.
  holdsPlaceBids(identityId: string, requestId?: string): Promise<boolean>;
  // Название лота глазами получателя; любой отказ — исключение со своим кодом.
  lotTitle(
    identityId: string,
    lotId: string,
    requestId?: string,
  ): Promise<string>;
};

// Сборка сообщения. Без права `auction` уведомление не отправляется вовсе:
// кнопка упёрлась бы в тот же отказ, а человек, у которого право сняли, о
// торгах больше не слышит. Недоступный Auction названия не роняет: перебитие
// ценно вовремя, а название видно в карточке по кнопке. Отказ, который повтор
// не изменит, — лот не найден или не виден получателю с правом, — дефект: такое
// уведомление снимается, а не уходит с кнопкой в тот же отказ.
//
// `outbidSettings` — у бота есть Notifications, и под перебитием стоит «Реже».
export function createRenderMessage(
  reads: NotificationReads,
  onTitleMissing: (cause: unknown, requestId?: string) => void,
  outbidSettings = false,
): RenderMessage<AuctionNotificationContent, NotificationMessage> {
  return async (content, { recipientId, requestId }) => {
    let eligible: boolean;
    try {
      eligible = await reads.holdsPlaceBids(recipientId, requestId);
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
    return {
      kind: "ready",
      message: renderNotification(content, title, outbidSettings),
    };
  };
}

// Название лота у Auction ничем не ограничено, а сообщение длиннее предела
// Telegram отвергается окончательно: уведомление потерялось бы целиком.
const TITLE_LIMIT = 200;

export function renderNotification(
  content: AuctionNotificationContent,
  title?: string,
  outbidSettings = false,
): NotificationMessage {
  if (content.kind === "access-granted") {
    return {
      text: "Тебя допустили к аукциону.",
      button: {
        text: "Правила и FAQ",
        callback_data: traceFaqCallback(),
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
    ...(outbidSettings && content.kind === "lot-outbid"
      ? { settings: { text: "Реже", callback_data: traceNotifyCallback() } }
      : {}),
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

// Клавиатура следа — один ряд: «К лоту» и у перебития ещё «Реже». Её же
// собирает тест каталога экранов, а не свою копию.
export function notificationMarkup(message: NotificationMessage) {
  return {
    inline_keyboard: [
      message.settings === undefined
        ? [message.button]
        : [message.button, message.settings],
    ],
  };
}

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
          reply_markup: notificationMarkup(message),
          link_preview_options: { is_disabled: true },
        });
        return { kind: "sent" };
      } catch (cause) {
        return classifyTelegramFailure(cause);
      }
    },
  };
}
