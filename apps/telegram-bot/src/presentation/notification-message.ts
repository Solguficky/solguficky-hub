import { Api, GrammyError, InlineKeyboard } from "grammy";
import type {
  LocalDate,
  LocalDateTime,
  MeetupAspect,
  MeetupWhen,
  NotifiedMeetup,
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

// Клавиатуры нет, когда вести некуда: пустая разметка — тоже разметка, и
// отправлять её незачем.
export type NotificationMessage = {
  text: string;
  keyboard: InlineKeyboard | undefined;
};

// Изменения и материалы получают подписчики конкретной сходки, и настройка у
// сходки перекрывает общую. Поэтому кнопка выключает категорию у этой сходки:
// общий выключатель не остановил бы уведомления, если у сходки категория
// включена явно, а подтверждение под сообщением обещало бы обратное.
export function disableMeetupCategoryCallback(
  meetupId: string,
  category: "changes" | "material",
): string {
  return `v1:notify:moff:${uuidToToken(meetupId)}:${category}`;
}

// Кадр по образцу P-11: заголовок называет повод и сходку, строки ниже — что
// нужно знать, не открывая карточку. Одно сообщение на повод, карточка целиком
// не повторяется: описание и ссылка на календарь только называются.
export function renderNotification(
  content: RenderableContent,
): NotificationMessage {
  const meetup = content.meetup;
  const open = () =>
    new InlineKeyboard().text(
      "Открыть сходку",
      `v1:view:${uuidToToken(meetup.id)}`,
    );
  switch (content.kind) {
    case "meetup-published":
      return {
        text: [headline("Новая сходка", meetup), ...whenAndWhere(meetup)].join(
          "\n",
        ),
        keyboard: open()
          .row()
          .text("Не присылать новые сходки", disablePublishedCallback),
      };
    case "meetup-changed":
      return {
        text: renderChange(content).join("\n"),
        keyboard: open()
          .row()
          .text(
            "Не присылать изменения этой сходки",
            disableMeetupCategoryCallback(meetup.id, "changes"),
          ),
      };
    case "meetup-material": {
      const material = content.materialTitle.trim();
      return {
        text: [
          headline("Новое связанное сообщение", meetup),
          ...(material === "" ? [] : [material]),
        ].join("\n"),
        keyboard: open()
          .row()
          .text(
            "Не присылать связанные сообщения этой сходки",
            disableMeetupCategoryCallback(meetup.id, "material"),
          ),
      };
    }
    // Сходка скрыта: кнопка «Открыть» упёрлась бы в «не найдено», а отключать
    // уже нечего — снятие последний повод, пока сходку не вернут. Поэтому
    // клавиатуры нет, а текст называет сходку и дату, чтобы её узнать.
    case "meetup-unpublished":
      return {
        text: [
          headline("Сходка снята с публикации", meetup),
          formatWhen(meetup.when),
        ].join("\n"),
        keyboard: undefined,
      };
    default: {
      const _exhaustive: never = content;
      return _exhaustive;
    }
  }
}

type ChangeContent = Extract<RenderableContent, { kind: "meetup-changed" }>;

const aspectLabels: Record<MeetupAspect, string> = {
  title: "название",
  description: "описание",
  venue: "место",
  kind: "вид сходки",
  "calendar-link": "ссылка на календарь",
  schedule: "дата и время",
  lifecycle: "статус",
  visibility: "видимость",
  other: "другие сведения",
};

// Старых значений контракт не несёт, поэтому текст говорит, что изменилось, и
// показывает, как стало. Смена состояния, о которой заголовок говорит сам, —
// отмена, проведение, возврат в публикацию — в перечень не повторяется.
function renderChange(content: ChangeContent): string[] {
  const { meetup, aspects } = content;
  const cancelled =
    aspects.includes("lifecycle") && content.lifecycle === "cancelled";
  const held = aspects.includes("lifecycle") && content.lifecycle === "held";
  const returned =
    aspects.includes("visibility") && content.visibility === "visible";
  const lead = cancelled
    ? "Сходка отменена"
    : held
      ? "Сходка состоялась"
      : returned
        ? "Сходка снова опубликована"
        : "Изменения в сходке";
  const named = aspects.filter(
    (aspect) =>
      !(aspect === "lifecycle" && (cancelled || held)) &&
      !(aspect === "visibility" && returned),
  );
  const lines = [headline(lead, meetup)];
  if (named.length > 0) {
    lines.push(
      `Изменилось: ${named.map((aspect) => aspectLabels[aspect]).join(", ")}`,
    );
  }
  if (aspects.includes("lifecycle") && !cancelled && !held) {
    lines.push("Статус: запланирована");
  }
  const kind = meetup.kind.trim();
  if (aspects.includes("kind") && kind !== "") lines.push(`Вид: ${kind}`);
  // Отменённой сходке дата и место уже ни к чему: главное сказано заголовком.
  if (!cancelled) lines.push(...whenAndWhere(meetup));
  return lines;
}

function headline(lead: string, meetup: NotifiedMeetup): string {
  const title = meetup.title.trim();
  return title === "" ? lead : `${lead}: ${title}`;
}

function whenAndWhere(meetup: NotifiedMeetup): string[] {
  const venue = meetup.venue.trim();
  return venue === ""
    ? [formatWhen(meetup.when)]
    : [formatWhen(meetup.when), `Место: ${venue}`];
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
          ...(message.keyboard === undefined
            ? {}
            : { reply_markup: message.keyboard }),
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
