import { z } from "zod";
import type { FormField } from "../application/types.js";
import type {
  MeetupCategory,
  NotificationCategory,
} from "../notifications/port.js";

const CallbackSchema = z.string().max(64);
const TokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
const FormFieldSchema = z.enum(["title", "schedule", "venue", "description"]);

// Псевдонимы категорий, а не имена из сгенерированного enum: на данные кнопки
// у Telegram 64 байта, и `NOTIFICATION_CATEGORY_COMMUNITY_ANNOUNCEMENT` рядом с
// токеном сходки в них не помещается. Бриф зафиксировал `changes`, остальные
// собраны тем же правилом.
const MeetupCategorySchema = z.enum([
  "changes",
  "material",
  "reminder",
  "organizer",
]);
// Категории, о которых приходит уведомление по конкретной сходке. Напоминание
// выключается глобально (`v1:notify:off:reminder`): по сходке оно приходит один
// раз. Сообщения организатора канал пока не рисует, и кнопки для них нет.
const NotifiedMeetupCategorySchema = z.enum(["changes", "material"]);
export type NotifiedMeetupCategory = z.infer<
  typeof NotifiedMeetupCategorySchema
>;
const GlobalCategorySchema = z.enum([
  "published",
  "changes",
  "material",
  "reminder",
  "organizer",
  "announcement",
]);
// Кнопка несёт целевое состояние, а не переворот: у двух человек, нажавших на
// одну отрисовку, результат обязан совпасть.
const TargetStateSchema = z.enum(["0", "1"]);
// Режим формы, в которой спросили о прошедшей дате: `c` — создание, `e` —
// правка. От него зависит следующий шаг после ответа.
const FormModeSchema = z.enum(["c", "e"]);
// Прошедшая дата едет в кнопке подтверждения цифрами `ДДММГГГГЧЧММ`: так
// ответ не зависит от памяти процесса и переживает его рестарт, как вопросы
// правки, восстановимые по сущностям сообщения.
const PastScheduleSchema = z.string().regex(/^\d{12}$/);

// Ник едет в `callback_data` как есть, и обратно он доезжает только в этом
// алфавите и в этой длине: у Telegram на данные кнопки 64 байта, а длиннее 32
// символов ника не бывает. Экран сверяется с тем же выражением, что и разбор:
// кнопка, которую разбор потом назовёт сломанной, рисоваться не должна.
export const removableUsernamePattern = /^[A-Za-z0-9_]{1,32}$/;

export type CallbackAction =
  | { kind: "home" }
  | { kind: "hub" }
  | { kind: "archive" }
  | { kind: "manage-menu" }
  | { kind: "manage-hidden" }
  | { kind: "community" }
  | { kind: "ask-allowed-username" }
  | { kind: "admit-member"; token: string }
  | { kind: "block-member"; token: string }
  | { kind: "remove-allowed-username"; username: string }
  | { kind: "create-meetup"; token: string }
  | { kind: "publish-meetup"; token: string }
  | { kind: "manage-edit"; token: string }
  | { kind: "manage-field"; token: string; field: FormField }
  | { kind: "manage-status"; token: string }
  | { kind: "manage-publish"; token: string }
  | { kind: "manage-unpublish"; token: string }
  | { kind: "manage-confirm-unpublish"; token: string }
  | { kind: "manage-cancel"; token: string }
  | { kind: "manage-confirm-cancel"; token: string }
  | { kind: "manage-hold"; token: string }
  | { kind: "manage-confirm-hold"; token: string }
  | { kind: "manage-publish-later"; token: string }
  | { kind: "manage-unschedule"; token: string }
  | { kind: "manage-confirm-unschedule"; token: string }
  | {
      kind: "manage-confirm-past-schedule";
      token: string;
      editing: boolean;
      value: string;
    }
  | { kind: "manage-retry-past-schedule"; token: string; editing: boolean }
  | { kind: "manage-materials"; token: string; page?: number }
  | { kind: "begin-attach-material"; token: string }
  | { kind: "confirm-attach-material"; token: string; materialToken: string }
  | { kind: "remove-material"; token: string; materialToken: string }
  | { kind: "confirm-remove-material"; token: string; materialToken: string }
  | { kind: "open-material-file"; token: string; materialToken: string }
  | { kind: "view-meetup"; token: string }
  // Рассылка: вход из карточки сходки или из управления, затем подтверждение.
  // Ключ рассылки рождается в кнопке подтверждения, как ключ создания сходки,
  // а текст едет не в кнопке, а в сообщении предпросмотра, на которое кадр
  // подтверждения отвечает: 64 байта его не вместят.
  | { kind: "begin-meetup-broadcast"; token: string }
  | { kind: "begin-community-broadcast" }
  | { kind: "confirm-meetup-broadcast"; token: string; broadcastToken: string }
  | { kind: "confirm-community-broadcast"; broadcastToken: string }
  | { kind: "cancel-broadcast" }
  | { kind: "notify-global" }
  | {
      kind: "notify-set-global";
      category: NotificationCategory;
      enabled: boolean;
    }
  // Отключение категории прямо из уведомления. Отдельное действие, а не `gset`:
  // тот перерисовывает сообщение в экран настроек, и текст уведомления пропал
  // бы вместе с ним.
  | { kind: "notify-disable-global"; category: NotificationCategory }
  // То же отключение из уведомления об изменении или материале, но у одной
  // сходки: эти категории получают её подписчики, и настройка сходки сильнее
  // общей.
  | {
      kind: "notify-disable-meetup";
      token: string;
      category: NotifiedMeetupCategory;
    }
  | { kind: "notify-settings"; token: string }
  | { kind: "notify-subscription"; token: string; subscribed: boolean }
  | {
      kind: "notify-set-meetup";
      token: string;
      category: MeetupCategory;
      enabled: boolean;
    }
  | { kind: "outdated" }
  | { kind: "malformed" };

