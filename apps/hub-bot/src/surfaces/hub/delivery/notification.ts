import { fromBinary } from "@bufbuild/protobuf";
import {
  Circle,
  Preset,
  ApplicationQueue as WireQueue,
} from "../../../../gen/identity/v1/access_pb.js";
import {
  type DateValue,
  type Schedule,
  type LocalDateTime as WireLocalDateTime,
  MeetupLifecycle as WireMeetupLifecycle,
  MeetupVisibility as WireMeetupVisibility,
} from "../../../../gen/meetups/v1/meetups_pb.js";
import {
  type MeetupCard,
  type Notification,
  NotificationSchema,
  MeetupAspect as WireMeetupAspect,
} from "../../../../gen/notifications/v1/notifications_pb.js";
import {
  type DeliveryNotification as ChannelNotification,
  type DecodeResult,
  type OtherBranch,
  toDeliveryNotification,
} from "../../../core/delivery/index.js";
import {
  type AuctionAnnouncementNotice,
  newAuctionNoticeOf,
  tradingOpenedNoticeOf,
} from "../../../core/notifications/auction-announcement-notice.js";
import {
  type AuctionCancelledNotice,
  auctionCancelledNoticeOf,
} from "../../../core/notifications/auction-cancelled-notice.js";
import {
  type FinalNotice,
  finalNoticeOf,
} from "../../../core/notifications/final-notice.js";
import {
  type LotNotice,
  lotNoticeOf,
} from "../../../core/notifications/lot-notice.js";
import {
  type LotSetNotice,
  lotSetNoticeOf,
} from "../../../core/notifications/lot-set-notice.js";
  type PredictionResultsNotice,
  predictionResultsNoticeOf,
} from "../../../core/notifications/prediction-results-notice.js";
import {
  type RaffleNotice,
  raffleNoticeOf,
} from "../../../core/notifications/raffle-notice.js";
import {
  type StepWindowNotice,
  stepWindowNoticeOf,
} from "../../../core/notifications/step-window-notice.js";
import type { ApplicationCursor } from "../identity/port.js";

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

// Ветки, которые рисует бот хаба. Ветка, которой канал не рисует, — из схемы
// новее этой сборки или ещё не нарисованная, — доезжает до решения явным
// вариантом пакета доставки (OtherBranch), а не пропадает на разборе: контракт
// запрещает доставлять неизвестное молча.
export type RenderableContent =
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
  // Ручные рассылки несут текст автора дословно; отправителя канал не
  // получает и не называет: имя не входит в контракт личности.
  | { kind: "organizer-message"; meetup: NotifiedMeetup; body: string }
  | { kind: "community-announcement"; body: string }
  // Заявку на доступ получает администратор. Заявителя контракт не несёт: кто
  // просит, бот читает при доставке из очереди правами получателя по курсору
  // заявки (PER-634). Курсора нет у факта, который старше него.
  | {
      kind: "access-requested";
      queue: ApplicationQueue;
      application?: SubmittedApplication;
    }
  // Допуск в хаб получает сам заявитель (PER-442). Очередь здесь всегда
  // сообщества: допуск в аукцион доставляет бот аукциона.
  | { kind: "access-granted" }
  // Выданный набор — сегодня только администратора (PER-468, RFC-016).
  // Получает сам человек; кто выдал, контракт не несёт.
  | { kind: "preset-granted"; preset: "admin" }
  // Аукционные факты об участнике сообщества доставляет бот хаба (ADR-064):
  // перебитие, ответ автоставки, покупку и сводку — те же, что у бота аукциона
  // (PER-598).
  | LotNotice
  // Анонс состава и старта финала (PER-478) — тот же, что у бота аукциона.
  | FinalNotice
  // Итог розыгрыша среди участников (PER-620) — тот же, что у бота аукциона.
  | RaffleNotice
  | PredictionResultsNotice
  // Извещение об отмене аукциона (PER-604, PER-606) — то же, что у бота
  // аукциона.
  | AuctionCancelledNotice
  // Начало окна «Счастливых часов» на отмеченных лотах (PER-616) — то же,
  // что у бота аукциона.
  | StepWindowNotice
  // Вести о новом аукционе и об открытии торгов (PER-646) — те же, что у бота
  // аукциона.
  | AuctionAnnouncementNotice
  // Собранный сет (PER-687): одно сообщение собравшему, состав по следу на
  // существующий экран сета.
  | LotSetNotice
  // Понижение участника до гостя (PER-537): о смене круга сообщает прежний бот
  // — этот (RFC-015, С-12). Ссылку на бот аукциона он вручает сам; факт её не
  // несёт (PER-536), и она приходит не из ветки, а из настройки бота.
  | { kind: "circle-demoted" }
  | {
      kind: "release-summary";
      summaryId: string;
      summarizedAt: string;
      recordIds: readonly string[];
    };

// Очереди, в которые ставят заявку: сообщество и аукцион.
export type ApplicationQueue = "community" | "auction";

// Курсор заявки, о которой оповещение: идентификатор и момент создания, по
// которым Identity отдаёт её карточку из очереди.
export type SubmittedApplication = ApplicationCursor;

export type NotificationContent = RenderableContent | OtherBranch;

export type DeliveryNotification = ChannelNotification<RenderableContent>;

