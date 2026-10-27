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
import type { MediaChat } from "../../../core/media-chat.js";
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
  createInvoiceNoticeRender,
  type InvoiceNoticeView,
  isInvoiceNotice,
  renderInvoiceNotice,
} from "../../../core/notifications/invoice-notice.js";
import {
  checkPlaceBids,
  createLotNoticeRender,
  type LotInfo,
  type LotNoticeReads,
  type LotNoticeView,
  renderLotNotice,
} from "../../../core/notifications/lot-notice.js";
import {
  type LotSetNotice,
  renderLotSetNotice,
} from "../../../core/notifications/lot-set-notice.js";
import {
  type AnnouncementPhoto,
  type AnnouncementPhotos,
  type AnnouncementPost,
  announcementButtonData,
  noAnnouncementPhotos,
  type OrganizerAnnouncement,
  renderOrganizerAnnouncement,
  sendOrganizerAnnouncement,
} from "../../../core/notifications/organizer-announcement.js";
import {
  type PredictionResultsNotice,
  renderPredictionResultsNotice,
} from "../../../core/notifications/prediction-results-notice.js";
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
// `format` — HTML у вести о лоте: название жирным, экранированное рендером
// (№71 прогона 14 октября 2026 года). Остальные вести — простой текст.
export type NotificationMessage = {
  text: string;
  rows?: readonly (readonly TraceButton[])[];
  format?: "HTML";
  // Фото лота объявления аукциона (PER-765) и получатель, чьими правами
  // отправитель читает его байты у Auction.
  photo?: { photo: AnnouncementPhoto; viewerId: string };
  // Своё фото или видео объявления (PER-776): пост чата медиа ботов.
  post?: AnnouncementPost;
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

// «К счёту» под напоминанием об оплате (PER-322) — экран счёта аукционного
// дерева тем же путём, что кнопка счёта в «Моих счетах».
export function traceInvoiceCallback(lotId: string, invoiceId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({ kind: "invoice", lotId, invoiceId })}`;
}

// «К сету» под извещением о собранном наборе (PER-687) — экран сета из
// аукционного дерева тем же путём, что кнопка на карточке лота.
export function traceSetCallback(lotId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({ kind: "set", lotId, page: 0 })}`;
}

