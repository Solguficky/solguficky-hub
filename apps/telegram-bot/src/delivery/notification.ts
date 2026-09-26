import { fromBinary } from "@bufbuild/protobuf";
import {
  type DateValue,
  type Schedule,
  type LocalDateTime as WireLocalDateTime,
  MeetupLifecycle as WireMeetupLifecycle,
  MeetupVisibility as WireMeetupVisibility,
} from "../../gen/meetups/v1/meetups_pb.js";
import {
  type MeetupCard,
  type Notification,
  NotificationSchema,
  MeetupAspect as WireMeetupAspect,
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

export type NotifiedMeetup = {
  id: string;
  title: string;
  venue: string;
  kind: string;
  when: MeetupWhen;
};

// Что изменилось, без старых значений: их контракт не несёт, а текущее
// значение лежит в карточке факта. `other` — аспект из будущей схемы, которого
// этот канал ещё не знает: изменение всё равно случилось, и молчать о нём
// хуже, чем назвать его «другие сведения».
export type MeetupAspect =
  | "title"
  | "description"
  | "venue"
  | "kind"
  | "calendar-link"
  | "schedule"
  | "lifecycle"
  | "visibility"
  | "other";

export type MeetupLifecycle = "planned" | "held" | "cancelled";
export type MeetupVisibility = "hidden" | "visible";

// Типы, которые канал не рисует — ручные рассылки, — доезжают до
// решения явным вариантом, а не пропадают на разборе: контракт запрещает
// доставлять неизвестное молча, и отказ обязан быть виден в журнале и логах.
export type NotificationContent =
  | { kind: "meetup-published"; meetup: NotifiedMeetup }
  | {
      kind: "meetup-changed";
      meetup: NotifiedMeetup;
      aspects: readonly MeetupAspect[];
      lifecycle: MeetupLifecycle;
      visibility: MeetupVisibility;
    }
  | { kind: "meetup-material"; meetup: NotifiedMeetup; materialTitle: string }
  | { kind: "meetup-unpublished"; meetup: NotifiedMeetup }
  | { kind: "meetup-reminder"; meetup: NotifiedMeetup }
  | { kind: "unrendered"; type: string };

export type RenderableContent = Exclude<
  NotificationContent,
  { kind: "unrendered" }
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
  if (content === undefined) return malformed("notification body");
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
  const type = message.type;
  switch (type.case) {
    case "meetupPublished": {
      const meetup = toMeetup(type.value.meetup);
      return meetup === undefined
        ? undefined
        : { kind: "meetup-published", meetup };
    }
    case "meetupChanged": {
      const card = type.value.meetup;
      const meetup = toMeetup(card);
      const aspects = toAspects(type.value.changedAspects);
      const lifecycle = toLifecycle(card?.lifecycle);
      const visibility = toVisibility(card?.visibility);
      if (
        meetup === undefined ||
        aspects === undefined ||
        lifecycle === undefined ||
        visibility === undefined
      ) {
        return undefined;
      }
      return {
        kind: "meetup-changed",
        meetup,
        aspects,
        lifecycle,
        visibility,
      };
    }
    case "meetupMaterial": {
      const meetup = toMeetup(type.value.meetup);
      return meetup === undefined
        ? undefined
        : {
            kind: "meetup-material",
            meetup,
            materialTitle: type.value.materialTitle,
          };
    }
    case "meetupUnpublished": {
      const meetup = toMeetup(type.value.meetup);
      return meetup === undefined
        ? undefined
        : { kind: "meetup-unpublished", meetup };
    }
    case "meetupReminder": {
      const meetup = toMeetup(type.value.meetup);
      return meetup === undefined
        ? undefined
        : { kind: "meetup-reminder", meetup };
    }
    default:
      return { kind: "unrendered", type: type.case ?? "unknown" };
  }
}

function toMeetup(card: MeetupCard | undefined): NotifiedMeetup | undefined {
  if (card === undefined || card.id === "") return undefined;
  const when = toWhen(card.schedule);
  if (when === undefined) return undefined;
  return {
    id: card.id,
    title: card.title,
    venue: card.venue,
    kind: card.kind,
    when,
  };
}

// Контракт обещает непустой список без UNSPECIFIED: нарушение — дефект
// издателя. Незнакомое число — аспект из схемы новее этой сборки, а не дефект.
function toAspects(
  wire: readonly WireMeetupAspect[],
): readonly MeetupAspect[] | undefined {
  if (wire.length === 0) return undefined;
  const aspects: MeetupAspect[] = [];
  for (const value of wire) {
    const aspect = toAspect(value);
    if (aspect === undefined) return undefined;
    if (!aspects.includes(aspect)) aspects.push(aspect);
  }
  return aspects;
}

function toAspect(value: WireMeetupAspect): MeetupAspect | undefined {
  switch (value) {
    case WireMeetupAspect.UNSPECIFIED:
      return undefined;
    case WireMeetupAspect.TITLE:
      return "title";
    case WireMeetupAspect.DESCRIPTION:
      return "description";
    case WireMeetupAspect.VENUE:
      return "venue";
    case WireMeetupAspect.KIND:
      return "kind";
    case WireMeetupAspect.CALENDAR_LINK:
      return "calendar-link";
    case WireMeetupAspect.SCHEDULE:
      return "schedule";
    case WireMeetupAspect.LIFECYCLE:
      return "lifecycle";
    case WireMeetupAspect.VISIBILITY:
      return "visibility";
    default:
      return "other";
  }
}

function toLifecycle(
  value: WireMeetupLifecycle | undefined,
): MeetupLifecycle | undefined {
  switch (value) {
    case WireMeetupLifecycle.PLANNED:
      return "planned";
    case WireMeetupLifecycle.HELD:
      return "held";
    case WireMeetupLifecycle.CANCELLED:
      return "cancelled";
    default:
      return undefined;
  }
}

function toVisibility(
  value: WireMeetupVisibility | undefined,
): MeetupVisibility | undefined {
  switch (value) {
    case WireMeetupVisibility.HIDDEN:
      return "hidden";
    case WireMeetupVisibility.VISIBLE:
      return "visible";
    default:
      return undefined;
  }
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
