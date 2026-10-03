import { z } from "zod";
import type { FormField } from "../application/types.js";
import type { CommunityDay } from "../community-time.js";
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
// раз.
const NotifiedMeetupCategorySchema = z.enum([
  "changes",
  "material",
  "organizer",
]);
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
// Чья дата выбирается кнопками: `c` — дата сходки в форме создания, `e` — в
// правке, `p` — момент отложенной публикации из «Статуса», `d` — он же с
// черновика. От источника зависит, куда возвращает «Отмена».
const WhenModeSchema = z.enum(["c", "e", "p", "d"]);
export type WhenMode = z.infer<typeof WhenModeSchema>;
/** Экран, с которого назначают отложенную публикацию. */
export type PublishOrigin = "status" | "draft";
// Прошедшая дата едет в кнопке подтверждения цифрами `ДДММГГГГЧЧММ`: так
// ответ не зависит от памяти процесса и переживает его рестарт, как вопросы
// правки, восстановимые по сущностям сообщения.
const PastScheduleSchema = z.string().regex(/^\d{12}$/);
// Страница списка в кнопке: только цифры, без пустой строки и экспоненты,
// которые `z.coerce.number()` принял бы за число.
const PageSchema = z
  .string()
  .regex(/^\d{1,4}$/)
  .transform(Number);
// Версия карточки, с которой человек начал действие с материалом. Её несёт
// кнопка подтверждения: `ca` — confirm-add, `cr` — confirm-remove, сжатые ради
// места. `v1:mm:ca:` с двумя токенами занимает 55 байт, и девять цифр — всё,
// что остаётся до 64 (PER-393).
const VersionSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/)
  .transform(Number);

// Ник едет в `callback_data` как есть, и обратно он доезжает только в этом
// алфавите и в этой длине: у Telegram на данные кнопки 64 байта, а длиннее 32
// символов ника не бывает. Экран сверяется с тем же выражением, что и разбор:
// кнопка, которую разбор потом назовёт сломанной, рисоваться не должна.
export const removableUsernamePattern = /^[A-Za-z0-9_]{1,32}$/;

// Откуда начато закрытие доступа: туда возвращают «Нет» и экран после него.
// Из очереди — со следующим человеком, из списка допущенных — со страницей.
export type BlockOrigin =
  | { kind: "pending"; next?: string }
  | { kind: "admitted"; page: number };

/** Сегмент `callback_data`: `p`, `p<токен>` или `a<страница>`. */
export function blockOriginData(origin: BlockOrigin): string {
  return origin.kind === "admitted"
    ? `a${origin.page}`
    : `p${origin.next ?? ""}`;
}

