import { fromBinary } from "@bufbuild/protobuf";
import type {
  DateValue,
  Schedule,
  LocalDateTime as WireLocalDateTime,
} from "../../gen/meetups/v1/meetups_pb.js";
import {
  type Notification,
  NotificationSchema,
} from "../../gen/notifications/v1/notifications_pb.js";

export type LocalDate = { year: number; month: number; day: number };
export type LocalDateTime = LocalDate & { hours: number; minutes: number };

// Расписание в той форме, в какой его опубликовал Meetups: предварительная дата
// отличается от точной, а день без времени — от дня со временем. Сводить их к
// одному моменту значило бы обещать в уведомлении больше, чем знает сходка.
export type MeetupWhen =
  | { kind: "no-date" }
  | { kind: "day"; tentative: boolean; date: LocalDate }
  | { kind: "day-start"; tentative: boolean; at: LocalDateTime }
  | {
      kind: "interval";
      tentative: boolean;
      start: LocalDateTime;
      end: LocalDateTime;
    };

export type PublishedMeetup = {
  id: string;
  title: string;
  venue: string;
  when: MeetupWhen;
};

// Отрисовать канал пока умеет один тип. Остальные доезжают до решения явным
// вариантом, а не пропадают на разборе: контракт запрещает доставлять
// неизвестное молча, и отказ обязан быть виден в журнале и логах.
export type NotificationContent =
  | { kind: "meetup-published"; meetup: PublishedMeetup }
  | { kind: "unrendered"; type: string };

export type RenderableContent = Extract<
  NotificationContent,
  { kind: "meetup-published" }
>;

export type DeliveryNotification = {
  notificationId: string;
  recipientId: string;
  notAfter?: Date;
  requestId?: string;
  content: NotificationContent;
};

export type DecodeResult =
  | { kind: "ok"; notification: DeliveryNotification }
  | { kind: "malformed"; error: string };

// Сообщение шины — ввод соседа: формат проверил рантайм Protobuf, а инварианты
// контракта, которые схема выразить не может, проверяются здесь. Нарушение —
// дефект издателя, и повтор его не лечит.
export function decodeNotification(data: Uint8Array): DecodeResult {
  let message: Notification;
  try {
    message = fromBinary(NotificationSchema, data);
  } catch (cause) {
    return {
      kind: "malformed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (message.notificationId === "") return malformed("notification_id");
  if (message.recipientId === "") return malformed("recipient_id");
  const content = toContent(message);
  if (content === undefined) return malformed("meetup card");
  const notification: DeliveryNotification = {
    notificationId: message.notificationId,
    recipientId: message.recipientId,
    content,
  };
  if (message.notAfter !== undefined) {
    const notAfter = new Date(message.notAfter);
    if (Number.isNaN(notAfter.getTime())) return malformed("not_after");
    notification.notAfter = notAfter;
  }
  if (message.requestId !== undefined && message.requestId !== "") {
    notification.requestId = message.requestId;
  }
  return { kind: "ok", notification };
}

function malformed(field: string): DecodeResult {
  return { kind: "malformed", error: `invalid ${field}` };
}

function toContent(message: Notification): NotificationContent | undefined {
  if (message.type.case !== "meetupPublished") {
    return { kind: "unrendered", type: message.type.case ?? "unknown" };
  }
  const card = message.type.value.meetup;
  if (card === undefined || card.id === "") return undefined;
  const when = toWhen(card.schedule);
  if (when === undefined) return undefined;
  return {
    kind: "meetup-published",
    meetup: { id: card.id, title: card.title, venue: card.venue, when },
  };
}

// Пустой oneof не второе написание «без даты»: это форма no_date. Поэтому
// отсутствующее расписание — нарушение контракта, а не пустая строка в тексте.
function toWhen(schedule: Schedule | undefined): MeetupWhen | undefined {
  const form = schedule?.form;
  if (form === undefined || form.case === undefined) return undefined;
  if (form.case === "noDate") return { kind: "no-date" };
  return toDated(form.value, form.case === "tentative");
}

function toDated(value: DateValue, tentative: boolean): MeetupWhen | undefined {
  const precision = value.precision;
  switch (precision.case) {
    case "day":
      return { kind: "day", tentative, date: toDate(precision.value) };
    case "dayStart": {
      const at = toDateTime(precision.value);
      return at === undefined
        ? undefined
        : { kind: "day-start", tentative, at };
    }
    case "interval": {
      const start = toDateTime(precision.value.start);
      const end = toDateTime(precision.value.end);
      return start === undefined || end === undefined
        ? undefined
        : { kind: "interval", tentative, start, end };
    }
    default:
      return undefined;
  }
}

function toDate(value: LocalDate): LocalDate {
  return { year: value.year, month: value.month, day: value.day };
}

function toDateTime(
  value: WireLocalDateTime | undefined,
): LocalDateTime | undefined {
  if (value?.date === undefined || value.time === undefined) return undefined;
  return {
    ...toDate(value.date),
    hours: value.time.hours,
    minutes: value.time.minutes,
  };
}