// Сообщение шины — ввод соседа: формат проверил рантайм Protobuf, а инварианты
// конверта, которые схема выразить не может, проверяет пакет доставки.
// Нарушение — дефект издателя, и повтор его не лечит.
export function decodeNotification(
  data: Uint8Array,
): DecodeResult<RenderableContent> {
  let message: Notification;
  try {
    message = fromBinary(NotificationSchema, data);
  } catch (cause) {
    return {
      kind: "malformed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return toDeliveryNotification(message, toContent(message));
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
    case "organizerMessage": {
      const meetup = toMeetup(type.value.meetup);
      const body = toBody(type.value.body);
      return meetup === undefined || body === undefined
        ? undefined
        : { kind: "organizer-message", meetup, body };
    }
    case "communityAnnouncement": {
      const body = toBody(type.value.body);
      return body === undefined
        ? undefined
        : { kind: "community-announcement", body };
    }
    case "accessRequested": {
      const queue = toQueue(type.value.queue);
      if (queue === undefined) return undefined;
      const application = toSubmittedApplication(
        type.value.applicationId,
        type.value.createdAt,
      );
      return application === undefined
        ? { kind: "access-requested", queue }
        : { kind: "access-requested", queue, application };
    }
    // Допуск доставляет бот той поверхности, куда подана заявка: хаб — заявку
    // в сообщество, а допуск в аукцион для него чужой, как ветки торгов.
    case "accessGranted": {
      const queue = toQueue(type.value.queue);
      if (queue === undefined) return undefined;
      return queue === "community"
        ? { kind: "access-granted" }
        : { kind: "foreign", type: type.case };
    }
    // Набор администратора: Notifications шлёт ветку только для него, иной
    // набор — дефект издателя, а не новая весть.
    case "presetGranted":
      return type.value.preset === Preset.ADMIN
        ? { kind: "preset-granted", preset: "admin" }
        : undefined;
    // Смена круга (PER-537): до хаба доходит сторона понижения участника — её
    // он и доставляет. Повышение гостя адресовано боту аукциона (PER-536) и в
    // этот durable не попадает: subject у каналов свой, и маршрут выбирается по
    // прежнему кругу. Всё равно оно разбирается как чужое, а не как отказ.
    // Пустая или неизвестная пара кругов — дефект издателя: `guest ↔ member` —
    // единственные переходы, которые он рождает.
    case "circleChanged": {
      const { previousCircle, currentCircle } = type.value;
      if (previousCircle === Circle.MEMBER && currentCircle === Circle.GUEST) {
        return { kind: "circle-demoted" };
      }
      if (previousCircle === Circle.GUEST && currentCircle === Circle.MEMBER) {
        return { kind: "foreign", type: type.case };
      }
      return undefined;
    }
    case "lotOutbid":
    case "lotProxyRaised":
    case "lotLeadRestored":
    case "lotPurchased":
    case "lotActivityDigest":
    case "lotReminder":
    case "lotDeadlineClose":
    case "auctionFinalLotNext":
      return lotNoticeOf(type);
    case "auctionFinalLineup":
    case "auctionFinalStarted":
      return finalNoticeOf(type);
    case "raffleResult":
      return raffleNoticeOf(type.value);
    case "lotSetCollected":
      return lotSetNoticeOf(type.value);
    // Итоги прогнозов (PER-568): весть — фраза и кнопка. Списки номинаций
    // факт несёт, разбор их не читает: они остаются на экране.
    case "predictionResults":
      return predictionResultsNoticeOf(type.value);
    case "auctionCancelled":
      return auctionCancelledNoticeOf(type.value);
    // Начало окна «Счастливых часов» (PER-616): ветка своя, разбор общий —
    // право получателя и названия лотов читает общий рендер вести.
    case "stepWindowStarted":
      return stepWindowNoticeOf(type.value);
    case "auctionPublished":
      return newAuctionNoticeOf(type.value);
    case "auctionTradingOpened":
      return tradingOpenedNoticeOf(type.value);
    case "releaseSummary": {
      const { summaryId, summarizedAt, recordIds } = type.value;
      if (summaryId === "" || summarizedAt === "" || recordIds.length === 0) {
        return undefined;
      }
      return {
        kind: "release-summary",
        summaryId,
        summarizedAt,
        recordIds,
      };
    }
    default:
      return { kind: "unrendered", type: type.case ?? "unknown" };
  }
}

// Пустое тело контракт запрещает: у поля нет значения «не указано». Тело из
// одних пробелов он пропускает, и канал его не отвергает — под заголовком
// такой текст Telegram примет. Сам текст не нормализуется: он уходит как
// написан.
function toBody(body: string): string | undefined {
  return body === "" ? undefined : body;
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

// Курсор заявки из факта. Пустой — факт старше курсора, неразборчивый —
// дефект издателя; оба читаются отсутствием: оповещение теряет только тело
// заявки, а повод остаётся.
function toSubmittedApplication(
  applicationId: string,
  createdAt: string,
): SubmittedApplication | undefined {
  if (!canonicalUuid.test(applicationId)) return undefined;
  if (!applicationInstant.test(createdAt)) return undefined;
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs)
    ? { applicationId, createdAtMs }
    : undefined;
}

const canonicalUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Вид момента заявки по контракту — UTC с ровно миллисекундами. Иной вид —
// дефект издателя: курсор из него встал бы не на заявку, и открытая заявка
// показалась бы решённой.
const applicationInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Незнакомая или пустая очередь — дефект издателя.
function toQueue(value: WireQueue): ApplicationQueue | undefined {
  switch (value) {
    case WireQueue.COMMUNITY:
      return "community";
    case WireQueue.AUCTION:
      return "auction";
    default:
      return undefined;
  }
}
