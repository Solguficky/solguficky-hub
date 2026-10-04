import type {
  ArchivedMeetupSummary,
  MeetupMaterial,
  MeetupSchedule,
  MeetupSnapshot,
  MeetupSummary,
} from "../meetups/port.js";
import type {
  CategoryState,
  MeetupCategory,
  NotificationCategory,
} from "../notifications/port.js";

export type Person = { identityId: string; globalRoles: readonly string[] };
// Как карточка называет автора (PER-404): самому автору — «вы», остальным —
// ник, который Identity отдаёт только для действующего администратора.
// Отсутствие поля в результате — строки автора нет: ника нет, Identity
// отказал или не ответил.
export type MeetupAuthor =
  | { kind: "self" }
  | { kind: "organizer"; telegramUsername: string };
// `source` — ссылка канала прихода `s_<код>` (ADR-060, пункт 17). Код —
// недоверенный хвост без префикса: Identity сам решает, известен ли канал, и
// до него код доносит операция входа (PER-316).
export type DeepLink =
  | { kind: "meetup"; payload: string }
  | { kind: "source"; code: string }
  | { kind: "unclassified"; payload: string };
export type FormField = "title" | "schedule" | "venue" | "description";
// `unschedule` снимает назначенную публикацию: это не ось видимости, но
// механика та же — отдельное действие с подтверждением и повтором по версии.
export type MeetupStateAction = "unpublish" | "cancel" | "hold" | "unschedule";
// Почему вопрос о моменте публикации задан снова: ввод не разобран (E-02),
// момент уже прошёл (E-02 с отдельным текстом) или сходку успели изменить.
export type PublishMomentRetry = "unparsed" | "past" | "conflict";

