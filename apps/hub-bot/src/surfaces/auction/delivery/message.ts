import { Api } from "grammy";
import {
  encodeAuctionCallback,
  parseAuctionCallback,
} from "../../../auction-ui/index.js";
import type { TelegramEnvironment } from "../../../core/config.js";
import {
  classifyTelegramFailure,
  type NotificationSender,
  type RenderMessage,
} from "../../../core/delivery/index.js";
import {
  checkPlaceBids,
  createLotNoticeRender,
  type LotNoticeReads,
  type LotNoticeView,
  renderLotNotice,
} from "../../../core/notifications/lot-notice.js";
import { entryCallback, notifyCallback, parseEntryCallback } from "../faq.js";
import { screenMark } from "../screen-catalog.js";
import type { AuctionNotificationContent } from "./notification.js";

type TraceButton = { text: string; callback_data: string };

// Ряды кнопок следа (дизайн-код, «Уведомления аукциона»): у одиночной вести о
// лоте — «К лоту» и рядом «Частота уведомлений», у сводки — ряд на лот и ряд
// частоты (PER-598). Кнопок нет у вести о смене круга (PER-537): в боте аукциона
// участник дальше экрана перехода в сообщество не пройдёт, и вести её нечем.
export type NotificationMessage = {
  text: string;
  rows?: readonly (readonly TraceButton[])[];
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

// «Частота уведомлений» под вестью о торгах — экран частоты тем же путём, что
// команда `/notifications`, новым сообщением (PER-515, PER-598).
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

// Чтения, которые нужны тексту уведомления о лоте: право получателя и название
// лота — общий порт двух ботов.
export type NotificationReads = LotNoticeReads;

// Сборка сообщения. Вести о лотах собирает общий рендер двух ботов
// (`lot-notice.ts`): без права `place-bids` уведомление не уходит, недоступный
// Auction роняет только название. Допуск к аукциону тоже требует права: кнопка
// ведёт в FAQ, который без него не откроется.
//
// `frequencyButton` — у бота есть Notifications, и под вестью о торгах стоит
// «Частота уведомлений».
export function createRenderMessage(
  reads: NotificationReads,
  onTitleMissing: (cause: unknown, requestId?: string) => void,
  frequencyButton = false,
): RenderMessage<AuctionNotificationContent, NotificationMessage> {
  const renderLot = createLotNoticeRender({
    reads,
    onTitleMissing,
    frequencyButton,
  });
  return async (content, context) => {
    // Весть о смене круга (PER-537) — не о торгах: право ставить бот для неё не
    // спрашивает, и кнопки, которая упёрлась бы в тот же отказ, у неё нет.
    if (content.kind === "circle-promoted") {
      return { kind: "ready", message: renderNotification(content) };
    }
    if (content.kind === "access-granted") {
      return (
        (await checkPlaceBids(reads, context)) ?? {
          kind: "ready",
          message: renderNotification(content),
        }
      );
    }
    const rendered = await renderLot(content, context);
    return rendered.kind === "ready"
      ? { kind: "ready", message: traceMessage(rendered.message) }
      : rendered;
  };
}

export function renderNotification(
  content: AuctionNotificationContent,
  titles: ReadonlyMap<string, string> = new Map(),
  frequencyButton = false,
): NotificationMessage {
  if (content.kind === "access-granted") {
    return {
      text: "Тебя допустили к аукциону.",
      rows: [[{ text: "Правила и FAQ", callback_data: traceFaqCallback() }]],
    };
  }
  // Повышение до участника (PER-537): кнопки нет — любое действие участника в
  // боте аукциона ведёт на экран перехода в сообщество, и обещать кнопкой
  // больше нечего.
  if (content.kind === "circle-promoted") {
    return { text: "Тебя приняли в сообщество." };
  }
  return traceMessage(renderLotNotice(content, { titles, frequencyButton }));
}

// Кнопки общего рендера — следы этой поверхности: лот — кнопка лота дерева,
// частота — экран `/notifications`.
function traceMessage(view: LotNoticeView): NotificationMessage {
  return {
    text: view.text,
    rows: view.rows.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data:
          button.kind === "lot"
            ? traceLotCallback(button.lotId)
            : traceNotifyCallback(),
      })),
    ),
  };
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

// Клавиатура следа. Её же собирает тест каталога экранов, а не свою копию. У
// вести о смене круга (PER-537) кнопок нет вовсе — тогда и клавиатуры не шлём.
export function notificationMarkup(message: NotificationMessage) {
  if (message.rows === undefined || message.rows.length === 0) return undefined;
  return { inline_keyboard: message.rows.map((row) => [...row]) };
}

export function createNotificationSender(
  api: SendMessageApi,
): NotificationSender<NotificationMessage> {
  return {
    async send({ telegramUserId, message }) {
      const markup = notificationMarkup(message);
      try {
        // Личный чат с человеком имеет id самого человека. Telegram держит id в
        // 52 битах, поэтому переход из bigint в number точен. Метка каталога —
        // чтобы линтер test kit видел и эту отправку: она идёт мимо адаптера
        // экранов.
        await api.sendMessage(Number(telegramUserId), message.text, {
          ...screenMark("notification"),
          ...(markup === undefined ? {} : { reply_markup: markup }),
          link_preview_options: { is_disabled: true },
        });
        return { kind: "sent" };
      } catch (cause) {
        return classifyTelegramFailure(cause);
      }
    },
  };
}