export function tracePredictionResultsCallback(auctionId: string): string {
  return `${tracePrefix}${encodeAuctionCallback({
    kind: "prediction-results",
    auctionId,
  })}`;
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
  // Частота, открытая из вести, — экран без возврата в дерево настроек (№73
  // прогона 14 октября 2026 года): человек пришёл не из «Настроек». Кнопка
  // старых вестей несёт тот же след и открывает тот же экран.
  if (inner === notifyCallback()) return notifyCallback(undefined, true);
  if (parseEntryCallback(inner) !== undefined) return inner;
  const parsed = parseAuctionCallback(inner);
  return parsed.ok &&
    (parsed.intent.kind === "lot" ||
      parsed.intent.kind === "set" ||
      parsed.intent.kind === "raffle" ||
      parsed.intent.kind === "invoice" ||
      parsed.intent.kind === "prediction-results" ||
      parsed.intent.kind === "feed" ||
      parsed.intent.kind === "root" ||
      // Кнопки объявления аукциона (PER-765): прогнозы и хроники дня.
      parsed.intent.kind === "prediction" ||
      parsed.intent.kind === "day-chronicle")
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
  // Напоминание о счёте (PER-322) права не спрашивает: долг — дело победителя
  // (invoice-notice.ts), а название лота — подсказка.
  const renderInvoice = createInvoiceNoticeRender({
    reads,
    onTitleMissing,
    timeZone,
  });
  return async (content, context) => {
    if (isInvoiceNotice(content)) {
      const rendered = await renderInvoice(content, context);
      return rendered.kind === "ready"
        ? { kind: "ready", message: invoiceMessage(rendered.message) }
        : rendered;
    }
    // Весть о смене круга (PER-537) — не о торгах: право ставить бот для неё не
    // спрашивает, и кнопки, которая упёрлась бы в тот же отказ, у неё нет.
    if (content.kind === "circle-promoted") {
      return { kind: "ready", message: renderNotification(content) };
    }
    // Итог розыгрыша (PER-620) права не спрашивает: жеребьёвка уже прошла, и
    // о ней знать нужно и тому, у кого право сняли после (raffle-notice.ts).
    if (
      content.kind === "raffle-result" ||
      content.kind === "prediction-results"
    ) {
      return { kind: "ready", message: renderNotification(content) };
    }
    // Итог сета (PER-687) права не спрашивает: собравший уже назван фактом,
    // а знать о награде нужно и после снятия права на торги.
    if (content.kind === "lot-set-collected") {
      return { kind: "ready", message: renderNotification(content) };
    }
    // Объявление аукциона (PER-765) права не спрашивает: адресата выбрал
    // издатель по праву ставок. Фото читается правами получателя.
    if (content.kind === "organizer-announcement") {
      const message = renderNotification(content);
      return {
        kind: "ready",
        message:
          content.photo === undefined
            ? message
            : {
                ...message,
                photo: { photo: content.photo, viewerId: context.recipientId },
              },
      };
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
    if (
      content.kind === "new-auction" ||
      content.kind === "trading-opened" ||
      content.kind === "step-window-announced"
    ) {
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
  if (content.kind === "prediction-results") {
    return predictionResultsMessage(content);
  }
  if (content.kind === "raffle-result") return raffleMessage(content);
  if (isInvoiceNotice(content)) {
    return invoiceMessage(renderInvoiceNotice(content, { timeZone }));
  }
  if (content.kind === "lot-set-collected") return lotSetMessage(content);
  if (content.kind === "organizer-announcement") {
    return organizerMessage(content);
  }
  if (content.kind === "auction-cancelled") return cancelledMessage(content);
  // Начало окна «Счастливых часов» (PER-616) — ряд на каждый лот окна, след
  // лота этой поверхности.
  if (isStepWindowNotice(content)) {
    return traceMessage(renderStepWindowNotice(content, { lots, timeZone }));
  }
  if (
    content.kind === "new-auction" ||
    content.kind === "trading-opened" ||
    content.kind === "step-window-announced"
  ) {
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
    ...(view.format === undefined ? {} : { format: view.format }),
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

function invoiceMessage(view: InvoiceNoticeView): NotificationMessage {
  return {
    text: view.text,
    format: view.format,
    rows: [
      [
        {
          text: view.button.text,
          callback_data: traceInvoiceCallback(
            view.button.lotId,
            view.button.invoiceId,
          ),
        },
      ],
    ],
  };
}

function predictionResultsMessage(
  notice: PredictionResultsNotice,
): NotificationMessage {
  const view = renderPredictionResultsNotice(notice);
  return {
    text: view.text,
    rows: [
      [
        {
          text: view.button.text,
          callback_data: tracePredictionResultsCallback(view.button.auctionId),
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

function lotSetMessage(notice: LotSetNotice): NotificationMessage {
  const view = renderLotSetNotice(notice);
  return {
    text: view.text,
    rows: [
      [
        {
          text: view.button.text,
          callback_data: traceSetCallback(view.button.lotId),
        },
      ],
    ],
  };
}

// Объявление аукциона (PER-765): текст организатора простым текстом и кнопка
// следа на экран дерева; фото добавляет рендер с получателем.
function organizerMessage(notice: OrganizerAnnouncement): NotificationMessage {
  const view = renderOrganizerAnnouncement(notice);
  return {
    text: view.text,
    ...(view.post === undefined ? {} : { post: view.post }),
    ...(view.button === undefined
      ? {}
      : {
          rows: [
            [
              {
                text: view.button.text,
                callback_data: `${tracePrefix}${announcementButtonData(view.button)}`,
              },
            ],
          ],
        }),
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

export type SendMessageApi = Pick<
  Api,
  "sendMessage" | "sendPhoto" | "copyMessage"
>;

// Клавиатура следа. Её же собирает тест каталога экранов, а не свою копию. У
// вести о смене круга (PER-537) кнопок нет вовсе — тогда и клавиатуры не шлём.
export function notificationMarkup(message: NotificationMessage) {
  if (message.rows === undefined || message.rows.length === 0) return undefined;
  return { inline_keyboard: message.rows.map((row) => [...row]) };
}

export function createNotificationSender(
  api: SendMessageApi,
  // Фото объявления аукциона (PER-765); нет — объявление уходит текстом.
  photos?: AnnouncementPhotos,
  // Чат медиа ботов: своё фото или видео объявления (PER-776).
  media?: MediaChat,
): NotificationSender<NotificationMessage> {
  return {
    async send({ telegramUserId, message }) {
      const markup = notificationMarkup(message);
      try {
        if (
          (message.photo !== undefined && photos !== undefined) ||
          (message.post !== undefined && media !== undefined)
        ) {
          await sendOrganizerAnnouncement(
            api,
            Number(telegramUserId),
            {
              text: message.text,
              ...(message.photo === undefined
                ? {}
                : { photo: message.photo.photo }),
              ...(message.post === undefined ? {} : { post: message.post }),
            },
            {
              photos: photos ?? noAnnouncementPhotos,
              media,
              viewerId: message.photo?.viewerId ?? "",
              markup,
              mark: screenMark("notification"),
            },
          );
          return { kind: "sent" };
        }
        // Личный чат с человеком имеет id самого человека. Telegram держит id в
        // 52 битах, поэтому переход из bigint в number точен. Метка каталога —
        // чтобы линтер test kit видел и эту отправку: она идёт мимо адаптера
        // экранов.
        await api.sendMessage(Number(telegramUserId), message.text, {
          ...screenMark("notification"),
          ...(markup === undefined ? {} : { reply_markup: markup }),
          ...(message.format === undefined
            ? {}
            : { parse_mode: message.format }),
          link_preview_options: { is_disabled: true },
        });
        return { kind: "sent" };
      } catch (cause) {
        return classifyTelegramFailure(cause);
      }
    },
  };
}
