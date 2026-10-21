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
  type AuctionAnnouncementNotice,
  renderAuctionAnnouncement,
} from "../../../core/notifications/auction-announcement-notice.js";
import {
  type AuctionCancelledNotice,
  renderAuctionCancelledNotice,
} from "../../../core/notifications/auction-cancelled-notice.js";
import {
  createFinalNoticeRender,
  isFinalNotice,
  renderFinalNotice,
} from "../../../core/notifications/final-notice.js";
import {
  checkPlaceBids,
  createLotNoticeRender,
  type LotInfo,
  type LotNoticeReads,
  type LotNoticeView,
  renderLotNotice,
} from "../../../core/notifications/lot-notice.js";
import {
  type RaffleNotice,
  renderRaffleNotice,
} from "../../../core/notifications/raffle-notice.js";
import {
  createStepWindowNoticeRender,
  isStepWindowNotice,
  renderStepWindowNotice,
} from "../../../core/notifications/step-window-notice.js";
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

// «К розыгрышу» под итогом розыгрыша (PER-620) — экран розыгрыша аукционного
// дерева тем же путём, что кнопка «Розыгрыш» ленты.
export function traceRaffleCallback(auctionId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({ kind: "raffle", auctionId })}`;
}

// «К аукциону» под извещением об отмене (PER-606) — корень аукциона дерева
// тем же путём, что кнопка аукциона в списке.
export function traceRootCallback(auctionId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({ kind: "root", auctionId })}`;
}