type PlainAction =
  | { kind: "home" }
  // Списки листаются: страница едет в кнопке листания, без неё — первая.
  | { kind: "hub"; page?: number }
  | { kind: "archive"; page?: number }
  | { kind: "manage-menu" }
  | { kind: "manage-hidden"; page?: number }
  | { kind: "community" }
  // Курсор очереди — токен человека, а не номер: очередь меняется.
  | { kind: "community-pending"; cursor?: string }
  | { kind: "community-admitted"; page: number }
  | { kind: "community-usernames"; page: number }
  | { kind: "ask-allowed-username" }
  // `next` — кого показать после допуска.
  | { kind: "admit-member"; token: string; next?: string }
  | { kind: "ask-block-member"; token: string; origin: BlockOrigin }
  | { kind: "block-member"; token: string; origin: BlockOrigin }
  | { kind: "remove-allowed-username"; username: string; page: number }
  // Отказанные: токен — заявки, а не человека; страница — куда вернуть список.
  | { kind: "refused-applications"; page: number }
  | { kind: "ask-reconsider"; token: string; page: number }
  | { kind: "reconsider"; token: string; page: number }
  | { kind: "create-meetup"; token: string }
  | { kind: "publish-meetup"; token: string }
  | { kind: "manage-edit"; token: string }
  | { kind: "manage-field"; token: string; field: FormField }
  // Черновик формы создания: без поля — сам экран, с полем — вопрос о нём.
  | { kind: "manage-draft"; token: string; field?: FormField }
  | { kind: "manage-status"; token: string }
  | { kind: "manage-publish"; token: string }
  | { kind: "manage-unpublish"; token: string }
  | { kind: "manage-confirm-unpublish"; token: string }
  | { kind: "manage-cancel"; token: string }
  | { kind: "manage-confirm-cancel"; token: string }
  | { kind: "manage-hold"; token: string }
  | { kind: "manage-confirm-hold"; token: string }
  | { kind: "manage-publish-later"; token: string; origin: PublishOrigin }
  | { kind: "manage-unschedule"; token: string }
  | { kind: "manage-confirm-unschedule"; token: string }
  | {
      kind: "manage-confirm-past-schedule";
      token: string;
      editing: boolean;
      value: string;
    }
  | { kind: "manage-retry-past-schedule"; token: string; editing: boolean }
  // Экран выбора даты: без дня — выбор дня, с днём — выбор времени.
  | {
      kind: "manage-pick-day";
      token: string;
      mode: WhenMode;
      picked?: { digits: string; day: CommunityDay };
    }
  // Кнопка времени — полный ответ о дате, в том виде, в котором дату вводят
  // текстом.
  | {
      kind: "manage-pick-schedule";
      token: string;
      mode: WhenMode;
      value: string;
    }
  // «Другая дата»: даты среди заготовок нет, и её спрашивают текстом.
  | { kind: "manage-type-schedule"; token: string; mode: WhenMode }
  | { kind: "manage-materials"; token: string; page?: number }
  | { kind: "begin-attach-material"; token: string }
  // «Нет» на подтверждении прикрепления: возврат к материалам, а сообщение с
  // файлом остаётся следом с подписью, что прикрепления не было.
  | { kind: "decline-attach-material"; token: string }
  // `version` отсутствует только у кнопки прошлого релиза, которая версии не
  // несла: команду по ней не отправить, и экран отвечает кадром конфликта.
  | {
      kind: "confirm-attach-material";
      token: string;
      materialToken: string;
      version?: number;
    }
  | { kind: "remove-material"; token: string; materialToken: string }
  | {
      kind: "confirm-remove-material";
      token: string;
      materialToken: string;
      version?: number;
    }
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
  // Токен — сходка, с карточки которой рассылку начали: по нему «Нет»
  // возвращает к ней; у объявления сообществу токена нет.
  | { kind: "cancel-broadcast"; token?: string }
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
  // «Отмена» под вопросом: кнопка несёт шаг вопроса. По нажатию вопрос
  // правится в экран, с которого задан, а по ответу бот читает шаг из
  // клавиатуры вопроса в `reply_to_message` — память процесса ему не нужна.
  | { kind: "question"; step: QuestionStep }
  | { kind: "outdated" }
  | { kind: "malformed" };

/** Что спросил вопрос: этого хватает, чтобы принять ответ на него. */
export type QuestionStep =
  | { kind: "field"; mode: "create" | "edit"; token: string; field: FormField }
  | { kind: "publish-moment"; token: string; origin: PublishOrigin }
  // Версия карточки, с которой начато прикрепление: она доезжает до кнопки
  // подтверждения и уходит в `expected_version` (PER-393).
  | { kind: "material-source"; token: string; version: number }
  // Источник файла в 64 байта не помещается, поэтому ответ на этот вопрос
  // принимается только по карте вопросов в памяти процесса; кнопка возвращает
  // к материалам.
  | { kind: "material-title"; token: string }
  | { kind: "broadcast"; token?: string }
  | { kind: "username" };

