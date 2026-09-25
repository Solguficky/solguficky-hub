import type {
  ArchivedMeetupSummary,
  MeetupMaterial,
  MeetupSnapshot,
  MeetupSummary,
} from "../meetups/port.js";
import type {
  CategoryState,
  MeetupCategory,
  NotificationCategory,
} from "../notifications/port.js";

export type Person = { identityId: string; globalRoles: readonly string[] };
export type DeepLink =
  | { kind: "meetup"; payload: string }
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
    }
  | {
      identity: Person;
      intent: "list-archived-meetups";
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "view-meetup";
      meetupId: string;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "create-meetup";
      meetupId: string;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "set-meetup-field";
      field: FormField;
      value: string;
      meetupId: string;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "update-meetup-field";
      field: FormField;
      value: string;
      meetupId: string;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "publish-meetup";
      meetupId: string;
      requestId?: string;
      useCase?: string;
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
    }
  | {
      identity: Person;
      intent: "change-meetup-state";
      action: MeetupStateAction;
      meetupId: string;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "attach-material";
      meetupId: string;
      material: MeetupMaterial;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "remove-material";
      meetupId: string;
      materialId: string;
      requestId?: string;
      useCase?: string;
    }
  | NotificationRequest;

// Подписка и категории — две независимые плоскости, и намерения их не смешивают:
// «слежу за этой сходкой» не выводится из набора категорий и не выводит его.
export type NotificationRequest =
  | {
      identity: Person;
      intent: "view-global-notifications";
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "set-global-category";
      category: NotificationCategory;
      enabled: boolean;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "view-meetup-notifications";
      meetupId: string;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "set-meetup-subscription";
      meetupId: string;
      subscribed: boolean;
      requestId?: string;
      useCase?: string;
    }
  | {
      identity: Person;
      intent: "set-meetup-category";
      meetupId: string;
      category: MeetupCategory;
      enabled: boolean;
      requestId?: string;
      useCase?: string;
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
  // устаревшим или выдуманным значением.
  | { kind: "meetup-card"; meetup: MeetupSnapshot; subscribed?: boolean }
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
  | { kind: "ask"; field: FormField; meetup: MeetupSnapshot; error?: string }
  | {
      kind: "edit-ask";
      field: FormField;
      meetup: MeetupSnapshot;
      error?: string;
    }
  | { kind: "preview"; meetup: MeetupSnapshot }
  // `repeated` — сходка была видна уже в перечитанном снимке: Meetups принял
  // повтор без события, и нового факта публикации нет (E-09).
  | { kind: "published"; meetup: MeetupSnapshot; repeated?: true }
  | {
      kind: "ask-publish-moment";
      meetup: MeetupSnapshot;
      retry?: PublishMomentRetry;
    }
  | { kind: "publication-scheduled"; meetup: MeetupSnapshot }
  // Назначить публикацию нельзя в текущем состоянии сходки: она уже
  // опубликована или отменена (FAILED_PRECONDITION). Снимок — перечитанный.
  | { kind: "publication-unavailable"; meetup: MeetupSnapshot }
  | { kind: "meetup-updated"; meetup: MeetupSnapshot }
  | {
      kind: "meetup-state-changed";
      action: MeetupStateAction;
      meetup: MeetupSnapshot;
    }
  | {
      kind: "meetup-state-unchanged";
      reason: "already-cancelled" | "already-hidden" | "not-scheduled";
      meetup: MeetupSnapshot;
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
  | { kind: "dependency-rejected"; reason: "invalid"; message: string }
  | { kind: "rejected"; reason: string };