// «Лоты» под вестью об открытии торгов (PER-646) — лента лотов аукциона тем
// же путём, что кнопка «Лоты» корня аукциона.
export function traceFeedCallback(auctionId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({ kind: "feed", auctionId, page: 0 })}`;
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

// Кнопка внутри следа: лот, розыгрыш или пункт входа. Не след или след без
// читаемой кнопки — undefined: такую кнопку край разбирает как обычную.
export function parseTraceCallback(data: string): string | undefined {
  if (!data.startsWith(tracePrefix)) return undefined;
  const inner = data.slice(tracePrefix.length);
  if (parseEntryCallback(inner) !== undefined) return inner;
  const parsed = parseAuctionCallback(inner);
  return parsed.ok &&
    (parsed.intent.kind === "lot" ||
      parsed.intent.kind === "raffle" ||
      parsed.intent.kind === "feed" ||
      parsed.intent.kind === "root")
    ? inner
    : undefined;
}

// Чтения, которые нужны тексту уведомления о лоте: право получателя и название
// лота — общий порт двух ботов.
export type NotificationReads = LotNoticeReads;

// Сборка сообщения. Вести о лотах и анонс финала собирают общие рендеры двух
// ботов (`lot-notice.ts`, `final-notice.ts`): без права `place-bids`
// уведомление не уходит, недоступный Auction роняет только названия. Допуск к
// аукциону тоже требует права: кнопка ведёт в FAQ, который без него не
// откроется.
//
// `frequencyButton` — у бота есть Notifications, и под вестью о торгах стоит
// «Частота уведомлений».
export function createRenderMessage(
  reads: NotificationReads,
  onTitleMissing: (cause: unknown, requestId?: string) => void,
  frequencyButton = false,
  timeZone = "UTC",
): RenderMessage<AuctionNotificationContent, NotificationMessage> {
  const renderLot = createLotNoticeRender({
    reads,
    onTitleMissing,
    frequencyButton,
    timeZone,
  });
  const renderFinal = createFinalNoticeRender({ reads, onTitleMissing });
  // Начало окна «Счастливых часов» (PER-616) — тот же общий рендер и те же
  // чтения, что у бота хаба: право получателя у Identity, названия лотов окна
  // у Auction.
  const renderStepWindow = createStepWindowNoticeRender({
    reads,
    onTitleMissing,
    timeZone,
  });
  return async (content, context) => {
    // Весть о смене круга (PER-537) — не о торгах: право ставить бот для неё не
    // спрашивает, и кнопки, которая упёрлась бы в тот же отказ, у неё нет.
    if (content.kind === "circle-promoted") {
      return { kind: "ready", message: renderNotification(content) };
    }
    // Итог розыгрыша (PER-620) права не спрашивает: жеребьёвка уже прошла, и
    // о ней знать нужно и тому, у кого право сняли после (raffle-notice.ts).
    if (content.kind === "raffle-result") {
      return { kind: "ready", message: renderNotification(content) };
    }
    // Отмена аукциона (PER-606) права не спрашивает: торги уже оборвались, а
    // покупателю нужно знать, что купленное осталось за ним
    // (auction-cancelled-notice.ts).
    if (content.kind === "auction-cancelled") {
      return { kind: "ready", message: renderNotification(content) };
    }
    // Вести о новом аукционе и об открытии торгов (PER-646) права не
    // спрашивают: адресата выбрал издатель по праву ставок
    // (auction-announcement-notice.ts).
    if (content.kind === "new-auction" || content.kind === "trading-opened") {
      return {
        kind: "ready",
        message: renderNotification(content, new Map(), false, timeZone),
      };
    }
    if (content.kind === "access-granted") {
      return (
        (await checkPlaceBids(reads, context)) ?? {
          kind: "ready",
          message: renderNotification(content),
        }
      );
    }
    const rendered = isFinalNotice(content)
      ? await renderFinal(content, context)
      : isStepWindowNotice(content)
        ? await renderStepWindow(content, context)
        : await renderLot(content, context);
    return rendered.kind === "ready"
      ? { kind: "ready", message: traceMessage(rendered.message) }
      : rendered;
  };
}

export function renderNotification(
  content: AuctionNotificationContent,
  lots: ReadonlyMap<string, LotInfo> = new Map(),
  frequencyButton = false,
  timeZone = "UTC",
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
  if (content.kind === "raffle-result") return raffleMessage(content);
  if (content.kind === "auction-cancelled") return cancelledMessage(content);
  // Начало окна «Счастливых часов» (PER-616) — ряд на каждый лот окна, след
  // лота этой поверхности.
  if (isStepWindowNotice(content)) {
    return traceMessage(renderStepWindowNotice(content, { lots, timeZone }));
  }
  if (content.kind === "new-auction" || content.kind === "trading-opened") {
    return announcementMessage(content, timeZone);
  }
  if (isFinalNotice(content)) {
    return traceMessage(renderFinalNotice(content, { lots }));
  }
  return traceMessage(
    renderLotNotice(content, { lots, frequencyButton, timeZone }),
  );
}

// Кнопки общего рендера — следы этой поверхности: лот — кнопка лота дерева,
// частота — экран `/notifications`. У анонса без своих лотов и у старта финала
// рядов нет, и клавиатура не уходит.
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

function cancelledMessage(notice: AuctionCancelledNotice): NotificationMessage {
  const view = renderAuctionCancelledNotice(notice);
  return {
    text: view.text,
    rows: [
      [
        {
          text: view.button.text,
          callback_data: traceRootCallback(view.button.auctionId),
        },
      ],
    ],
  };
}

// «Аукцион» ведёт в корень аукциона, «Лоты» — в ленту лотов: обе кнопки — следы
// этой поверхности, экран приходит новым сообщением.
function announcementMessage(
  notice: AuctionAnnouncementNotice,
  timeZone: string,
): NotificationMessage {
  const view = renderAuctionAnnouncement(notice, timeZone);
  return {
    text: view.text,
    rows: [
      [
        {
          text: view.button.text,
          callback_data:
            notice.kind === "new-auction"
              ? traceRootCallback(view.button.auctionId)
              : traceFeedCallback(view.button.auctionId),
        },
      ],
    ],
  };
}

function raffleMessage(notice: RaffleNotice): NotificationMessage {
  const view = renderRaffleNotice(notice);
  return {
    text: view.text,
    rows: [
      [
        {
          text: view.button.text,
          callback_data: traceRaffleCallback(view.button.auctionId),
        },
      ],
    ],
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
