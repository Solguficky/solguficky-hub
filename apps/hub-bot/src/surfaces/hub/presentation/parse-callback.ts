import { z } from "zod";
import type {
  ConsoleSort,
  FormField,
  LotTextField,
} from "../application/types.js";
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
  "access",
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
const ConsoleSortSchema = z.enum(["bd", "ba", "pd", "pa", "gd", "ga"]);
export const defaultConsoleSort: ConsoleSort = {
  metric: "bids",
  direction: "descending",
};

function consoleSortToken(sort: ConsoleSort): string {
  const metric =
    sort.metric === "bids" ? "b" : sort.metric === "participants" ? "p" : "g";
  return `${metric}${sort.direction === "descending" ? "d" : "a"}`;
}

function parseConsoleSort(raw: string | undefined): ConsoleSort | undefined {
  const parsed = ConsoleSortSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  switch (parsed.data) {
    case "bd":
      return defaultConsoleSort;
    case "ba":
      return { metric: "bids", direction: "ascending" };
    case "pd":
      return { metric: "participants", direction: "descending" };
    case "pa":
      return { metric: "participants", direction: "ascending" };
    case "gd":
      return { metric: "growth", direction: "descending" };
    case "ga":
      return { metric: "growth", direction: "ascending" };
  }
  return undefined;
}
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

// Место карточки заявки в кнопке: токен заявки и момент её создания в
// миллисекундах. Вместе это курсор очереди Identity, а не номер: очередь
// меняется, пока карточка висит.
export type CardCursor = { token: string; createdAtMs: number };

// Десять знаков base36 — до 3,6·10¹⁵ мс, внутри диапазона Date (8,64·10¹⁵):
// подделанный момент длиннее не дойдёт до toISOString и не уронит запрос.
const MillisSchema = z.string().regex(/^[0-9a-z]{1,10}$/);

/** Сегменты `callback_data`: `<токен>:<момент base36>`. */
export function cardCursorData(cursor: CardCursor): string {
  return `${cursor.token}:${cursor.createdAtMs.toString(36)}`;
}