export type ExecuteRequest =
  | { identity: Person; intent: "start"; deepLink?: DeepLink }
  | {
      identity: Person;
      intent: "list-visible-meetups";
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "list-archived-meetups";
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "view-meetup";
      meetupId: string;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "create-meetup";
      meetupId: string;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "set-meetup-field";
      field: FormField;
      value: string;
      meetupId: string;
      // Дату раньше сегодняшнего дня сообщества человек уже подтвердил:
      // вопрос о прошедшей дате второй раз не задаётся (PER-342).
      confirmedPast?: true;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "update-meetup-field";
      field: FormField;
      value: string;
      meetupId: string;
      confirmedPast?: true;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "publish-meetup";
      meetupId: string;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      // Момент приходит строкой, как его написал человек: разбор принадлежит
      // юзкейсу, чтобы отказ разбора и отказ домена жили в одном месте.
      identity: Person;
      intent: "schedule-publication";
      value: string;
      meetupId: string;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "change-meetup-state";
      action: MeetupStateAction;
      meetupId: string;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "attach-material";
      meetupId: string;
      material: MeetupMaterial;
      // Версия карточки, с которой человек начал действие: её несёт кнопка
      // подтверждения, а не чтение перед командой (PER-393).
      expectedVersion: number;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "remove-material";
      meetupId: string;
      materialId: string;
      expectedVersion: number;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | NotificationRequest
  | BroadcastRequest;

// Кому уходит рассылка, решает повод, а не автор: подписчикам одной сходки или
// кругу сообщества, который разворачивает Notifications. Списка получателей
// поверхность не видит и не передаёт.
export type BroadcastAudience =
  | { kind: "meetup"; meetupId: string }
  | { kind: "community" };

// `broadcastId` — ключ идемпотентности, рождённый в кнопке подтверждения:
// двойное нажатие и повтор после сбоя несут один и тот же ключ.
export type BroadcastRequest = {
  identity: Person;
  intent: "send-broadcast";
  audience: BroadcastAudience;
  broadcastId: string;
  body: string;
  requestId?: string;
  useCase?: string;
  deadlineAt?: number;
};

// Подписка и категории — две независимые плоскости, и намерения их не смешивают:
// «слежу за этой сходкой» не выводится из набора категорий и не выводит его.
export type NotificationRequest =
  | {
      identity: Person;
      intent: "view-global-notifications";
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "set-global-category";
      category: NotificationCategory;
      enabled: boolean;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "view-meetup-notifications";
      meetupId: string;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "set-meetup-subscription";
      meetupId: string;
      subscribed: boolean;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "set-meetup-category";
      meetupId: string;
      category: MeetupCategory;
      enabled: boolean;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    };

// Значение расходится с общей настройкой. Про существование переопределения это
// не говорит: `MeetupNotificationPreferences` намеренно не сообщает, чем
// получено значение, поэтому совпадающее переопределение неотличимо от
// наследования (docs/architecture/integration.md).
export type NotificationCategoryView = {
  category: MeetupCategory;
  enabled: boolean;
  differsFromGlobal: boolean;
};

export function startExecuteRequest(
  identity: Person,
  deepLink: DeepLink | undefined,
): ExecuteRequest {
  return deepLink === undefined
    ? { identity, intent: "start" }
    : { identity, intent: "start", deepLink };
}

export type ExecuteResult =
  | { kind: "message"; text: string }
  | { kind: "meetup-list"; meetups: readonly MeetupSummary[] }
  | { kind: "archived-meetup-list"; meetups: readonly ArchivedMeetupSummary[] }
  // `subscribed` отсутствует, когда Notifications не ответил или не настроен:
  // состояние подписки тогда не показывается вовсе, а не подставляется
  // устаревшим или выдуманным значением. `categories` — действующие значения
  // категорий сходки, их несёт только ответ на подписку: по ним карточка
  // называет, что будет приходить (PER-402).
  | {
      kind: "meetup-card";
      meetup: MeetupSnapshot;
      subscribed?: boolean;
      categories?: readonly CategoryState<MeetupCategory>[];
      author?: MeetupAuthor;
    }
  | {
      kind: "meetup-notification-settings";
      meetup: MeetupSnapshot;
      subscribed: boolean;
      categories: readonly NotificationCategoryView[];
    }
  | {
      kind: "global-notification-settings";
      categories: readonly CategoryState<NotificationCategory>[];
    }
  | { kind: "meetup-not-found" }
  // `error` — текст для человека. `rejected` — отказ Meetups, из-за которого
  // вопрос задан заново: он идёт в запись границы, а не в ответ (PER-397).
  | {
      kind: "ask";
      field: FormField;
      meetup: MeetupSnapshot;
      error?: string;
      rejected?: unknown;
    }
  | {
      kind: "edit-ask";
      field: FormField;
      meetup: MeetupSnapshot;
      error?: string;
      rejected?: unknown;
    }
  // Черновик после принятого ответа формы создания: дальше человек сам
  // выбирает, какое поле заполнить, и публикует с того же экрана.
  | { kind: "draft"; meetup: MeetupSnapshot }
  // Введённая дата раньше сегодняшнего дня сообщества: сходка с ней сразу
  // уйдёт в архив. Команда в Meetups не отправлена и ждёт подтверждения.
  | {
      kind: "confirm-past-schedule";
      meetup: MeetupSnapshot;
      schedule: MeetupSchedule;
      editing?: true;
    }
  // `repeated` — сходка была видна уже в перечитанном снимке: Meetups принял
  // повтор без события, и нового факта публикации нет (E-09). `archived` —
  // дата сходки раньше сегодняшнего дня сообщества, и в «Ближайших» её нет.
  | {
      kind: "published";
      meetup: MeetupSnapshot;
      repeated?: true;
      archived?: true;
      author?: MeetupAuthor;
    }
  | {
      kind: "ask-publish-moment";
      meetup: MeetupSnapshot;
      retry?: PublishMomentRetry;
    }
  | {
      kind: "publication-scheduled";
      meetup: MeetupSnapshot;
      author?: MeetupAuthor;
    }
  // Назначить публикацию нельзя в текущем состоянии сходки: она уже
  // опубликована или отменена (FAILED_PRECONDITION). Снимок — перечитанный.
  | {
      kind: "publication-unavailable";
      meetup: MeetupSnapshot;
      author?: MeetupAuthor;
    }
  | {
      kind: "meetup-updated";
      meetup: MeetupSnapshot;
      archived?: true;
      author?: MeetupAuthor;
    }
  | {
      kind: "meetup-state-changed";
      action: MeetupStateAction;
      meetup: MeetupSnapshot;
      author?: MeetupAuthor;
    }
  | {
      kind: "meetup-state-unchanged";
      reason: "already-cancelled" | "already-hidden" | "not-scheduled";
      meetup: MeetupSnapshot;
    }
  // Рассылка принята, а не доставлена. `repeated` — этот ключ уже был принят
  // раньше, и второй раз сообщение не уходит (E-09).
  | {
      kind: "broadcast-accepted";
      audience: BroadcastAudience;
      repeated?: true;
    }
  | { kind: "material-attached"; meetup: MeetupSnapshot }
  | { kind: "material-removed"; meetup: MeetupSnapshot }
  | {
      kind: "edit-unavailable";
      reason: "cancelled";
      meetup: MeetupSnapshot;
    }
  | {
      // Версия показанного снимка разошлась: команда не применена, и человеку
      // показывают текущее состояние рядом с его несохранённым вводом (PER-78).
      // `action` заполнен для конфликта на смене состояния — там нет ни поля,
      // ни ввода, а подтвердить нужно то же действие, а не публикацию.
      kind: "conflict";
      meetup: MeetupSnapshot;
      field?: FormField;
      input?: string;
      editing?: boolean;
      action?: MeetupStateAction;
    }
  | {
      kind: "dependency-rejected";
      reason: "forbidden" | "conflict" | "timeout" | "unavailable";
    }
  | {
      kind: "dependency-rejected";
      reason: "invalid";
      cause: unknown;
      precondition?: true;
    }
  | { kind: "rejected"; reason: string };