export function parseCallback(raw: unknown): CallbackAction {
  const parsed = CallbackSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed" };
  const parts = parsed.data.split(":");
  if (parts[0] !== "v1") return { kind: "outdated" };
  if (parsed.data === "v1:manage:menu") return { kind: "manage-menu" };
  if (parsed.data === "v1:manage:hidden") return { kind: "manage-hidden" };
  if (parsed.data === "v1:community:list") return { kind: "community" };
  if (parsed.data === "v1:community:allow")
    return { kind: "ask-allowed-username" };
  if (parsed.data === "v1:nav:start") return { kind: "home" };
  if (parsed.data === "v1:nav:hub") return { kind: "hub" };
  if (parsed.data === "v1:notify:global") return { kind: "notify-global" };
  if (parsed.data === "v1:nav:archive") return { kind: "archive" };
  if (parts.length === 3 && parts[1] === "view") {
    const viewToken = TokenSchema.safeParse(parts[2]);
    return viewToken.success
      ? { kind: "view-meetup", token: viewToken.data }
      : { kind: "malformed" };
  }
  if (parts[1] === "mm") {
    const meetupToken = TokenSchema.safeParse(parts[3]);
    if (!meetupToken.success) return { kind: "malformed" };
    if ((parts.length === 4 || parts.length === 5) && parts[2] === "list") {
      if (parts[4] === undefined) {
        return { kind: "manage-materials", token: meetupToken.data };
      }
      const page = z.coerce.number().int().nonnegative().safeParse(parts[4]);
      return page.success
        ? { kind: "manage-materials", token: meetupToken.data, page: page.data }
        : { kind: "malformed" };
    }
    if (parts.length === 4 && parts[2] === "add") {
      return { kind: "begin-attach-material", token: meetupToken.data };
    }
    const materialToken = TokenSchema.safeParse(parts[4]);
    if (!materialToken.success || parts.length !== 5) {
      return { kind: "malformed" };
    }
    switch (parts[2]) {
      case "confirm-add":
        return {
          kind: "confirm-attach-material",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      case "rm":
        return {
          kind: "remove-material",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      case "confirm-rm":
        return {
          kind: "confirm-remove-material",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      case "file":
        return {
          kind: "open-material-file",
          token: meetupToken.data,
          materialToken: materialToken.data,
        };
      default:
        return { kind: "malformed" };
    }
  }
  if (parts.length === 4 && parts[1] === "community") {
    const username = parts[3] ?? "";
    if (parts[2] === "remove" && removableUsernamePattern.test(username)) {
      return { kind: "remove-allowed-username", username };
    }
    const identityToken = TokenSchema.safeParse(parts[3]);
    if (!identityToken.success) return { kind: "malformed" };
    if (parts[2] === "admit")
      return { kind: "admit-member", token: identityToken.data };
    if (parts[2] === "block")
      return { kind: "block-member", token: identityToken.data };
  }
  // Домен `notify` разбирается до общей проверки ниже: она требует токен в
  // `parts[3]` и домен `manage`, а глобальный кадр токена не несёт вовсе.
  if (parts[1] === "notify") {
    return parseNotify(parts);
  }
  if (parts[1] === "bc") {
    return parseBroadcast(parts);
  }
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success || parts[1] !== "manage") {
    return { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "new")
    return { kind: "create-meetup", token: token.data };
  if (parts.length === 4 && parts[2] === "publish")
    return { kind: "publish-meetup", token: token.data };
  if (parts.length === 4 && parts[2] === "edit")
    return { kind: "manage-edit", token: token.data };
  if (parts.length === 5 && parts[2] === "field") {
    const field = FormFieldSchema.safeParse(parts[4]);
    return field.success
      ? { kind: "manage-field", token: token.data, field: field.data }
      : { kind: "malformed" };
  }
  if (parts.length === 6 && parts[2] === "past") {
    const mode = FormModeSchema.safeParse(parts[4]);
    const digits = PastScheduleSchema.safeParse(parts[5]);
    return mode.success && digits.success
      ? {
          kind: "manage-confirm-past-schedule",
          token: token.data,
          editing: mode.data === "e",
          value: pastScheduleValue(digits.data),
        }
      : { kind: "malformed" };
  }
  if (parts.length === 5 && parts[2] === "past-retry") {
    const mode = FormModeSchema.safeParse(parts[4]);
    return mode.success
      ? {
          kind: "manage-retry-past-schedule",
          token: token.data,
          editing: mode.data === "e",
        }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "status")
    return { kind: "manage-status", token: token.data };
  if (parts.length === 4 && parts[2] === "republish")
    return { kind: "manage-publish", token: token.data };
  if (parts.length === 4 && parts[2] === "unpublish")
    return { kind: "manage-unpublish", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-unpublish")
    return { kind: "manage-confirm-unpublish", token: token.data };
  if (parts.length === 4 && parts[2] === "cancel")
    return { kind: "manage-cancel", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-cancel")
    return { kind: "manage-confirm-cancel", token: token.data };
  if (parts.length === 4 && parts[2] === "hold")
    return { kind: "manage-hold", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-hold")
    return { kind: "manage-confirm-hold", token: token.data };
  if (parts.length === 4 && parts[2] === "publish-later")
    return { kind: "manage-publish-later", token: token.data };
  if (parts.length === 4 && parts[2] === "unschedule")
    return { kind: "manage-unschedule", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-unschedule")
    return { kind: "manage-confirm-unschedule", token: token.data };
  return { kind: "malformed" };
}

/// Цифры кнопки обратно в тот вид, в котором дату вводят: форма разбирает и
/// проверяет её тем же путём, что и ответ текстом.
function pastScheduleValue(digits: string): string {
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
}

function parseBroadcast(parts: readonly string[]): CallbackAction {
  if (parts.length === 3 && parts[2] === "c") {
    return { kind: "begin-community-broadcast" };
  }
  if (parts.length === 3 && parts[2] === "no") {
    return { kind: "cancel-broadcast" };
  }
  const first = TokenSchema.safeParse(parts[3]);
  if (!first.success) return { kind: "malformed" };
  if (parts.length === 4 && parts[2] === "m") {
    return { kind: "begin-meetup-broadcast", token: first.data };
  }
  if (parts.length === 4 && parts[2] === "cs") {
    return { kind: "confirm-community-broadcast", broadcastToken: first.data };
  }
  const second = TokenSchema.safeParse(parts[4]);
  if (parts.length === 5 && parts[2] === "ms" && second.success) {
    return {
      kind: "confirm-meetup-broadcast",
      token: first.data,
      broadcastToken: second.data,
    };
  }
  return { kind: "malformed" };
}

function parseNotify(parts: readonly string[]): CallbackAction {
  if (parts.length === 5 && parts[2] === "gset") {
    const category = GlobalCategorySchema.safeParse(parts[3]);
    const state = TargetStateSchema.safeParse(parts[4]);
    return category.success && state.success
      ? {
          kind: "notify-set-global",
          category: category.data,
          enabled: state.data === "1",
        }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "off") {
    const category = GlobalCategorySchema.safeParse(parts[3]);
    return category.success
      ? { kind: "notify-disable-global", category: category.data }
      : { kind: "malformed" };
  }
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success) return { kind: "malformed" };
  if (parts.length === 4 && parts[2] === "settings") {
    return { kind: "notify-settings", token: token.data };
  }
  if (parts.length === 5 && parts[2] === "moff") {
    const category = NotifiedMeetupCategorySchema.safeParse(parts[4]);
    return category.success
      ? {
          kind: "notify-disable-meetup",
          token: token.data,
          category: category.data,
        }
      : { kind: "malformed" };
  }
  if (parts.length === 5 && parts[2] === "sub") {
    const state = TargetStateSchema.safeParse(parts[4]);
    return state.success
      ? {
          kind: "notify-subscription",
          token: token.data,
          subscribed: state.data === "1",
        }
      : { kind: "malformed" };
  }
  if (parts.length === 6 && parts[2] === "set") {
    // Только категории, которые сходка может нести: `published` и
    // `announcement` сюда не проходят, и `INVALID_ARGUMENT` за них не платится.
    const category = MeetupCategorySchema.safeParse(parts[4]);
    const state = TargetStateSchema.safeParse(parts[5]);
    return category.success && state.success
      ? {
          kind: "notify-set-meetup",
          token: token.data,
          category: category.data,
          enabled: state.data === "1",
        }
      : { kind: "malformed" };
  }
  return { kind: "malformed" };
}
