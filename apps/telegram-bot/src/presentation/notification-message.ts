import { Api, GrammyError, InlineKeyboard } from "grammy";
import type {
  LocalDate,
  LocalDateTime,
  MeetupWhen,
  RenderableContent,
} from "../delivery/notification.js";
import type { NotificationSender, SendResult } from "../delivery/port.js";
import type { TelegramEnvironment } from "./bot.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Кнопка отключения несёт целевое состояние, как переключатель P-09: повторное
// нажатие даёт то же «выключено», а не включает категорию обратно.
export const disablePublishedCallback = "v1:notify:off:published";

// Вызов Bot API обязан уложиться в ack_wait durable (30 с): иначе шина выдаст то
// же сообщение второй раз, пока первая отправка ещё висит. Умолчание клиента
// grammY рассчитано на long polling и измеряется минутами, поэтому у доставки
// свой клиент со своим таймаутом, а не общий с поллером.
const sendTimeoutSeconds = 10;

export function createNotificationApi(
  token: string,
  environment: TelegramEnvironment,
): Api {
  return new Api(token, { environment, timeoutSeconds: sendTimeoutSeconds });
}

export type NotificationMessage = { text: string; keyboard: InlineKeyboard };

// Кадр по образцу P-11: заголовок называет повод и сходку, строка ниже — когда
// и где, клавиатура ведёт в сходку и к отключению категории одним нажатием.
export function renderNotification(
  content: RenderableContent,
): NotificationMessage {
  const meetup = content.meetup;
  const title = meetup.title.trim();
  const lines = [title === "" ? "Новая сходка" : `Новая сходка: ${title}`];
  lines.push(formatWhen(meetup.when));
  const venue = meetup.venue.trim();
  if (venue !== "") lines.push(`Место: ${venue}`);
  const keyboard = new InlineKeyboard()
    .text("Открыть сходку", `v1:view:${uuidToToken(meetup.id)}`)
    .row()
    .text("Не присылать новые сходки", disablePublishedCallback);
  return { text: lines.join("\n"), keyboard };
}

function formatWhen(when: MeetupWhen): string {
  switch (when.kind) {
    case "no-date":
      return "Дата пока не назначена";
    case "day":
      return tentative(when.tentative, formatDate(when.date));
    case "day-start":
      return tentative(when.tentative, formatDateTime(when.at));
    case "interval": {
      const sameDay =
        when.start.year === when.end.year &&
        when.start.month === when.end.month &&
        when.start.day === when.end.day;
      const end = sameDay ? formatTime(when.end) : formatDateTime(when.end);
      return tentative(when.tentative, `${formatDateTime(when.start)}–${end}`);
    }
    default: {
      const _exhaustive: never = when;
      return _exhaustive;
    }
  }
}

function tentative(isTentative: boolean, value: string): string {
  return isTentative ? `Предварительно: ${value}` : value;
}

// Тот же вид `ДД.ММ.ГГГГ ЧЧ:ММ`, что у карточки и формы сходки: дата в
// уведомлении и в карточке, куда оно ведёт, читается одинаково.
function formatDate(value: LocalDate): string {
  return `${pad(value.day)}.${pad(value.month)}.${value.year}`;
}

function formatTime(value: LocalDateTime): string {
  return `${pad(value.hours)}:${pad(value.minutes)}`;
}

function formatDateTime(value: LocalDateTime): string {
  return `${formatDate(value)} ${formatTime(value)}`;
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

export type SendMessageApi = Pick<Api, "sendMessage">;

export function createNotificationSender(
  api: SendMessageApi,
): NotificationSender {
  return {
    async send({ telegramUserId, content }) {
      const message = renderNotification(content);
      try {
        // Личный чат с человеком имеет id самого человека. Telegram держит id в
        // 52 битах, поэтому переход из bigint в number точен.
        await api.sendMessage(Number(telegramUserId), message.text, {
          reply_markup: message.keyboard,
          link_preview_options: { is_disabled: true },
        });
        return { kind: "sent" };
      } catch (cause) {
        return classifySendFailure(cause);
      }
    },
  };
}

// 403 — получатель заблокировал бота или удалил аккаунт: повтор не поможет, и
// бесконечные попытки запрещены задачей. 429 несёт готовую паузу. Остальные 4xx —
// нарушение формы запроса, 5xx и сетевой сбой — временная недоступность.
export function classifySendFailure(cause: unknown): SendResult {
  if (cause instanceof GrammyError) {
    if (cause.error_code === 403) return { kind: "bot-blocked", cause };
    if (cause.error_code === 429) {
      const seconds = cause.parameters.retry_after ?? 1;
      return { kind: "rate-limited", retryAfterMs: seconds * 1_000, cause };
    }
    if (cause.error_code >= 500) return { kind: "unavailable", cause };
    return { kind: "rejected", cause };
  }
  // HttpError, истёкший таймаут и прочий сбой до ответа Telegram.
  return { kind: "unavailable", cause };
}