function parseCardCursor(
  token: string | undefined,
  millis: string | undefined,
): CardCursor | undefined {
  const parsedToken = TokenSchema.safeParse(token);
  const parsedMillis = MillisSchema.safeParse(millis);
  if (!parsedToken.success || !parsedMillis.success) return undefined;
  const createdAtMs = Number.parseInt(parsedMillis.data, 36);
  return Number.isSafeInteger(createdAtMs)
    ? { token: parsedToken.data, createdAtMs }
    : undefined;
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
  // Каналы прихода (ADR-060, пункт 18): список со ссылками и вопрос о новом.
  | { kind: "source-channels"; page: number }
  | { kind: "ask-source-channel" }
  // Карточка заявки: без курсора — первая в очереди, `after` — следующая за
  // курсором («Пропустить»), `at` — та же, если она ещё открыта.
  | { kind: "application-card"; cursor?: CardCursor; from?: "after" | "at" }
  | { kind: "admit-application"; cursor: CardCursor }
  | { kind: "ask-decline-application"; cursor: CardCursor }
  | { kind: "decline-application"; cursor: CardCursor }
  | { kind: "create-meetup"; token: string }
  | { kind: "publish-meetup"; token: string }
  | { kind: "manage-edit"; token: string }
  | { kind: "manage-field"; token: string; field: FormField }
  // Черновик формы создания: без поля — сам экран, с полем — вопрос о нём.
  | { kind: "manage-draft"; token: string; field?: FormField }
  | { kind: "manage-status"; token: string }
  // «Включить аукцион» на карточке сходки (PER-307). Кнопки входа в аукцион
  // здесь нет: она домена `auc`, и её пишет и разбирает аукционное дерево.
  | { kind: "manage-auction"; token: string }
  | { kind: "auction-faq"; auction: string }
  // Форма лота администратора (PER-319). Кнопки несут лот, а новый лот —
  // аукцион: сходку форма не называет, её знает Auction.
  | { kind: "lot-new"; auction: string }
  | { kind: "lot-form"; lot: string }
  | { kind: "lot-ask"; lot: string; field: LotFormField }
  // Пульт аукциона администратора (PER-320). Кнопки несут аукцион, а отметка
  // финала — ещё лот и страницу пульта, на которую вернуться.
  | { kind: "console-view"; auction: string; page: number; sort: ConsoleSort }
  | { kind: "console-week"; auction: string }
  | { kind: "console-final"; auction: string; final: boolean }
  | { kind: "console-open"; auction: string }
  // «Да» подтверждения: ключ открытия рождён, когда подтверждение показано,
  // и повторное нажатие несёт тот же.
  | { kind: "console-confirm"; auction: string; op: string }
  | {
      kind: "console-mark";
      auction: string;
      lot: string;
      selected: boolean;
      page: number;
      sort: ConsoleSort;
    }
  | { kind: "manage-publish"; token: string }
  | { kind: "manage-unpublish"; token: string }
  | { kind: "manage-confirm-unpublish"; token: string; version?: number }
  | { kind: "manage-cancel"; token: string }
  | { kind: "manage-confirm-cancel"; token: string; version?: number }
  | { kind: "manage-hold"; token: string }
  | { kind: "manage-confirm-hold"; token: string; version?: number }
  | { kind: "manage-publish-later"; token: string; origin: PublishOrigin }
  | { kind: "manage-unschedule"; token: string }
  | { kind: "manage-confirm-unschedule"; token: string; version?: number }
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
  // «Отмена» под вопросом: кнопка несёт шаг вопроса и Telegram id того, кому
  // он задан. По нажатию вопрос правится в экран, с которого задан, а по ответу
  // бот читает шаг из клавиатуры вопроса в `reply_to_message` — память процесса
  // ему не нужна. Кнопка прошлого релиза id не несёт: «Отмена» на ней работает,
  // а ответ на такой вопрос устарел (PER-461).
  | { kind: "question"; step: QuestionStep; askedBy?: number }
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
  | { kind: "username" }
  // Код канала в 64 байта рядом с префиксом не помещается, поэтому подпись,
  // как название материала, принимается только по карте вопросов в памяти.
  | { kind: "channel-code" }
  | { kind: "channel-label" }
  // Вопросы формы лота (PER-319). Идентификатор нового лота рождён до вопроса
  // и едет в нём: ответ после рестарта создаёт тот же лот, а не второй. Вопрос
  // о шаге несёт цену из предыдущего ответа в целых рублях — в Auction они
  // уходят одной командой. Самая длинная строка — `ln`, 53 байта.
  // `key` — ключ создания, а не токен лота: см. `new-lot-id.ts`.
  | { kind: "lot-new"; auction: string; key: string }
  | { kind: "lot-text"; lot: string; field: LotTextField }
  | { kind: "lot-price"; lot: string }
  | { kind: "lot-step"; lot: string; price: number }
  | { kind: "lot-image"; lot: string }
  // Сроки онлайн-недели на пульте (PER-320): аукцион, а финал и текущие сроки
  // ответ читает у Auction заново.
  | { kind: "console-week"; auction: string };

/** Ряд экрана правки лота: текст карточки, фото либо цена с шагом, парой. */
export type LotFormField = LotTextField | "image" | "price";

const LotFormFieldSchema = z.enum(["title", "description", "image", "price"]);
// Ключ создания лота: двенадцать символов вместо двадцати двух у токена.
const LotKeySchema = z.string().regex(/^[A-Za-z0-9_-]{12}$/);
// Цена в рублях в кнопке вопроса о шаге: от 1 до 9 999 999, без ведущих нулей,
// — та же граница, что у разбора ответа (`parseRubles`).
const RublesSchema = z
  .string()
  .regex(/^[1-9]\d{0,6}$/)
  .transform(Number);

/** Данные кнопки «Добавить лот» в ленте аукциона; аргумент — токен аукциона. */
export function lotNewData(auction: string): string {
  return `v1:lot:new:${auction}`;
}

/** Данные кнопки входа на экран правки лота; аргумент — токен лота. */
export function lotFormData(lot: string): string {
  return `v1:lot:form:${lot}`;
}

/** Данные кнопки ряда на экране правки лота. */
export function lotAskData(lot: string, field: LotFormField): string {
  return `v1:lot:ask:${lot}:${field}`;
}

// Кнопки пульта аукциона: `v1:ac:<действие>:<аукцион>[:…]`. Самая длинная —
// отметка финала с лотом и страницей, до 59 байт.

/** Пульт аукциона на странице `page`; первая страница — без номера. */
export function consoleViewData(
  auction: string,
  page = 0,
  sort: ConsoleSort = defaultConsoleSort,
): string {
  if (sort.metric === "bids" && sort.direction === "descending") {
    return page === 0 ? `v1:ac:v:${auction}` : `v1:ac:v:${auction}:${page}`;
  }
  return `v1:ac:v:${auction}:${page}:${consoleSortToken(sort)}`;
}

/** «Сроки недели»: вопрос о начале и конце онлайн-недели. */
export function consoleWeekData(auction: string): string {
  return `v1:ac:w:${auction}`;
}

/** Переключатель финала с целевым состоянием. */
export function consoleFinalData(auction: string, final: boolean): string {
  return `v1:ac:f:${auction}:${final ? "1" : "0"}`;
}

/** «Открыть онлайн-неделю»: подтверждение, а не команда. */
export function consoleOpenData(auction: string): string {
  return `v1:ac:o:${auction}`;
}

/** «Да» подтверждения открытия: аукцион и ключ команды. */
export function consoleConfirmData(auction: string, op: string): string {
  return `v1:ac:y:${auction}:${op}`;
}

/** Отметка лота для финала (`s`) или её снятие (`d`). */
export function consoleMarkData(mark: {
  auction: string;
  lot: string;
  selected: boolean;
  page: number;
  sort?: ConsoleSort;
}): string {
  const base = `v1:ac:${mark.selected ? "s" : "d"}:${mark.auction}:${mark.lot}:${mark.page}`;
  return mark.sort === undefined ||
    (mark.sort.metric === "bids" && mark.sort.direction === "descending")
    ? base
    : `${base}:${consoleSortToken(mark.sort)}`;
}

/** Кнопка FAQ из корня ленты аукциона сходки. */
export function auctionFaqData(auction: string): string {
  return `v1:faq:${auction}`;
}

/**
 * Данные кнопки «Отмена» для вопроса с этим шагом, заданного человеку
 * `askedBy`. Id идёт последней частью: самый длинный шаг — `ln` с токеном
 * аукциона и ключом создания лота — занимает с ним 60 байт из 64.
 */
export function questionData(step: QuestionStep, askedBy: number): string {
  return `${stepData(step)}:${askedBy}`;
}

function stepData(step: QuestionStep): string {
  switch (step.kind) {
    case "lot-new":
      return `v1:q:ln:${step.auction}:${step.key}`;
    case "lot-text":
      return `v1:q:${step.field === "title" ? "lt" : "ld"}:${step.lot}`;
    case "lot-price":
      return `v1:q:lp:${step.lot}`;
    case "lot-step":
      return `v1:q:ls:${step.lot}:${step.price}`;
    case "lot-image":
      return `v1:q:li:${step.lot}`;
    case "console-week":
      return `v1:q:aw:${step.auction}`;
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
    case "channel-code":
      return "v1:q:cc";
    case "channel-label":
      return "v1:q:cl";
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

// «Да» подтверждения смены состояния несёт версию сходки, которую человек
// видел, пятым сегментом: команда уходит с ней в `expected_version`, и правка
// другого администратора между экраном и нажатием даёт конфликт (PER-472).
// Кнопка прошлого релиза версии не несёт и разбирается без неё: юзкейс тогда
// берёт версию из снимка в момент нажатия, как раньше.
function stateConfirm<
  Kind extends
    | "manage-confirm-unpublish"
    | "manage-confirm-cancel"
    | "manage-confirm-hold"
    | "manage-confirm-unschedule",
>(
  kind: Kind,
  token: string,
  parts: readonly string[],
): { kind: Kind; token: string; version?: number } | { kind: "malformed" } {
  if (parts.length === 4) return { kind, token };
  if (parts.length !== 5) return { kind: "malformed" };
  const version = VersionSchema.safeParse(parts[4]);
  return version.success
    ? { kind, token, version: version.data }
    : { kind: "malformed" };
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
  if (parsed.data === "v1:sc:a") return { kind: "ask-source-channel" };
  if (parts[1] === "sc" && parts[2] === "l" && parts.length <= 4) {
    const page = PageSchema.safeParse(parts[3] ?? "0");
    return page.success
      ? { kind: "source-channels", page: page.data }
      : { kind: "malformed" };
  }
  if (parts[1] === "q") {
    const asked = parseAskedQuestion(parts);
    if (asked !== undefined) return { kind: "question", ...asked };
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
  if (parts[1] === "lot") {
    return parseLot(parts);
  }
  if (parts[1] === "ac") {
    return parseConsole(parts);
  }
  if (parts[1] === "faq") {
    const auction = TokenSchema.safeParse(parts[2]);
    return parts.length === 3 && auction.success
      ? { kind: "auction-faq", auction: auction.data }
      : { kind: "malformed" };
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
  if (parts.length === 4 && parts[2] === "auction")
    return { kind: "manage-auction", token: token.data };
  if (parts.length === 4 && parts[2] === "republish")
    return { kind: "manage-publish", token: token.data };
  if (parts.length === 4 && parts[2] === "unpublish")
    return { kind: "manage-unpublish", token: token.data };
  if (parts[2] === "confirm-unpublish")
    return stateConfirm("manage-confirm-unpublish", token.data, parts);
  if (parts.length === 4 && parts[2] === "cancel")
    return { kind: "manage-cancel", token: token.data };
  if (parts[2] === "confirm-cancel")
    return stateConfirm("manage-confirm-cancel", token.data, parts);
  if (parts.length === 4 && parts[2] === "hold")
    return { kind: "manage-hold", token: token.data };
  if (parts[2] === "confirm-hold")
    return stateConfirm("manage-confirm-hold", token.data, parts);
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
  if (parts[2] === "confirm-unschedule")
    return stateConfirm("manage-confirm-unschedule", token.data, parts);
  return { kind: "malformed" };
}

// Кнопки формы лота: `v1:lot:new:<аукцион>`, `v1:lot:form:<лот>` и
// `v1:lot:ask:<лот>:<поле>`.
function parseLot(parts: readonly string[]): CallbackAction {
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success) return { kind: "malformed" };
  if (parts.length === 4 && parts[2] === "new") {
    return { kind: "lot-new", auction: token.data };
  }
  if (parts.length === 4 && parts[2] === "form") {
    return { kind: "lot-form", lot: token.data };
  }
  if (parts.length === 5 && parts[2] === "ask") {
    const field = LotFormFieldSchema.safeParse(parts[4]);
    return field.success
      ? { kind: "lot-ask", lot: token.data, field: field.data }
      : { kind: "malformed" };
  }
  return { kind: "malformed" };
}

// Кнопки пульта аукциона (PER-320): `v1:ac:v:<аукцион>[:<страница>]`,
// `v1:ac:w:<аукцион>`, `v1:ac:f:<аукцион>:<0|1>`, `v1:ac:o:<аукцион>`,
// `v1:ac:y:<аукцион>:<ключ>` и `v1:ac:<s|d>:<аукцион>:<лот>:<страница>`.
function parseConsole(parts: readonly string[]): CallbackAction {
  const auction = TokenSchema.safeParse(parts[3]);
  if (!auction.success) return { kind: "malformed" };
  switch (parts[2]) {
    case "v": {
      if (parts.length > 6) return { kind: "malformed" };
      const page = PageSchema.safeParse(parts[4] ?? "0");
      const sort =
        parts.length === 6 ? parseConsoleSort(parts[5]) : defaultConsoleSort;
      return page.success && sort !== undefined
        ? { kind: "console-view", auction: auction.data, page: page.data, sort }
        : { kind: "malformed" };
    }
    case "w":
      return parts.length === 4
        ? { kind: "console-week", auction: auction.data }
        : { kind: "malformed" };
    case "f": {
      const final = TargetStateSchema.safeParse(parts[4]);
      return parts.length === 5 && final.success
        ? {
            kind: "console-final",
            auction: auction.data,
            final: final.data === "1",
          }
        : { kind: "malformed" };
    }
    case "o":
      return parts.length === 4
        ? { kind: "console-open", auction: auction.data }
        : { kind: "malformed" };
    case "y": {
      const op = TokenSchema.safeParse(parts[4]);
      return parts.length === 5 && op.success
        ? { kind: "console-confirm", auction: auction.data, op: op.data }
        : { kind: "malformed" };
    }
    case "s":
    case "d": {
      const lot = TokenSchema.safeParse(parts[4]);
      const page = PageSchema.safeParse(parts[5]);
      const sort =
        parts.length === 7 ? parseConsoleSort(parts[6]) : defaultConsoleSort;
      return (parts.length === 6 || parts.length === 7) &&
        lot.success &&
        page.success &&
        sort !== undefined
        ? {
            kind: "console-mark",
            auction: auction.data,
            lot: lot.data,
            selected: parts[2] === "s",
            page: page.data,
            sort,
          }
        : { kind: "malformed" };
    }
    default:
      return { kind: "malformed" };
  }
}

// Telegram id пользователя: целое до 52 бит, не больше 16 цифр. Ноль — запасное
// значение бота для update без `from`: «Отмена» под таким вопросом работает, а
// ответ ни от кого не совпадёт с ним и будет отброшен.
const TelegramIdSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,15})$/)
  .transform(Number);

// Кнопка с id спрашиваемого последней частью. Токен — 22 символа, поэтому за
// id не сойдёт; версия материала без id — сойдёт, но шаг без последней части
// тогда не разбирается, и кнопка читается как кнопка прошлого релиза.
function parseAskedQuestion(
  parts: readonly string[],
): { step: QuestionStep; askedBy: number } | undefined {
  const askedBy = TelegramIdSchema.safeParse(parts.at(-1));
  if (!askedBy.success) return undefined;
  const step = parseQuestionStep(parts.slice(0, -1));
  return step === undefined ? undefined : { step, askedBy: askedBy.data };
}

function parseQuestionStep(parts: readonly string[]): QuestionStep | undefined {
  if (parts.length === 3 && parts[2] === "bc") return { kind: "broadcast" };
  if (parts.length === 3 && parts[2] === "nick") return { kind: "username" };
  if (parts.length === 3 && parts[2] === "cc") return { kind: "channel-code" };
  if (parts.length === 3 && parts[2] === "cl") return { kind: "channel-label" };
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success) return undefined;
  if (parts.length === 4) {
    switch (parts[2]) {
      case "lt":
        return { kind: "lot-text", lot: token.data, field: "title" };
      case "ld":
        return { kind: "lot-text", lot: token.data, field: "description" };
      case "lp":
        return { kind: "lot-price", lot: token.data };
      case "li":
        return { kind: "lot-image", lot: token.data };
      case "aw":
        return { kind: "console-week", auction: token.data };
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
  if (parts[2] === "ln") {
    const key = LotKeySchema.safeParse(parts[4]);
    return key.success
      ? { kind: "lot-new", auction: token.data, key: key.data }
      : undefined;
  }
  if (parts[2] === "ls") {
    const price = RublesSchema.safeParse(parts[4]);
    return price.success
      ? { kind: "lot-step", lot: token.data, price: price.data }
      : undefined;
  }
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
// токен у них — заявки, а не человека. Карточка заявки: `q` — первая или
// следующая за курсором, `qc` — та же, `qa` — допустить, `qd` и `qy` — вопрос
// об отказе и его «Да». Имена сжаты: `ad` и `by` несут двух людей и с длинным
// доменом вышли бы ровно в 64 байта.
function parseCommunity(parts: readonly string[]): CallbackAction {
  const malformed = { kind: "malformed" } as const;
  if (parts.length > 5) return malformed;
  const [, , verb, first, second] = parts;
  switch (verb) {
    case "q":
    case "qc": {
      if (verb === "q" && first === undefined) {
        return { kind: "application-card" };
      }
      const cursor = parseCardCursor(first, second);
      if (cursor === undefined) return malformed;
      return {
        kind: "application-card",
        cursor,
        from: verb === "q" ? "after" : "at",
      };
    }
    case "qa":
    case "qd":
    case "qy": {
      const cursor = parseCardCursor(first, second);
      if (cursor === undefined) return malformed;
      return {
        kind:
          verb === "qa"
            ? "admit-application"
            : verb === "qd"
              ? "ask-decline-application"
              : "decline-application",
        cursor,
      };
    }
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
    // Только категории, которые сходка может нести: глобальные сюда не
    // проходят, и `INVALID_ARGUMENT` за них не платится.
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