/** Данные кнопки «Отмена» для вопроса с этим шагом. */
export function questionData(step: QuestionStep): string {
  switch (step.kind) {
    case "field":
      return `v1:q:${step.mode === "edit" ? "fe" : "fc"}:${step.token}:${step.field}`;
    case "publish-moment":
      // `pd` — вопрос задан с черновика: «Отмена» возвращает на него.
      return `v1:q:${step.origin === "draft" ? "pd" : "pm"}:${step.token}`;
    case "material-source":
      return `v1:q:ms:${step.token}:${step.version}`;
    case "material-title":
      return `v1:q:mt:${step.token}`;
    case "broadcast":
      return step.token === undefined ? "v1:q:bc" : `v1:q:bm:${step.token}`;
    case "username":
      return "v1:q:nick";
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

// Кнопка под следом — уведомлением или сообщением «Доступ открыт» — несёт то же
// действие, что и кнопка экрана, с пометкой `t`: экран по ней приходит новым
// сообщением, а след остаётся в истории как был (дизайн-код, «Доставка»).
export type CallbackAction = PlainAction & { trace?: true };

const tracePrefix = "v1:t:";

/** Данные кнопки следа для действия, которое на экране несёт `data`. */
export function traceCallback(data: `v1:${string}`): string {
  return `${tracePrefix}${data.slice("v1:".length)}`;
}

export function parseCallback(raw: unknown): CallbackAction {
  const parsed = CallbackSchema.safeParse(raw);
  if (!parsed.success) return { kind: "malformed" };
  const parts = parsed.data.split(":");
  if (parts[0] !== "v1") return { kind: "outdated" };
  if (parsed.data.startsWith(tracePrefix)) {
    const inner = parseCallback(`v1:${parsed.data.slice(tracePrefix.length)}`);
    return inner.kind === "malformed" || inner.kind === "outdated"
      ? inner
      : { ...inner, trace: true };
  }
  if (parsed.data === "v1:manage:menu") return { kind: "manage-menu" };
  if (parsed.data === "v1:manage:hidden") return { kind: "manage-hidden" };
  if (parsed.data === "v1:community:list") return { kind: "community" };
  if (parsed.data === "v1:community:allow")
    return { kind: "ask-allowed-username" };
  if (parsed.data === "v1:nav:start") return { kind: "home" };
  if (parsed.data === "v1:nav:hub") return { kind: "hub" };
  if (parsed.data === "v1:notify:global") return { kind: "notify-global" };
  if (parsed.data === "v1:nav:archive") return { kind: "archive" };
  if (parts[1] === "q") {
    const step = parseQuestionStep(parts);
    return step === undefined
      ? { kind: "malformed" }
      : { kind: "question", step };
  }
  const listed = parseListPage(parts);
  if (listed !== undefined) return listed;
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
      const page = PageSchema.safeParse(parts[4]);
      return page.success
        ? { kind: "manage-materials", token: meetupToken.data, page: page.data }
        : { kind: "malformed" };
    }
    if (parts.length === 4 && parts[2] === "add") {
      return { kind: "begin-attach-material", token: meetupToken.data };
    }
    if (parts.length === 4 && parts[2] === "no") {
      return { kind: "decline-attach-material", token: meetupToken.data };
    }
    const materialToken = TokenSchema.safeParse(parts[4]);
    if (!materialToken.success) return { kind: "malformed" };
    // Подтверждения несут версию шестым сегментом. Прежние `confirm-add` и
    // `confirm-rm` версии не несли, и Meetups отвергал их с 22.09: такая кнопка
    // разбирается без версии, и экран перечитывает карточку вместо команды.
    if (parts.length === 6 && (parts[2] === "ca" || parts[2] === "cr")) {
      const version = VersionSchema.safeParse(parts[5]);
      if (!version.success) return { kind: "malformed" };
      return {
        kind:
          parts[2] === "ca"
            ? "confirm-attach-material"
            : "confirm-remove-material",
        token: meetupToken.data,
        materialToken: materialToken.data,
        version: version.data,
      };
    }
    if (parts.length !== 5) return { kind: "malformed" };
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
  if (parts[1] === "cm") {
    return parseCommunity(parts);
  }
  // Кнопки состава одним списком из прошлого релиза. «Закрыть» там исполнялось
  // сразу; теперь та же кнопка ведёт в подтверждение, как и новая.
  if (parts.length === 4 && parts[1] === "community") {
    const username = parts[3] ?? "";
    if (parts[2] === "remove" && removableUsernamePattern.test(username)) {
      return { kind: "remove-allowed-username", username, page: 0 };
    }
    const identityToken = TokenSchema.safeParse(parts[3]);
    if (!identityToken.success) return { kind: "malformed" };
    if (parts[2] === "admit")
      return { kind: "admit-member", token: identityToken.data };
    if (parts[2] === "block")
      return {
        kind: "ask-block-member",
        token: identityToken.data,
        origin: { kind: "admitted", page: 0 },
      };
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
  if (parts.length === 4 && parts[2] === "draft")
    return { kind: "manage-draft", token: token.data };
  if (parts.length === 5 && parts[2] === "draft") {
    const field = FormFieldSchema.safeParse(parts[4]);
    return field.success
      ? { kind: "manage-draft", token: token.data, field: field.data }
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
  if ((parts.length === 5 || parts.length === 6) && parts[2] === "when") {
    const parsedMode = WhenModeSchema.safeParse(parts[4]);
    if (!parsedMode.success) return { kind: "malformed" };
    const mode = parsedMode.data;
    const digits = parts[5];
    if (digits === undefined) {
      return { kind: "manage-pick-day", token: token.data, mode };
    }
    if (digits === "t") {
      return { kind: "manage-type-schedule", token: token.data, mode };
    }
    // «Отмена» экрана выбора даты — обычный возврат на экран, с которого дату
    // открыли: режима ответа у него нет, и снимать нечего.
    if (digits === "x") {
      return mode === "e"
        ? { kind: "view-meetup", token: token.data }
        : mode === "p"
          ? { kind: "manage-status", token: token.data }
          : { kind: "manage-draft", token: token.data };
    }
    const day = dayFromDigits(digits.slice(0, 8));
    if (day === undefined) return { kind: "malformed" };
    if (digits.length === 8) {
      return {
        kind: "manage-pick-day",
        token: token.data,
        mode,
        picked: { digits, day },
      };
    }
    return PastScheduleSchema.safeParse(digits).success
      ? {
          kind: "manage-pick-schedule",
          token: token.data,
          mode,
          value: pastScheduleValue(digits),
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
    return {
      kind: "manage-publish-later",
      token: token.data,
      origin: "status",
    };
  // `d` — кнопка стоит на черновике: «Отмена» вернёт на него, а не в «Статус».
  if (parts.length === 5 && parts[2] === "publish-later" && parts[4] === "d")
    return { kind: "manage-publish-later", token: token.data, origin: "draft" };
  if (parts.length === 4 && parts[2] === "unschedule")
    return { kind: "manage-unschedule", token: token.data };
  if (parts.length === 4 && parts[2] === "confirm-unschedule")
    return { kind: "manage-confirm-unschedule", token: token.data };
  return { kind: "malformed" };
}

function parseQuestionStep(parts: readonly string[]): QuestionStep | undefined {
  if (parts.length === 3 && parts[2] === "bc") return { kind: "broadcast" };
  if (parts.length === 3 && parts[2] === "nick") return { kind: "username" };
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success) return undefined;
  if (parts.length === 4) {
    switch (parts[2]) {
      case "pm":
        return { kind: "publish-moment", token: token.data, origin: "status" };
      case "pd":
        return { kind: "publish-moment", token: token.data, origin: "draft" };
      case "mt":
        return { kind: "material-title", token: token.data };
      case "bm":
        return { kind: "broadcast", token: token.data };
      default:
        return undefined;
    }
  }
  if (parts.length !== 5) return undefined;
  if (parts[2] === "ms") {
    const version = VersionSchema.safeParse(parts[4]);
    return version.success
      ? { kind: "material-source", token: token.data, version: version.data }
      : undefined;
  }
  if (parts[2] === "fe" || parts[2] === "fc") {
    const field = FormFieldSchema.safeParse(parts[4]);
    return field.success
      ? {
          kind: "field",
          mode: parts[2] === "fe" ? "edit" : "create",
          token: token.data,
          field: field.data,
        }
      : undefined;
  }
  return undefined;
}

// Кнопка листания: `v1:nav:hub:<страница>`, `v1:nav:archive:<страница>`,
// `v1:manage:hidden:<страница>`. Страница за пределами списка — не ошибка
// разбора: экран откроет последнюю.
function parseListPage(parts: readonly string[]): CallbackAction | undefined {
  if (parts.length !== 4) return undefined;
  const kind =
    parts[1] === "nav" && parts[2] === "hub"
      ? "hub"
      : parts[1] === "nav" && parts[2] === "archive"
        ? "archive"
        : parts[1] === "manage" && parts[2] === "hidden"
          ? "manage-hidden"
          : undefined;
  if (kind === undefined) return undefined;
  const page = PageSchema.safeParse(parts[3]);
  return page.success ? { kind, page: page.data } : { kind: "malformed" };
}

/// День из цифр кнопки `ДДММГГГГ`; день, которого нет в календаре, —
/// `undefined`: такую кнопку бот не рисовал.
function dayFromDigits(digits: string): CommunityDay | undefined {
  if (!/^\d{8}$/.test(digits)) return undefined;
  const day = {
    year: Number(digits.slice(4, 8)),
    month: Number(digits.slice(2, 4)),
    day: Number(digits.slice(0, 2)),
  };
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day));
  return date.getUTCFullYear() === day.year &&
    date.getUTCMonth() + 1 === day.month &&
    date.getUTCDate() === day.day
    ? day
    : undefined;
}

/// Цифры кнопки обратно в тот вид, в котором дату вводят: форма разбирает и
/// проверяет её тем же путём, что и ответ текстом.
function pastScheduleValue(digits: string): string {
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4, 8)} ${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
}

function parseBlockOrigin(raw: string | undefined): BlockOrigin | undefined {
  if (raw === "p") return { kind: "pending" };
  if (raw?.startsWith("p")) {
    const next = TokenSchema.safeParse(raw.slice(1));
    return next.success ? { kind: "pending", next: next.data } : undefined;
  }
  if (raw?.startsWith("a")) {
    const page = PageSchema.safeParse(raw.slice(1));
    return page.success ? { kind: "admitted", page: page.data } : undefined;
  }
  return undefined;
}

// Подэкраны состава: `p` — очередь, `a` — допущенные, `u` — ники, `ad` —
// допустить, `bq` и `by` — вопрос о закрытии доступа и его «Да», `rm` — убрать
// ник. Отказанные: `r` — список, `rq` и `ry` — вопрос о пересмотре и его «Да»;
// токен у них — заявки, а не человека. Имена сжаты: `ad` и `by` несут двух людей и с длинным доменом вышли бы
// ровно в 64 байта.
function parseCommunity(parts: readonly string[]): CallbackAction {
  const malformed = { kind: "malformed" } as const;
  if (parts.length > 5) return malformed;
  const [, , verb, first, second] = parts;
  switch (verb) {
    case "p": {
      if (second !== undefined) return malformed;
      if (first === undefined) return { kind: "community-pending" };
      const cursor = TokenSchema.safeParse(first);
      return cursor.success
        ? { kind: "community-pending", cursor: cursor.data }
        : malformed;
    }
    case "a":
    case "u":
    case "r": {
      if (second !== undefined) return malformed;
      const page = PageSchema.safeParse(first ?? "0");
      if (!page.success) return malformed;
      return {
        kind:
          verb === "a"
            ? "community-admitted"
            : verb === "u"
              ? "community-usernames"
              : "refused-applications",
        page: page.data,
      };
    }
    case "rq":
    case "ry": {
      const token = TokenSchema.safeParse(first);
      const page = PageSchema.safeParse(second);
      if (!token.success || !page.success) return malformed;
      return {
        kind: verb === "rq" ? "ask-reconsider" : "reconsider",
        token: token.data,
        page: page.data,
      };
    }
    case "ad": {
      const token = TokenSchema.safeParse(first);
      if (!token.success) return malformed;
      if (second === undefined) {
        return { kind: "admit-member", token: token.data };
      }
      const next = TokenSchema.safeParse(second);
      return next.success
        ? { kind: "admit-member", token: token.data, next: next.data }
        : malformed;
    }
    case "bq":
    case "by": {
      const token = TokenSchema.safeParse(first);
      const origin = parseBlockOrigin(second);
      if (!token.success || origin === undefined) return malformed;
      return {
        kind: verb === "bq" ? "ask-block-member" : "block-member",
        token: token.data,
        origin,
      };
    }
    case "rm": {
      const page = PageSchema.safeParse(first);
      if (
        !page.success ||
        second === undefined ||
        !removableUsernamePattern.test(second)
      ) {
        return malformed;
      }
      return {
        kind: "remove-allowed-username",
        username: second,
        page: page.data,
      };
    }
    default:
      return malformed;
  }
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
  if (parts.length === 4 && parts[2] === "no") {
    return { kind: "cancel-broadcast", token: first.data };
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
