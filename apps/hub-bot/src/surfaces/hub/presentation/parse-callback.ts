import { z } from "zod";
import type { ApplicationQueue } from "../../../auction-ui/index.js";
import {
  OUTBID_FREQUENCIES,
  type OutbidFrequency,
} from "../../../core/notifications/outbid.js";
import type {
  AnnouncementAudience,
  AnnouncementTemplate,
  ButtonChoice,
} from "../application/auction-announcements.js";
import type {
  CloseQuote,
  ConsoleSection,
  ConsoleSort,
  FormField,
  HappyHourField,
  InvoiceMark,
  LaunchDraft,
  LineupPick,
  LotSetRef,
  LotStepMode,
  LotTextField,
  WindowRef,
} from "../application/types.js";
import type { CommunityDay } from "../community-time.js";
import type { CommunityFilter, RecordRight } from "../identity/port.js";
import type {
  MeetupCategory,
  NotificationCategory,
} from "../notifications/port.js";
import { decodeLaunchDraft, encodeLaunchDraft } from "./launch-draft.js";
import { type ManageGroup, manageGroupOf } from "./screens/menu.js";

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
const OutbidFrequencySchema = z.enum(OUTBID_FREQUENCIES);
const GlobalCategorySchema = z.enum([
  "published",
  "changes",
  "material",
  "reminder",
  "organizer",
  "announcement",
  "access-community",
  "access-auction",
  "release",
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
// Номер лота в составе финала с нуля: финал — семь-восемь лотов, а трёх цифр
// хватает любому реестру. Ведущие нули — не номер.
const PositionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,2})$/)
  .transform(Number);
// Окно «Счастливых часов» в кнопке пульта (PER-504): номер в конфигурации с
// нуля — двух цифр хватает с запасом, — и отпечаток его сроков и шага.
// Номер раздела ленты (PER-719) в кнопке; `0` — общий список. Предел тот же,
// что у кнопки раздела в ленте участника: семь цифр — номер растёт минутой
// создания раздела.
const SectionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,6})$/)
  .transform(Number);

const WindowIndexSchema = z
  .string()
  .regex(/^(0|[1-9]\d?)$/)
  .transform(Number);
const WindowPrintSchema = z.string().regex(/^[0-9a-z]{5}$/);
// Место фото лота на экране «Фото лота» (PER-721): с единицы, не больше
// десяти — предела фото у лота.
const PhotoIndexSchema = z
  .string()
  .regex(/^(?:[1-9]|10)$/)
  .transform(Number);
// Номер лота запускаемого окна в кнопке пульта (PER-615): номер в
// отсортированном реестре с нуля — знак base36, шестидесяти четырёх лотов
// хватает с запасом.
const LaunchLotSchema = z
  .string()
  .regex(/^(0|[1-9a-z]{1,2})$/)
  .transform((text) => Number.parseInt(text, 36));
// Порядок состава финала в кнопке (PER-619): номер лота в наборе удержанных —
// знак base36, не больше двадцати четырёх; `-` — ещё ничего не выбрано.
const emptyLineupOrder = "-";
const LineupOrderSchema = z
  .string()
  .regex(/^(-|[0-9a-z]{1,24})$/)
  .transform((raw): number[] =>
    raw === emptyLineupOrder
      ? []
      : [...raw].map((each) => Number.parseInt(each, 36)),
  );
// Номер билета розыгрыша в кнопке (PER-727): с единицы, без ведущих нулей.
const TicketSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/)
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

// Место в списке состава (PER-547): фильтр и страница. Карточка человека и
// действия с неё несут его, чтобы «‹ Состав» вернул на ту же страницу.
export type CommunityPlace = { filter: CommunityFilter; page: number };

const filterCodes: Readonly<Record<CommunityFilter, string>> = {
  members: "m",
  guests: "g",
  moderators: "o",
};

/** Сегмент `callback_data`: буква фильтра и страница — `m0`, `g2`, `o0`. */
export function communityPlaceData(place: CommunityPlace): string {
  return `${filterCodes[place.filter]}${place.page}`;
}

/** Первая страница участников — куда ведут «Состав сообщества» и прежние кнопки. */
export const firstMembersPage: CommunityPlace = { filter: "members", page: 0 };

// Кнопки до PER-547 несли место закрытия доступа: `p`, `p<токен>` — очередь,
// которой в составе больше нет, `a<страница>` — допущенных. Они ведут в
// участников: очередь ушла в «Заявки», допущенные стали фильтром.
function parseCommunityPlace(
  raw: string | undefined,
): CommunityPlace | undefined {
  if (raw === undefined || raw === "") return undefined;
  const code = raw[0];
  const page = PageSchema.safeParse(raw.slice(1));
  const filter = (Object.keys(filterCodes) as CommunityFilter[]).find(
    (candidate) => filterCodes[candidate] === code,
  );
  if (filter !== undefined) {
    return page.success ? { filter, page: page.data } : undefined;
  }
  if (code === "a") {
    return page.success ? { filter: "members", page: page.data } : undefined;
  }
  if (
    raw === "p" ||
    (code === "p" && TokenSchema.safeParse(raw.slice(1)).success)
  ) {
    return firstMembersPage;
  }
  return undefined;
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
  // «‹ Меню» и старые кнопки «Меню» в чатах: корневое меню (PER-592).
  | { kind: "home" }
  // «Подать заявку» под приветствием: единственное действие, которое ставит
  // заявку (дополнение ADR-060). Код канала прихода едет в кнопке, пока
  // помещается: `v1:apply` или `v1:apply:<код>`.
  | { kind: "apply"; sourceCode?: string }
  // Корни разделов, которые открывают команды; кнопкой — повтор после сбоя.
  | { kind: "settings" }
  | { kind: "help" }
  | { kind: "release-notes"; token?: string; part?: number }
  | { kind: "next" }
  // «События» (PER-669): идущие события расширений сходок.
  | { kind: "events" }
  // Списки листаются: страница едет в кнопке листания, без неё — первая.
  | { kind: "hub"; page?: number }
  | { kind: "archive"; page?: number }
  | { kind: "manage-menu" }
  | { kind: "manage-group"; group: ManageGroup }
  | { kind: "manage-hidden"; page?: number }
  // Состав (PER-547): список людей с фильтром; без места — первая страница
  // участников. Карточка и действия с неё несут токен человека и место.
  | { kind: "community"; place?: CommunityPlace }
  | { kind: "community-usernames"; page: number }
  | { kind: "ask-allowed-username" }
  | { kind: "community-member"; token: string; place: CommunityPlace }
  | { kind: "ask-block-member"; token: string; place: CommunityPlace }
  | { kind: "block-member"; token: string; place: CommunityPlace }
  // Понижение участника до гостя (PER-642): вопрос и его «Да».
  | { kind: "ask-demote-member"; token: string; place: CommunityPlace }
  | { kind: "demote-member"; token: string; place: CommunityPlace }
  | { kind: "remove-allowed-username"; username: string; page: number }
  // Записи прав с карточки человека: модерация аукциона (ADR-064, пункт 7) и
  // ведение аукциона (ADR-070, п. 1).
  | {
      kind: "grant-record";
      right: RecordRight;
      token: string;
      place: CommunityPlace;
    }
  | {
      kind: "revoke-record";
      right: RecordRight;
      token: string;
      place: CommunityPlace;
    }
  // Администраторы (PER-521): список, вопрос о нике, «Да» назначения с ником и
  // его «Нет», подтверждение снятия и его «Да» с токеном человека.
  | { kind: "administrators" }
  | { kind: "ask-appoint-administrator" }
  | { kind: "confirm-appoint-administrator"; username: string }
  | { kind: "decline-appoint-administrator" }
  | { kind: "ask-dismiss-administrator"; token: string }
  | { kind: "dismiss-administrator"; token: string }
  // Отказанные: токен — заявки, а не человека; страница — куда вернуть список.
  // Очередь называет домен кнопки: `cm` — сообщество, `aq` — аукцион.
  | { kind: "refused-applications"; queue: ApplicationQueue; page: number }
  | {
      kind: "ask-reconsider";
      queue: ApplicationQueue;
      token: string;
      page: number;
    }
  | { kind: "reconsider"; queue: ApplicationQueue; token: string; page: number }
  // Каналы прихода (ADR-060, пункт 18): список со ссылками и вопрос о новом.
  | { kind: "source-channels"; page: number }
  | { kind: "ask-source-channel" }
  // Карточка заявки: без курсора — первая в очереди, `after` — следующая за
  // курсором («Пропустить»), `at` — та же, если она ещё открыта.
  | {
      kind: "application-card";
      queue: ApplicationQueue;
      cursor?: CardCursor;
      from?: "after" | "at";
    }
  | { kind: "admit-application"; queue: ApplicationQueue; cursor: CardCursor }
  | {
      kind: "ask-decline-application";
      queue: ApplicationQueue;
      cursor: CardCursor;
    }
  | {
      kind: "decline-application";
      queue: ApplicationQueue;
      cursor: CardCursor;
    }
  // «Создать сходку» (прогон 14.10, №14 и №54): токен — id будущей сходки,
  // рождённый при отрисовке; сходки ещё нет, она рождается ответом на вопрос
  // о названии. `from` — кнопка стоит в «Сходках» (№45), и «Отмена» вопроса
  // ведёт туда, а не в группу «Сходки и объявления».
  | { kind: "create-meetup"; token: string; from?: "meetups" }
  // Команда публикации. С версией — «Да» подтверждения с черновика (решение
  // владельца 10 октября 2026 года); без версии — «Да, опубликовать» кадра
  // конфликта и кнопки, оставшиеся в чатах до подтверждения.
  | { kind: "publish-meetup"; token: string; version?: number }
  | { kind: "manage-edit"; token: string }
  | { kind: "manage-field"; token: string; field: FormField }
  // Черновик формы создания: без поля — сам экран, с полем — вопрос о нём.
  | { kind: "manage-draft"; token: string; field?: FormField }
  | { kind: "manage-status"; token: string }
  // «Включить аукцион» в «Расширениях» сходки (PER-307, PER-654). Кнопки
  // входа в аукцион здесь нет: она домена `auc`, и её пишет и разбирает
  // аукционное дерево.
  | { kind: "enable-auction"; token: string }
  // Хвост `e` — вход из «Событий» (PER-669): возврат FAQ несёт его в корень.
  | { kind: "auction-faq"; auction: string; viaEvents?: true }
  // Форма лота администратора (PER-319). Кнопки несут лот, а новый лот —
  // аукцион: сходку форма не называет, её знает Auction.
  | { kind: "lot-new"; auction: string }
  | { kind: "lot-form"; lot: string }
  // `chain` — кнопка цепочки нового лота (PER-618): «Ввести заново» под её
  // вопросом продолжает цепочку, а не правку одного ряда. `set` — правка всех
  // лотов сета (PER-716).
  | {
      kind: "lot-ask";
      lot: string;
      field: LotFormField;
      chain?: true;
      set?: true;
    }
  // Поле лота в сете (PER-716): спрашивает, править только этот лот или все
  // лоты сета.
  | { kind: "lot-scope"; lot: string; field: LotFormField }
  // «Повторить для оставшихся» (PER-716): поле разносится по сету заново.
  | {
      kind: "lot-set-retry";
      lot: string;
      field: LotFormField;
      // Отпечаток версии фото у повтора фото сета (PER-721).
      print?: string;
    }
  // «Копировать» (PER-716): вопрос, сколько всего лотов.
  | { kind: "lot-copy"; lot: string }
  // «Удалить лот» и «Да» его подтверждения (PER-716).
  | { kind: "lot-remove"; lot: string }
  | { kind: "lot-remove-confirm"; lot: string }
  // «Счастливые часы» лота (PER-787): периоды аукциона с условиями лота,
  // условия в периоде, вопрос о стартовой (`t`) или шаге (`s`) и снятие.
  // Период кнопка называет номером и отпечатком, как окно; аукцион лота
  // читается из снимка лота.
  | { kind: "lot-happy-hours"; lot: string }
  | { kind: "lot-happy-hour"; lot: string; period: WindowRef }
  | {
      kind: "lot-happy-hour-ask";
      lot: string;
      period: WindowRef;
      field: HappyHourField;
    }
  | { kind: "lot-happy-hour-clear"; lot: string; period: WindowRef }
  // Выбор способа шага (PER-491): цена и режим едут в кнопке, чтобы рестарт
  // не терял цену.
  | {
      kind: "lot-step-mode";
      lot: string;
      price: number;
      mode: LotStepMode;
      chain?: true;
      set?: true;
    }
  // «Оставить шаг» на выборе способа шага (PER-714): новая цена едет в кнопке,
  // шаг юзкейс берёт у лота.
  | { kind: "lot-keep-step"; lot: string; price: number; set?: true }
  // «Пропустить» под вопросом о фото в цепочке нового лота (PER-618).
  | { kind: "lot-skip"; lot: string }
  // Экран «Фото лота» (PER-721). `fromQuestion` — прежняя «Убрать фото» под
  // вопросом о фото (PER-715): вопрос уходит, как от «Отмены».
  | { kind: "lot-photos"; lot: string; fromQuestion?: true }
  // «Убрать фото N» на экране фото и «Да» его подтверждения (PER-715,
  // PER-721): номер — место фото в списке на экране, а «Да» несёт отпечаток
  // самого фото: снимается то, что подтвердили.
  | { kind: "lot-photo-remove"; lot: string; index: number }
  | { kind: "lot-photo-remove-confirm"; lot: string; print: string }
  // «Глазами участника» на экране правки (PER-512): карточка лота без кнопок.
  | { kind: "lot-view"; lot: string }
  // Пульт аукциона администратора (PER-320). Кнопки несут аукцион, а отметка
  // финала — ещё лот и страницу пульта, на которую вернуться.
  // Разделы под пультом (PER-802) — та же кнопка вида с разделом: «Финал»
  // листается и сортируется, как пульт.
  | {
      kind: "console-view";
      auction: string;
      page: number;
      sort: ConsoleSort;
      section?: ConsoleSection;
    }
  | { kind: "console-week"; auction: string }
  // Розыгрыш (PER-593): вопрос о моменте и снятие момента.
  | { kind: "console-raffle"; auction: string }
  | { kind: "console-raffle-remove"; auction: string }
  // Приз розыгрыша (PER-649): вопрос о призе и его снятие.
  | { kind: "console-raffle-prize"; auction: string }
  | { kind: "console-raffle-prize-remove"; auction: string }
  // Срок оплаты счёта (PER-722): вопрос о числе дней.
  | { kind: "console-payment-term"; auction: string }
  | { kind: "console-final"; auction: string; final: boolean }
  // Ориентировочное время финала (PER-663): вопрос о моменте и снятие
  // анонса.
  | { kind: "console-final-time"; auction: string }
  | { kind: "console-final-time-remove"; auction: string }
  // Видимость до торгов (PER-673): кнопка несёт целевое состояние.
  | { kind: "console-visibility"; auction: string; published: boolean }
  | { kind: "console-open"; auction: string }
  // «Да» подтверждения: ключ открытия рождён, когда подтверждение показано,
  // и повторное нажатие несёт тот же.
  | { kind: "console-confirm"; auction: string; op: string }
  // «Удалить аукцион»: подтверждение, затем «Да» с ключом удаления.
  | { kind: "console-discard"; auction: string }
  | { kind: "console-discard-confirm"; auction: string; op: string }
  | { kind: "console-cancel"; auction: string }
  | { kind: "console-cancel-confirm"; auction: string; op: string }
  | {
      kind: "console-mark";
      auction: string;
      lot: string;
      selected: boolean;
      page: number;
      sort: ConsoleSort;
    }
  // «Счастливые часы» (PER-504): список окон, окно на странице лотов, вопрос
  // о новом окне, лот в окне и вне его, удаление окна. Окно кнопка называет
  // номером и отпечатком; лот окна — без страницы, её экран выводит из лота.
  | { kind: "console-windows"; auction: string }
  // Сводка дня торгов (PER-492): текст за сутки со ссылками на лоты.
  | { kind: "console-day-summary"; auction: string }
  // Счета аукциона (PER-321): сводка со страницей, счёт, подтверждение отметки
  // и «Да». Отметка — `p` оплата, `h` выдача; ключ рождается на нажатие «Да».
  | { kind: "console-invoices"; auction: string; page: number }
  | { kind: "console-invoice"; auction: string; invoice: string }
  | {
      kind: "console-invoice-mark";
      auction: string;
      invoice: string;
      mark: InvoiceMark;
    }
  | {
      kind: "console-invoice-mark-confirm";
      auction: string;
      invoice: string;
      mark: InvoiceMark;
    }
  // Текст «Как оплатить и получить» на «Счетах» (PER-322): вопрос и снятие.
  | { kind: "console-payment-text"; auction: string }
  | { kind: "console-payment-text-remove"; auction: string }
  // Итог розыгрыша вручную (PER-727): список билетов со страницей, вопрос о
  // номере, подтверждение по номеру и «Да»; ключ рождается на нажатие «Да».
  | { kind: "console-raffle-winner"; auction: string; page: number }
  | { kind: "console-raffle-winner-ask"; auction: string }
  | { kind: "console-raffle-winner-pick"; auction: string; ticket: number }
  | { kind: "console-raffle-winner-confirm"; auction: string; ticket: number }
  // Смена приза идущего розыгрыша (PER-737): вопрос о тексте и «Да» с
  // отпечатком нового приза; сам текст «Да» берёт из экрана подтверждения.
  | { kind: "console-raffle-prize-change"; auction: string }
  | {
      kind: "console-raffle-prize-change-confirm";
      auction: string;
      print: string;
    }
  // Фото приза идущего розыгрыша (PER-773): экран фото, вопрос о фото,
  // подтверждение снятия и «Да» снятия; ключ снятия — на нажатие.
  | { kind: "console-raffle-prize-photo"; auction: string }
  | { kind: "console-raffle-prize-photo-ask"; auction: string }
  | { kind: "console-raffle-prize-photo-remove"; auction: string }
  | { kind: "console-raffle-prize-photo-remove-confirm"; auction: string }
  // Промо-видео аукциона (PER-774): экран, вопрос о видео, подтверждение
  // снятия и «Да»; ключ снятия рождается на нажатие «Да».
  | { kind: "console-promo-video"; auction: string }
  | { kind: "console-promo-video-ask"; auction: string }
  | { kind: "console-promo-video-remove"; auction: string }
  | { kind: "console-promo-video-remove-confirm"; auction: string }
  // Объявление аукциона (PER-765): меню, выбор окна и лота, вопрос о тексте,
  // кнопка, фото и «Отправить N». Текст едет в сообщении бота, кнопки несут
  // его отпечаток; лот — номером в реестре по порядку заведения, фото — номером
  // у лота с нуля.
  | AnnouncementAction
  | { kind: "console-window"; auction: string; window: WindowRef; page: number }
  | { kind: "console-window-ask"; auction: string }
  | {
      kind: "console-window-lot";
      auction: string;
      window: WindowRef;
      lot: string;
      selected: boolean;
    }
  | { kind: "console-window-remove"; auction: string; window: WindowRef }
  // Периоды «Счастливых часов» (PER-787): список, вопрос о сроках нового,
  // период, подтверждение удаления и «Да» с ключом, рождённым на нажатие.
  | { kind: "console-periods"; auction: string }
  | { kind: "console-period-ask"; auction: string }
  | { kind: "console-period"; auction: string; period: WindowRef }
  | { kind: "console-period-remove"; auction: string; period: WindowRef }
  | {
      kind: "console-period-remove-confirm";
      auction: string;
      period: WindowRef;
    }
  // Сеты лотов (PER-509): список, вопрос о названии нового сета, сет на
  // странице лотов, лот в сете и вне его, подтверждение удаления и «Да». Сет
  // кнопка называет номером и отпечатком, как окно.
  | { kind: "console-sets"; auction: string }
  | { kind: "console-set-ask"; auction: string }
  | { kind: "console-set"; auction: string; set: LotSetRef; page: number }
  | {
      kind: "console-set-lot";
      auction: string;
      set: LotSetRef;
      lot: string;
      selected: boolean;
    }
  | { kind: "console-set-delete"; auction: string; set: LotSetRef }
  | { kind: "console-set-delete-confirm"; auction: string; set: LotSetRef }
  // Порядок и разделы ленты (PER-719): экран разделов, список места — номер
  // раздела или `0`, общий список, — лот в раскладке, лот выше и ниже, лот
  // в другое место, вопрос о названии нового или переименуемого раздела,
  // раздел выше и ниже, подтверждение удаления раздела и «Да». Лот кнопка
  // называет токеном, раздел — номером, который выбрал пульт.
  | { kind: "console-layout"; auction: string }
  | {
      kind: "console-layout-list";
      auction: string;
      place: number;
      page: number;
    }
  | { kind: "console-layout-lot"; auction: string; lot: string }
  | {
      kind: "console-layout-lot-move";
      auction: string;
      lot: string;
      direction: "up" | "down";
    }
  | {
      kind: "console-layout-lot-place";
      auction: string;
      lot: string;
      place: number;
    }
  | { kind: "console-section-ask"; auction: string; section?: number }
  | {
      kind: "console-section-move";
      auction: string;
      section: number;
      direction: "up" | "down";
    }
  | { kind: "console-section-delete"; auction: string; section: number }
  | { kind: "console-section-delete-confirm"; auction: string; section: number }
  // Запуск окна сниженного шага по ходу торгов (PER-615): начать запуск,
  // переключить лот запускаемого окна, запустить и листать лоты. Черновик
  // едет в кнопке — состояния у пульта нет.
  | { kind: "console-window-launch"; auction: string }
  | {
      kind: "console-window-launch-lot";
      auction: string;
      draft: LaunchDraft;
      lot: number;
    }
  | { kind: "console-window-launch-go"; auction: string; draft: LaunchDraft }
  | {
      kind: "console-window-launch-page";
      auction: string;
      draft: LaunchDraft;
      page: number;
    }
  // Состав финала (PER-619): начать выбор порядка, выбрать следующий лот
  // или страницу и «Да» подтверждения с полным порядком.
  | { kind: "console-lineup"; auction: string; pick?: LineupPick; page: number }
  | { kind: "console-lineup-confirm"; auction: string; pick: LineupPick }
  // Финал ведущего (PER-337). Лот финала — номер в замороженном составе с
  // нуля: токен лота рядом с аукционом и ключом в 64 байта не помещается.
  | { kind: "console-start-final"; auction: string }
  | { kind: "console-next-lot"; auction: string }
  | { kind: "console-open-ask"; auction: string }
  | { kind: "console-ask"; auction: string; position: number }
  | { kind: "console-close"; auction: string; position: number }
  // «Да» подтверждения закрытия: ключ рождён, когда подтверждение показано.
  | {
      kind: "console-close-confirm";
      auction: string;
      position: number;
      op: string;
      quote: CloseQuote;
    }
  // «Ставки зала» помощника (PER-565, ADR-070 п. 4): экран со страницей
  // людей, вопрос «Другой человек…», кнопка человека, «Да» подтверждения и
  // кнопка лидера. Кнопка человека и «Да» называют лот, а не аукцион: лот,
  // человек и цена рядом с аукционом в 64 байта не помещаются.
  | { kind: "console-floor"; auction: string; page: number }
  | { kind: "console-floor-search"; auction: string }
  | {
      kind: "console-floor-pick";
      lot: string;
      person: string;
      minorUnits: number;
    }
  | {
      kind: "console-floor-confirm";
      lot: string;
      person: string;
      minorUnits: number;
    }
  | { kind: "console-floor-leader"; auction: string }
  // Снятие участника с лота (PER-659): кого снять, подтверждение и «Да».
  // Кнопки называют лот, а не аукцион, как у «Ставок зала»: лот, человек и
  // номер лота рядом с аукционом в 64 байта не помещаются. «Да» несёт номер
  // лота, на котором решён предпросмотр, а ключ команды рождается на
  // нажатие.
  | { kind: "console-removal"; lot: string; page: number }
  | { kind: "console-removal-pick"; lot: string; person: string }
  | {
      kind: "console-removal-confirm";
      lot: string;
      person: string;
      version: number;
    }
  // «Опубликовать»: подтверждение публикации. Источник решает, куда вернёт «Нет».
  | { kind: "manage-publish"; token: string; origin: PublishOrigin }
  | { kind: "manage-confirm-publish"; token: string; version: number }
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
  // «Ввести дату»: даты среди заготовок нет, и её спрашивают текстом.
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
  // Расширения (PER-605): меню «Расширения» сходки и «Расширения» в
  // «Настройках».
  | { kind: "meetup-extensions"; token: string }
  | { kind: "settings-extensions" }
  | { kind: "settings-auction" }
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
  // Настройки уведомлений аукциона (PER-552, PER-539, PER-645): экран, режим
  // частоты, выключатели анонса финала и «перебили» в живом финале —
  // целевыми значениями. `detached` — экран открыт из вести и возврата в
  // дерево настроек не несёт (№73 прогона 14 октября 2026 года): хвост `:n`.
  | { kind: "notify-outbid"; detached?: true }
  | { kind: "notify-set-outbid"; frequency: OutbidFrequency; detached?: true }
  | { kind: "notify-set-final"; enabled: boolean; detached?: true }
  | { kind: "notify-set-live"; enabled: boolean; detached?: true }
  | { kind: "notify-set-news"; enabled: boolean; detached?: true }
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

/** Откуда нажата «Создать сходку»: группа управления или «Сходки». */
export type NewMeetupOrigin = "manage" | "meetups";

/** Кнопки объявления аукциона (PER-765): шаги без состояния. */
export type AnnouncementAction =
  | { kind: "console-announcement"; auction: string }
  | { kind: "console-announcement-windows"; auction: string }
  | { kind: "console-announcement-lots"; auction: string; page: number }
  | {
      kind: "console-announcement-ask";
      auction: string;
      template: AnnouncementTemplate;
      ref?: number;
    }
  // `audience` (PER-779) — последняя часть кнопки; у кнопок до неё её нет, и
  // они значат «всем».
  | {
      kind: "console-announcement-button";
      auction: string;
      button: ButtonChoice;
      print: string;
      audience: AnnouncementAudience;
      lot?: number;
    }
  | {
      kind: "console-announcement-photo";
      auction: string;
      button: ButtonChoice;
      print: string;
      audience: AnnouncementAudience;
      lot?: number;
      photo?: number;
    }
  // «Своё фото или видео» шага фото (PER-776): вопрос о медиа.
  | {
      kind: "console-announcement-media";
      auction: string;
      button: ButtonChoice;
      print: string;
      audience: AnnouncementAudience;
      lot?: number;
    }
  // «Отправить N» и шаг «Кому» (PER-779) — одной формы: кнопка аудитории
  // ведёт к предпросмотру, а «Нет» подтверждения — обратно в «Кому».
  | ({ kind: "console-announcement-send" } & AnnouncementSendStep)
  | ({ kind: "console-announcement-audience" } & AnnouncementSendStep)
  | ({ kind: "console-announcement-recipients" } & AnnouncementSendStep);

type AnnouncementSendStep = {
  auction: string;
  button: ButtonChoice;
  print: string;
  audience: AnnouncementAudience;
  lot?: number;
  photo?: number;
  // Только у «Отправить»: отпечаток `photoId` фото предпросмотра (PER-792).
  photoPrint?: string;
  post?: number;
};

/** Что спросил вопрос: этого хватает, чтобы принять ответ на него. */
export type QuestionStep =
  // Своё фото или видео объявления (PER-776): выбор кнопки, отпечаток текста
  // и лот шаблона; сам текст едет хвостом вопроса, как в кадре шага.
  | {
      kind: "console-announcement-media";
      auction: string;
      button: ButtonChoice;
      print: string;
      audience: AnnouncementAudience;
      lot?: number;
    }
  // Видео промо аукциона (PER-774): аукцион; ответ — видео, а не текст.
  | { kind: "console-promo-video"; auction: string }
  // Сроки нового периода «Счастливых часов» (PER-787): аукцион, а сроки
  // недели ответ читает у Auction заново.
  | { kind: "console-period"; auction: string }
  // Стартовая или шаг лота в периоде (PER-787): лот, период номером и
  // отпечатком и что спрошено; прежние условия ответ читает заново.
  | {
      kind: "happy-hour-lot";
      lot: string;
      period: WindowRef;
      field: HappyHourField;
    }
  // Текст объявления аукциона (PER-765): аукцион, шаблон и номер окна или лота
  // шаблона; черновик ответ читает у Auction заново.
  | {
      kind: "console-announcement";
      auction: string;
      template: AnnouncementTemplate;
      ref?: number;
    }
  // `fresh` — вопрос о названии новой сходки с кнопки «Создать сходку»
  // (прогон 14.10, №14): сходки ещё нет, её рождает ответ. Значение — откуда
  // задан вопрос: группа «Сходки и объявления» (`fg`) или «Сходки» (`fn`);
  // туда ведут «Отмена» и возврат. `fc` — вопрос с существующего черновика.
  | {
      kind: "field";
      mode: "create" | "edit";
      token: string;
      field: FormField;
      fresh?: NewMeetupOrigin;
    }
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
  // Ник назначаемого администратора (PER-521).
  | { kind: "administrator" }
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
  // `chain` — вопрос цепочки нового лота (PER-618): цена, шаг и фото по
  // порядку после названия; «Отмена» и у них ведёт в форму лота.
  // `set` — вопрос правки всех лотов сета (PER-716): свои коды `st`, `sd`,
  // `sp`, `ss`/`sy`, `si`.
  | { kind: "lot-text"; lot: string; field: LotTextField; set?: true }
  | { kind: "lot-price"; lot: string; chain?: true; set?: true }
  | {
      kind: "lot-step";
      lot: string;
      price: number;
      mode: LotStepMode;
      chain?: true;
      set?: true;
    }
  | { kind: "lot-image"; lot: string; chain?: true; set?: true }
  // Сколько всего лотов дают копии (PER-716).
  | { kind: "lot-copies"; lot: string }
  // Сроки онлайн-недели на пульте (PER-320): аукцион, а финал и текущие сроки
  // ответ читает у Auction заново.
  | { kind: "console-week"; auction: string }
  // Момент розыгрыша (PER-593): аукцион, а сроки и текущий момент ответ
  // читает у Auction заново.
  | { kind: "console-raffle"; auction: string }
  // Ориентировочное время финала (PER-663): аукцион, а текущее время ответ
  // читает у Auction заново.
  | { kind: "console-final-time"; auction: string }
  // Текст «Как оплатить и получить» (PER-322): аукцион; ответ заменяет текст
  // целиком, и читать ему нечего.
  | { kind: "console-payment-text"; auction: string }
  // Номер выигравшего билета (PER-727): аукцион, а пул ответ читает у Auction
  // заново.
  | { kind: "console-raffle-winner"; auction: string }
  // Новый приз идущего розыгрыша (PER-737): аукцион, а текущий приз ответ
  // читает у Auction заново.
  | { kind: "console-raffle-prize-change"; auction: string }
  // Фото приза идущего розыгрыша (PER-773): аукцион, а можно ли ещё ставить
  // фото, ответ читает у Auction заново.
  | { kind: "console-raffle-prize-photo"; auction: string }
  // Приз розыгрыша (PER-649): аукцион, а момент и текущий приз ответ читает у
  // Auction заново.
  | { kind: "console-raffle-prize"; auction: string }
  // Срок оплаты счёта (PER-722): аукцион, а остальную конфигурацию ответ
  // читает у Auction заново.
  | { kind: "console-payment-term"; auction: string }
  // Новое окно «Счастливых часов» (PER-504): аукцион, а сроки недели и окна
  // ответ читает у Auction заново.
  | { kind: "console-window"; auction: string }
  // Запуск окна по ходу торгов (PER-615): аукцион, а сроки недели и окна
  // ответ читает у Auction заново.
  | { kind: "console-launch"; auction: string }
  // Название нового сета лотов (PER-509): аукцион, а сеты ответ читает у
  // Auction заново.
  | { kind: "console-set"; auction: string }
  // Название раздела ленты (PER-719): нового либо, с `section`, нового
  // названия раздела.
  | { kind: "console-section"; auction: string; section?: number }
  // Следующая цена лота финала (PER-337): аукцион и номер лота в составе.
  | { kind: "final-ask"; auction: string; position: number }
  // «Другой человек…» «Ставок зала» (PER-565): аукцион, а людей и цену ответ
  // читает у Auction заново.
  | { kind: "floor-search"; auction: string };

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
// Способ шага в кнопке выбора (PER-491): один шаг или пороги.
const LotStepModeSchema = z.enum(["single", "tiered"]);

/** Данные кнопки «Добавить лот» в ленте аукциона; аргумент — токен аукциона. */
export function lotNewData(auction: string): string {
  return `v1:lot:new:${auction}`;
}

/** Данные кнопки входа на экран правки лота; аргумент — токен лота. */
export function lotFormData(lot: string): string {
  return `v1:lot:form:${lot}`;
}

/** Данные кнопки «Глазами участника» на экране правки; аргумент — токен лота. */
export function lotPreviewData(lot: string): string {
  return `v1:lot:view:${lot}`;
}

/**
 * Данные кнопки ряда на экране правки лота. `chain` — вопрос цепочки нового
 * лота (PER-618): так его задаёт «Ввести заново» под цепочкой. `"set"` —
 * вопрос правки всех лотов сета (PER-716).
 */
export function lotAskData(
  lot: string,
  field: LotFormField,
  scope?: boolean | "set",
): string {
  return `v1:lot:ask:${lot}:${field}${scopeMark(scope)}`;
}

/** Поле лота в сете: выбор «Только этот лот» или «Все лоты сета» (PER-716). */
export function lotScopeData(lot: string, field: LotFormField): string {
  return `v1:lot:sc:${lot}:${field}`;
}

/**
 * «Повторить для оставшихся» под исходом правки сета (PER-716). У фото
 * (PER-721) хвост — отпечаток версии разнесённого фото.
 */
export function lotSetRetryData(
  lot: string,
  field: LotFormField,
  print?: string,
): string {
  return print === undefined
    ? `v1:lot:sr:${lot}:${field}`
    : `v1:lot:sr:${lot}:${field}:${print}`;
}

/** «Копировать» на экране правки лота (PER-716). */
export function lotCopyData(lot: string): string {
  return `v1:lot:cp:${lot}`;
}

/** «Удалить лот» на экране правки лота (PER-716). */
export function lotRemoveData(lot: string): string {
  return `v1:lot:dl:${lot}`;
}

/** «Да, удалить лот» под подтверждением (PER-716). */
export function lotRemoveConfirmData(lot: string): string {
  return `v1:lot:dy:${lot}`;
}

/** «Пропустить» под вопросом о фото в цепочке нового лота (PER-618). */
export function lotSkipData(lot: string): string {
  return `v1:lot:skip:${lot}`;
}

/** Экран «Фото лота» (PER-721). */
export function lotPhotosData(lot: string): string {
  return `v1:lot:ph:${lot}`;
}

/** «Убрать фото N» на экране фото лота (PER-721); номер — с единицы. */
export function lotPhotoRemoveData(lot: string, index: number): string {
  return `v1:lot:rm:${lot}:${index}`;
}

/** «Да, убрать фото» под подтверждением (PER-715): отпечаток фото. */
export function lotPhotoRemoveConfirmData(lot: string, print: string): string {
  return `v1:lot:ry:${lot}:${print}`;
}

// Хвост кнопки цепочки нового лота (PER-618).
const chainMark = ":c";
// Хвост кнопки правки всех лотов сета (PER-716).
const setMark = ":s";

function scopeMark(scope: boolean | "set" | undefined): string {
  return scope === "set" ? setMark : scope === true ? chainMark : "";
}

/**
 * Данные кнопки выбора способа шага (PER-491). Цена едет в кнопке: вопрос о
 * шаге задаётся после неё, и рестарт между ними не должен её терять.
 */
export function lotStepModeData(
  lot: string,
  price: number,
  mode: LotStepMode,
  scope?: boolean | "set",
): string {
  return `v1:lot:sm:${lot}:${price}:${mode}${scopeMark(scope)}`;
}

/**
 * «Оставить шаг» (PER-714): новая цена с прежним шагом лота одним нажатием.
 * Цена едет в кнопке, как у выбора способа; цепочки у кнопки нет — у нового
 * лота прежнего шага нет.
 */
export function lotKeepStepData(
  lot: string,
  price: number,
  set?: boolean,
): string {
  return `v1:lot:sk:${lot}:${price}${set === true ? setMark : ""}`;
}

// Кнопки пульта аукциона: `v1:ac:<действие>:<аукцион>[:…]`. Самые длинные —
// выбор порядка состава финала, до 64 байт, и лот в окне «Счастливых часов»
// с номером окна и отпечатком, до 63.

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

/** Экран «Розыгрыш» под пультом (PER-802): момент, приз, фото и итог. */
export function consoleRaffleScreenData(auction: string): string {
  return `v1:ac:rs:${auction}`;
}

/**
 * Экран «Финал» под пультом (PER-802): отбор лотов и время финала. Страница и
 * сортировка — как у пульта, первая страница по умолчанию — без них.
 */
export function consoleFinalScreenData(
  auction: string,
  page = 0,
  sort: ConsoleSort = defaultConsoleSort,
): string {
  if (sort.metric === "bids" && sort.direction === "descending") {
    return page === 0 ? `v1:ac:fl:${auction}` : `v1:ac:fl:${auction}:${page}`;
  }
  return `v1:ac:fl:${auction}:${page}:${consoleSortToken(sort)}`;
}

/** Экран «Ещё» под пультом (PER-802): снятие с публикации, удаление, отмена. */
export function consoleMoreData(auction: string): string {
  return `v1:ac:es:${auction}`;
}

/** «Сроки недели»: вопрос о начале и конце онлайн-недели. */
export function consoleWeekData(auction: string): string {
  return `v1:ac:w:${auction}`;
}

/** «Розыгрыш»: вопрос о моменте закрытия регистрации (PER-593). */
export function consoleRaffleData(auction: string): string {
  return `v1:ac:r:${auction}`;
}

/** «Убрать розыгрыш»: неделя без момента проходит без розыгрыша. */
export function consoleRaffleRemoveData(auction: string): string {
  return `v1:ac:rx:${auction}`;
}

/** «Приз»: вопрос о призе розыгрыша (PER-649). */
export function consoleRafflePrizeData(auction: string): string {
  return `v1:ac:rp:${auction}`;
}

/** «Убрать приз»: розыгрыш остаётся, победитель получит весть без приза. */
export function consoleRafflePrizeRemoveData(auction: string): string {
  return `v1:ac:rz:${auction}`;
}

/** «Срок оплаты»: вопрос о сроке оплаты счёта в днях (PER-722). */
export function consolePaymentTermData(auction: string): string {
  return `v1:ac:pt:${auction}`;
}

/** «Время финала»: вопрос об ориентировочном времени финала (PER-663). */
export function consoleFinalTimeData(auction: string): string {
  return `v1:ac:ft:${auction}`;
}

/** «Убрать время финала»: анонс трансляции снимается без подтверждения. */
export function consoleFinalTimeRemoveData(auction: string): string {
  return `v1:ac:fx:${auction}`;
}

/** «Текст оплаты»: вопрос о тексте «Как оплатить и получить» (PER-322). */
export function consolePaymentTextData(auction: string): string {
  return `v1:ac:it:${auction}`;
}

/** «Убрать текст оплаты»: текст снимается без подтверждения. */
export function consolePaymentTextRemoveData(auction: string): string {
  return `v1:ac:ix:${auction}`;
}

/** «Итог розыгрыша» (PER-727): список билетов; первая страница — без номера. */
export function consoleRaffleWinnerData(auction: string, page = 0): string {
  return page === 0 ? `v1:ac:rw:${auction}` : `v1:ac:rw:${auction}:${page}`;
}

/** «Ввести победителя»: вопрос о номере выигравшего билета. */
export function consoleRaffleWinnerAskData(auction: string): string {
  return `v1:ac:ra:${auction}`;
}

/** Подтверждение победителя по номеру билета: «Повторить» после сбоя «Да». */
export function consoleRaffleWinnerPickData(
  auction: string,
  ticket: number,
): string {
  return `v1:ac:rc:${auction}:${ticket}`;
}

/** «Да» итога: аукцион и номер, до 42 байт; ключ рождается на нажатие. */
export function consoleRaffleWinnerConfirmData(
  auction: string,
  ticket: number,
): string {
  return `v1:ac:ry:${auction}:${ticket}`;
}

/** «Изменить приз» идущего розыгрыша (PER-737): вопрос о новом тексте. */
export function consoleRafflePrizeChangeData(auction: string): string {
  return `v1:ac:rn:${auction}`;
}

/** Экран промо-видео аукциона (PER-774) из пульта (PER-802). */
export function consolePromoVideoData(auction: string): string {
  return `v1:ac:vo:${auction}`;
}

/** «Прикрепить видео» и «Заменить видео»: вопрос о видео ответом. */
export function consolePromoVideoAskData(auction: string): string {
  return `v1:ac:vq:${auction}`;
}

/** «Убрать видео»: подтверждение снятия. */
export function consolePromoVideoRemoveData(auction: string): string {
  return `v1:ac:vr:${auction}`;
}

/** «Да» снятия промо-видео; ключ — на нажатие. */
export function consolePromoVideoRemoveConfirmData(auction: string): string {
  return `v1:ac:vy:${auction}`;
}

/** «Да» смены приза: аукцион и отпечаток нового текста; ключ — на нажатие. */
export function consoleRafflePrizeChangeConfirmData(
  auction: string,
  print: string,
): string {
  return `v1:ac:rv:${auction}:${print}`;
}

const templateCodes: Readonly<Record<AnnouncementTemplate, string>> = {
  own: "o",
  raffle: "r",
  windows: "w",
  lot: "l",
  chronicle: "c",
};

const buttonCodes: Readonly<Record<ButtonChoice, string>> = {
  auction: "a",
  lots: "s",
  lot: "l",
  raffle: "r",
  predictions: "p",
  chronicle: "c",
  none: "n",
};

const audienceCodes: Readonly<Record<AnnouncementAudience, string>> = {
  all: "a",
  "not-in-raffle": "r",
  "without-predictions": "p",
  "not-in-raffle-or-without-predictions": "e",
};

// Аудитория — последняя часть кнопки (PER-779): кнопка без неё, выданная до
// шага «Кому», значит «всем», как объявление до него.
function audienceOf(
  raw: string | undefined,
): AnnouncementAudience | "malformed" {
  if (raw === undefined) return "all";
  return codeOf(audienceCodes, raw) ?? "malformed";
}

function codeOf<T extends string>(
  codes: Readonly<Record<T, string>>,
  code: string | undefined,
): T | undefined {
  return (Object.keys(codes) as T[]).find((key) => codes[key] === code);
}

// Номер окна, лота реестра или фото лота в кнопке объявления: трёх цифр
// хватает любому реестру; «-» — номера нет.
const AnnouncementRefSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,2})$/)
  .transform(Number);

function refOf(raw: string | undefined): number | undefined | "malformed" {
  if (raw === undefined || raw === "-") return undefined;
  const parsed = AnnouncementRefSchema.safeParse(raw);
  return parsed.success ? parsed.data : "malformed";
}

function refPart(ref: number | undefined): string {
  return ref === undefined ? "-" : String(ref);
}

// Место фото в кнопке «Отправить»: номер фото лота или `m` и номер поста чата
// медиа в base36 (PER-776) — источник фото у объявления один.
const PostPartSchema = z
  .string()
  .regex(/^m[1-9a-z][0-9a-z]{0,9}$/)
  .transform((raw) => Number.parseInt(raw.slice(1), 36))
  .refine((post) => Number.isSafeInteger(post));

// Фото с отпечатком `photoId` — `<номер>.<отпечаток>` (PER-792): так его
// несёт «Отправить», чтобы взять одобренное фото, а не то, что стоит под
// номером сейчас.
function mediaPart(
  photo: number | undefined,
  post: number | undefined,
  photoPrint?: string,
): string {
  if (post !== undefined) return `m${post.toString(36)}`;
  return photo !== undefined && photoPrint !== undefined
    ? `${refPart(photo)}.${photoPrint}`
    : refPart(photo);
}

function mediaOf(
  raw: string | undefined,
): { photo?: number; photoPrint?: string; post?: number } | "malformed" {
  if (raw?.startsWith("m") === true) {
    const post = PostPartSchema.safeParse(raw);
    return post.success ? { post: post.data } : "malformed";
  }
  const [ref, print, ...rest] = (raw ?? "").split(".");
  if (rest.length > 0) return "malformed";
  const photo = refOf(raw === undefined ? undefined : ref);
  if (photo === "malformed") return "malformed";
  if (print === undefined) return photo === undefined ? {} : { photo };
  const photoPrint = WindowPrintSchema.safeParse(print);
  return photo === undefined || !photoPrint.success
    ? "malformed"
    : { photo, photoPrint: photoPrint.data };
}

/** «Объявление» пульта (PER-765, PER-802): своё объявление или шаблон. */
export function consoleAnnouncementData(auction: string): string {
  return `v1:ac:na:${auction}`;
}

/** Выбор окна «Счастливых часов» для шаблона. */
export function consoleAnnouncementWindowsData(auction: string): string {
  return `v1:ac:nw:${auction}`;
}

/** Выбор лота для «Истории лота». */
export function consoleAnnouncementLotsData(auction: string, page = 0): string {
  return `v1:ac:nl:${auction}:${page}`;
}

/** Вопрос о тексте: шаблон и номер окна или лота. */
export function consoleAnnouncementAskData(
  auction: string,
  template: AnnouncementTemplate,
  ref?: number,
): string {
  return `v1:ac:nq:${auction}:${templateCodes[template]}${ref === undefined ? "" : `:${ref}`}`;
}

/** Кнопка объявления: выбор, отпечаток текста, лот шаблона и аудитория. */
export function consoleAnnouncementButtonData(
  auction: string,
  button: ButtonChoice,
  print: string,
  audience: AnnouncementAudience,
  lot?: number,
): string {
  return `v1:ac:nb:${auction}:${buttonCodes[button]}:${print}:${refPart(lot)}:${audienceCodes[audience]}`;
}

/** Фото лота объявления; без номера — «Пропустить». */
export function consoleAnnouncementPhotoData(
  auction: string,
  button: ButtonChoice,
  print: string,
  audience: AnnouncementAudience,
  lot?: number,
  photo?: number,
): string {
  return `v1:ac:np:${auction}:${buttonCodes[button]}:${print}:${refPart(lot)}:${refPart(photo)}:${audienceCodes[audience]}`;
}

/** «Своё фото или видео» (PER-776): вопрос о медиа с тем же шагом. */
export function consoleAnnouncementMediaData(
  auction: string,
  button: ButtonChoice,
  print: string,
  audience: AnnouncementAudience,
  lot?: number,
): string {
  return `v1:ac:nm:${auction}:${buttonCodes[button]}:${print}:${refPart(lot)}:${audienceCodes[audience]}`;
}

type SendChoice = {
  button: ButtonChoice;
  print: string;
  audience: AnnouncementAudience;
  lot?: number | undefined;
  photo?: number | undefined;
  photoPrint?: string | undefined;
  post?: number | undefined;
};

function sendPart(choice: SendChoice): string {
  return `${buttonCodes[choice.button]}:${choice.print}:${refPart(choice.lot)}:${mediaPart(choice.photo, choice.post, choice.photoPrint)}:${audienceCodes[choice.audience]}`;
}

/**
 * «Отправить N»: всё, кроме текста, — его «Отправить» читает из предпросмотра.
 * Своё медиа — номером поста на месте фото (PER-776), фото лота — номером с
 * отпечатком его `photoId` (PER-792).
 */
export function consoleAnnouncementSendData(
  auction: string,
  choice: SendChoice,
): string {
  return `v1:ac:ns:${auction}:${sendPart(choice)}`;
}

/**
 * Шаг «Кому» (PER-779) с выбранной аудиторией: так его открывает «Нет»
 * подтверждения, а текст читается из предпросмотра.
 */
export function consoleAnnouncementAudienceData(
  auction: string,
  choice: SendChoice,
): string {
  return `v1:ac:nc:${auction}:${sendPart(choice)}`;
}

/** Аудитория шага «Кому»: предпросмотр с числом её получателей. */
export function consoleAnnouncementRecipientsData(
  auction: string,
  choice: SendChoice,
): string {
  return `v1:ac:nk:${auction}:${sendPart(choice)}`;
}

const sendKinds = {
  ns: "console-announcement-send",
  nk: "console-announcement-recipients",
  nc: "console-announcement-audience",
} as const;

function parseAnnouncement(
  parts: readonly string[],
  auction: string,
): AnnouncementAction | { kind: "malformed" } {
  const malformed = { kind: "malformed" } as const;
  switch (parts[2]) {
    case "na":
      return parts.length === 4
        ? { kind: "console-announcement", auction }
        : malformed;
    case "nw":
      return parts.length === 4
        ? { kind: "console-announcement-windows", auction }
        : malformed;
    case "nl": {
      const page = PageSchema.safeParse(parts[4] ?? "0");
      return (parts.length === 4 || parts.length === 5) && page.success
        ? { kind: "console-announcement-lots", auction, page: page.data }
        : malformed;
    }
    case "nq": {
      const template = codeOf(templateCodes, parts[4]);
      const ref = refOf(parts[5]);
      return (parts.length === 5 || parts.length === 6) &&
        template !== undefined &&
        ref !== "malformed"
        ? {
            kind: "console-announcement-ask",
            auction,
            template,
            ...(ref === undefined ? {} : { ref }),
          }
        : malformed;
    }
    default:
      break;
  }
  const button = codeOf(buttonCodes, parts[4]);
  const print = WindowPrintSchema.safeParse(parts[5]);
  const lot = refOf(parts[6]);
  // Части до аудитории: у шагов кнопки и медиа — семь, у фото и «Отправить» —
  // восемь; кнопка шага «Кому» обязана нести аудиторию.
  const length = parts[2] === "nb" || parts[2] === "nm" ? 7 : 8;
  const lengths =
    parts[2] === "nk" || parts[2] === "nc"
      ? [length + 1]
      : [length, length + 1];
  const media = length === 8 ? mediaOf(parts[7]) : {};
  const audience = audienceOf(parts[length]);
  if (
    !lengths.includes(parts.length) ||
    button === undefined ||
    !print.success ||
    lot === "malformed" ||
    media === "malformed" ||
    audience === "malformed"
  ) {
    return malformed;
  }
  const { photo, photoPrint, post } = media;
  // Отпечаток фото несёт только «Отправить», и с фото он обязателен: без
  // него номер снова решал бы, какое фото уйдёт (PER-792).
  if (
    (photoPrint !== undefined || photo !== undefined) &&
    (parts[2] === "ns") !== (photoPrint !== undefined)
  ) {
    return malformed;
  }
  const common = { auction, button, print: print.data, audience };
  switch (parts[2]) {
    case "nb":
      return {
        kind: "console-announcement-button",
        ...common,
        ...(lot === undefined ? {} : { lot }),
      };
    // Без лота шаг фото несёт только «Пропустить» (PER-776).
    case "np":
      return post === undefined && (photo === undefined || lot !== undefined)
        ? {
            kind: "console-announcement-photo",
            ...common,
            ...(lot === undefined ? {} : { lot }),
            ...(photo === undefined ? {} : { photo }),
          }
        : malformed;
    case "nm":
      return {
        kind: "console-announcement-media",
        ...common,
        ...(lot === undefined ? {} : { lot }),
      };
    case "ns":
    case "nk":
    case "nc":
      return photo === undefined || lot !== undefined
        ? {
            kind: sendKinds[parts[2]],
            ...common,
            ...(lot === undefined ? {} : { lot }),
            ...(photo === undefined ? {} : { photo }),
            ...(photoPrint === undefined ? {} : { photoPrint }),
            ...(post === undefined ? {} : { post }),
          }
        : malformed;
    default:
      return malformed;
  }
}

/** «Фото приза» идущего розыгрыша (PER-773): экран фото. */
export function consoleRafflePrizePhotoData(auction: string): string {
  return `v1:ac:rf:${auction}`;
}

/** Вопрос о фото приза: прислать или заменить. */
export function consoleRafflePrizePhotoAskData(auction: string): string {
  return `v1:ac:rg:${auction}`;
}

/** «Убрать фото» приза: подтверждение. */
export function consoleRafflePrizePhotoRemoveData(auction: string): string {
  return `v1:ac:rd:${auction}`;
}

/** «Да» снятия фото приза; ключ — на нажатие. */
export function consoleRafflePrizePhotoRemoveConfirmData(
  auction: string,
): string {
  return `v1:ac:rr:${auction}`;
}

/** Переключатель финала с целевым состоянием. */
export function consoleFinalData(auction: string, final: boolean): string {
  return `v1:ac:f:${auction}:${final ? "1" : "0"}`;
}

/** «Опубликовать» и «Снять с публикации» с целевым состоянием (PER-673). */
export function consoleVisibilityData(
  auction: string,
  published: boolean,
): string {
  return `v1:ac:p:${auction}:${published ? "1" : "0"}`;
}

/** «Открыть онлайн-неделю»: подтверждение, а не команда. */
export function consoleOpenData(auction: string): string {
  return `v1:ac:o:${auction}`;
}

/** «Да» подтверждения открытия: аукцион и ключ команды. */
export function consoleConfirmData(auction: string, op: string): string {
  return `v1:ac:y:${auction}:${op}`;
}

/** «Удалить аукцион»: подтверждение, а не команда. */
export function consoleDiscardData(auction: string): string {
  return `v1:ac:x:${auction}`;
}

/** «Да» подтверждения удаления: аукцион и ключ команды. */
export function consoleDiscardConfirmData(auction: string, op: string): string {
  return `v1:ac:z:${auction}:${op}`;
}

/** «Отменить аукцион»: подтверждение, а не команда. */
export function consoleCancelData(auction: string): string {
  return `v1:ac:u:${auction}`;
}

/** «Да» подтверждения отмены: аукцион и ключ команды. */
export function consoleCancelConfirmData(auction: string, op: string): string {
  return `v1:ac:uy:${auction}:${op}`;
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

/** «Счастливые часы» на пульте: список окон. */
export function consoleWindowsData(auction: string): string {
  return `v1:ac:h:${auction}`;
}

/** «Сводка дня»: текст за сутки со ссылками на лоты в боте аукциона (PER-492). */
export function consoleDaySummaryData(auction: string): string {
  return `v1:ac:ds:${auction}`;
}

/** «Счета» (PER-321): сводка счетов аукциона; первая страница — без номера. */
export function consoleInvoicesData(auction: string, page = 0): string {
  return page === 0 ? `v1:ac:iv:${auction}` : `v1:ac:iv:${auction}:${page}`;
}

/** Счёт: аукцион и счёт токенами, 54 байта. */
export function consoleInvoiceData(auction: string, invoice: string): string {
  return `v1:ac:ic:${auction}:${invoice}`;
}

const invoiceMarkCode: Record<InvoiceMark, string> = {
  paid: "p",
  "handed-over": "h",
};
const InvoiceMarkSchema = z
  .enum(["p", "h"])
  .transform((code): InvoiceMark => (code === "p" ? "paid" : "handed-over"));

/** Отметка оплаты или выдачи — к подтверждению. */
export function consoleInvoiceMarkData(
  auction: string,
  invoice: string,
  mark: InvoiceMark,
): string {
  return `v1:ac:ip:${auction}:${invoice}:${invoiceMarkCode[mark]}`;
}

/** «Да» отметки: 56 байт; ключ команды рождается на нажатие. */
export function consoleInvoiceMarkConfirmData(
  auction: string,
  invoice: string,
  mark: InvoiceMark,
): string {
  return `v1:ac:iy:${auction}:${invoice}:${invoiceMarkCode[mark]}`;
}

/** Окно на странице лотов `page`; первая страница — без номера. */
export function consoleWindowData(
  auction: string,
  window: WindowRef,
  page = 0,
): string {
  const base = `v1:ac:hw:${auction}:${window.index}:${window.print}`;
  return page === 0 ? base : `${base}:${page}`;
}

/** «Добавить окно»: вопрос о сроках и шаге. */
export function consoleWindowAskData(auction: string): string {
  return `v1:ac:ha:${auction}`;
}

/**
 * Лот в окне (`hs`) и вне его (`hd`): целевое состояние, а не переворот. Самая
 * длинная кнопка пульта — 63 байта при двузначном номере окна.
 */
export function consoleWindowLotData(mark: {
  auction: string;
  window: WindowRef;
  lot: string;
  selected: boolean;
}): string {
  return `v1:ac:${mark.selected ? "hs" : "hd"}:${mark.auction}:${mark.window.index}:${mark.window.print}:${mark.lot}`;
}

/** «Удалить окно». */
export function consoleWindowRemoveData(
  auction: string,
  window: WindowRef,
): string {
  return `v1:ac:hx:${auction}:${window.index}:${window.print}`;
}

// Что спрошено о лоте в периоде «Счастливых часов» (PER-787): стартовая или
// шаг.
const happyHourFieldCodes: Readonly<Record<HappyHourField, string>> = {
  start: "t",
  step: "s",
};

function happyHourFieldOf(
  code: string | undefined,
): HappyHourField | undefined {
  return code === "t" ? "start" : code === "s" ? "step" : undefined;
}

/** «Периоды» экрана «Счастливые часы» (PER-787). */
export function consolePeriodsData(auction: string): string {
  return `v1:ac:hh:${auction}`;
}

/** «Создать период»: вопрос о сроках периода. */
export function consolePeriodAskData(auction: string): string {
  return `v1:ac:hq:${auction}`;
}

/** Период: номер в списке и отпечаток его идентификатора. */
export function consolePeriodData(auction: string, period: WindowRef): string {
  return `v1:ac:hv:${auction}:${period.index}:${period.print}`;
}

/** «🗑 Удалить период» — подтверждение. */
export function consolePeriodRemoveData(
  auction: string,
  period: WindowRef,
): string {
  return `v1:ac:hr:${auction}:${period.index}:${period.print}`;
}

/** «Да, удалить» подтверждения: ключ команды рождается на нажатие. */
export function consolePeriodRemoveConfirmData(
  auction: string,
  period: WindowRef,
): string {
  return `v1:ac:hy:${auction}:${period.index}:${period.print}`;
}

/** «🛠 Счастливые часы» карточки лота: периоды с условиями лота. */
export function lotHappyHoursData(lot: string): string {
  return `v1:lot:hh:${lot}`;
}

/** Условия лота в периоде. */
export function lotHappyHourData(lot: string, period: WindowRef): string {
  return `v1:lot:hv:${lot}:${period.index}:${period.print}`;
}

/** «Стартовая цена» и «Шаг» — вопрос о значении. */
export function lotHappyHourAskData(
  lot: string,
  period: WindowRef,
  field: HappyHourField,
): string {
  return `v1:lot:hk:${lot}:${period.index}:${period.print}:${happyHourFieldCodes[field]}`;
}

/** «🗑 Снять условия» без подтверждения: условия задаются заново ответом. */
export function lotHappyHourClearData(lot: string, period: WindowRef): string {
  return `v1:lot:hc:${lot}:${period.index}:${period.print}`;
}

/** «Сеты» пульта: сеты лотов (PER-509, PER-802). */
export function consoleSetsData(auction: string): string {
  return `v1:ac:t:${auction}`;
}

/** «Новый сет»: вопрос о названии. */
export function consoleSetAskData(auction: string): string {
  return `v1:ac:ta:${auction}`;
}

/** Сет на странице лотов `page`; первая страница — без номера. */
export function consoleSetData(
  auction: string,
  set: LotSetRef,
  page = 0,
): string {
  const base = `v1:ac:tw:${auction}:${set.index}:${set.print}`;
  return page === 0 ? base : `${base}:${page}`;
}

/**
 * Лот в сете (`ts`) и вне его (`td`): целевое состояние, а не переворот. Как у
 * лота окна, 63 байта при двузначном номере сета.
 */
export function consoleSetLotData(mark: {
  auction: string;
  set: LotSetRef;
  lot: string;
  selected: boolean;
}): string {
  return `v1:ac:${mark.selected ? "ts" : "td"}:${mark.auction}:${mark.set.index}:${mark.set.print}:${mark.lot}`;
}

/** «Удалить сет»: подтверждение, а не команда. */
export function consoleSetDeleteData(auction: string, set: LotSetRef): string {
  return `v1:ac:tx:${auction}:${set.index}:${set.print}`;
}

/** «Да» удаления сета: ключ команды рождается на нажатие. */
export function consoleSetDeleteConfirmData(
  auction: string,
  set: LotSetRef,
): string {
  return `v1:ac:ty:${auction}:${set.index}:${set.print}`;
}

/** «Порядок» пульта: разделы ленты и общий список (PER-719). */
export function consoleLayoutData(auction: string): string {
  return `v1:ac:m:${auction}`;
}

/** Список раздела `place` или общий список (`0`) на странице `page`. */
export function consoleLayoutListData(
  auction: string,
  place: number,
  page = 0,
): string {
  const base = `v1:ac:ml:${auction}:${place}`;
  return page === 0 ? base : `${base}:${page}`;
}

/** Лот в раскладке; `mu` и `md` — тот же лот выше и ниже. */
export function consoleLayoutLotData(
  auction: string,
  lot: string,
  move?: "up" | "down",
): string {
  const code = move === undefined ? "mo" : move === "up" ? "mu" : "md";
  return `v1:ac:${code}:${auction}:${lot}`;
}

/** Лот в раздел `place` или в общий список (`0`): 58 байт при трёх цифрах. */
export function consoleLayoutPlaceData(
  auction: string,
  lot: string,
  place: number,
): string {
  return `v1:ac:mv:${auction}:${lot}:${place}`;
}

/** «Новый раздел» и, с номером, «Переименовать»: вопрос о названии. */
export function consoleSectionAskData(
  auction: string,
  section?: number,
): string {
  return section === undefined
    ? `v1:ac:mq:${auction}`
    : `v1:ac:mr:${auction}:${section}`;
}

/** Раздел выше (`mh`) и ниже (`mj`). */
export function consoleSectionMoveData(
  auction: string,
  section: number,
  direction: "up" | "down",
): string {
  return `v1:ac:${direction === "up" ? "mh" : "mj"}:${auction}:${section}`;
}

/** «Удалить раздел»: подтверждение (`mx`) и «Да» (`my`). */
export function consoleSectionDeleteData(
  auction: string,
  section: number,
  confirmed = false,
): string {
  return `v1:ac:${confirmed ? "my" : "mx"}:${auction}:${section}`;
}

/** «Запустить окно»: вопрос о начале, конце и шаге (PER-615). */
export function consoleWindowLaunchData(auction: string): string {
  return `v1:ac:hl:${auction}`;
}

/**
 * Запуск окна по ходу торгов (PER-615): черновик едет в кнопке — состояния у
 * пульта нет, а лот в кнопку не помещается. Номер лота — в отсортированном
 * реестре, набор — маской по нему.
 */
export function consoleWindowLaunchGoData(
  auction: string,
  draft: LaunchDraft,
): string {
  return `v1:ac:hm:${auction}:${encodeLaunchDraft(draft)}`;
}

/** Лот запускаемого окна: номер лота в отсортированном реестре, набор — в маске. */
export function consoleWindowLaunchLotData(
  auction: string,
  draft: LaunchDraft,
  lot: number,
): string {
  return `v1:ac:ht:${auction}:${encodeLaunchDraft(draft)}:${lot.toString(36)}`;
}

/** Страница лотов запускаемого окна. */
export function consoleWindowLaunchPageData(
  auction: string,
  draft: LaunchDraft,
  page = 0,
): string {
  const base = `v1:ac:hp:${auction}:${encodeLaunchDraft(draft)}`;
  return page === 0 ? base : `${base}:${page}`;
}

/** «Объявить состав финала» и «Заново»: выбор порядка с первого лота. */
export function consoleLineupData(auction: string): string {
  return `v1:ac:l:${auction}`;
}

function lineupOrderToken(order: readonly number[]): string {
  return order.length === 0
    ? emptyLineupOrder
    : order.map((at) => at.toString(36)).join("");
}

/**
 * Следующий лот порядка или страница выбора: отпечаток набора удержанных,
 * выбранные номера и страница. Двадцать четыре лота с однозначной страницей —
 * ровно 64 байта.
 */
export function consoleLineupPickData(
  auction: string,
  pick: LineupPick,
  page = 0,
): string {
  const base = `v1:ac:lo:${auction}:${pick.print}:${lineupOrderToken(pick.order)}`;
  return page === 0 ? base : `${base}:${page}`;
}

/** «Да» подтверждения состава: полный порядок; ключ рождается на нажатие. */
export function consoleLineupConfirmData(
  auction: string,
  pick: LineupPick,
): string {
  return `v1:ac:ly:${auction}:${pick.print}:${lineupOrderToken(pick.order)}`;
}

/** «Начать финал». */
export function consoleStartFinalData(auction: string): string {
  return `v1:ac:g:${auction}`;
}

/** «Открыть следующий лот» финала. */
export function consoleNextLotData(auction: string): string {
  return `v1:ac:n:${auction}`;
}

/** Подтверждение открытия лота финала (PER-816). */
export function consoleOpenAskData(auction: string): string {
  return `v1:ac:go:${auction}`;
}

/** «Поднять цену» лота финала с номером `position` в составе. */
export function consoleAskData(auction: string, position: number): string {
  return `v1:ac:a:${auction}:${position}`;
}

/** «Продать»: подтверждение закрытия, а не команда. */
export function consoleCloseData(auction: string, position: number): string {
  return `v1:ac:c:${auction}:${position}`;
}

/**
 * «Да» подтверждения закрытия: аукцион, номер лота, ключ и названное — цена
 * в минорных единицах по основанию 36 либо `x`, закрытие без продажи. Цена
 * до девяти миллионов рублей — шесть знаков, и с трёхзначным номером строка
 * укладывается в 64 байта.
 */
export function consoleCloseConfirmData(
  auction: string,
  position: number,
  op: string,
  quote: CloseQuote,
): string {
  const named =
    quote.kind === "sale" ? quote.minorUnits.toString(36) : noSaleQuote;
  return `v1:ac:k:${auction}:${position}:${op}:${named}`;
}

/**
 * «Ставки зала» (PER-565): `v1:ac:b:<аукцион>[:<страница>]`. Экран и его
 * «Обновить» — одна кнопка.
 */
export function floorData(auction: string, page = 0): string {
  return page === 0 ? `v1:ac:b:${auction}` : `v1:ac:b:${auction}:${page}`;
}

/** «Другой человек…»: вопрос об имени. */
export function floorSearchData(auction: string): string {
  return `v1:ac:bs:${auction}`;
}

/** Кнопка лидера: ставка за него не нужна, Auction её не видит. */
export function floorLeaderData(auction: string): string {
  return `v1:ac:bl:${auction}`;
}

/** Снятие участника (PER-659): кого снять с лота. */
export function removalData(lot: string, page = 0): string {
  return page === 0 ? `v1:ac:e:${lot}` : `v1:ac:e:${lot}:${page}`;
}

/** Человек — к предпросмотру и подтверждению. */
export function removalPickData(lot: string, person: string): string {
  return `v1:ac:ep:${lot}:${person}`;
}

/**
 * «Да» снятия: номер лота предпросмотра по основанию 36. Восемь знаков — до
 * двух триллионов событий лота, и строка занимает до 64 байт.
 */
export function removalConfirmData(
  lot: string,
  person: string,
  version: number,
): string {
  return `v1:ac:ey:${lot}:${person}:${version.toString(36)}`;
}

const LotVersionSchema = z
  .string()
  .regex(/^[1-9a-z][0-9a-z]{0,7}$/)
  .transform((raw) => Number.parseInt(raw, 36));

/**
 * Кнопка человека зала и «Да» подтверждения: лот, человек и цена в минорных
 * единицах по основанию 36. Семь знаков — до восьмисот миллиардов рублей, и
 * строка занимает до 62 байт из 64.
 */
export function floorPickData(
  lot: string,
  person: string,
  minorUnits: number,
): string {
  return `v1:ac:bp:${lot}:${person}:${minorUnits.toString(36)}`;
}

export function floorConfirmData(
  lot: string,
  person: string,
  minorUnits: number,
): string {
  return `v1:ac:by:${lot}:${person}:${minorUnits.toString(36)}`;
}

const FloorAmountSchema = z
  .string()
  .regex(/^[1-9a-z][0-9a-z]{0,6}$/)
  .transform((raw) => Number.parseInt(raw, 36));

const noSaleQuote = "x";
const QuoteSchema = z
  .string()
  .regex(/^(x|0|[1-9a-z][0-9a-z]{0,6})$/)
  .transform(
    (raw): CloseQuote =>
      raw === noSaleQuote
        ? { kind: "no-sale" }
        : { kind: "sale", minorUnits: Number.parseInt(raw, 36) },
  );

/** Кнопка FAQ из корня ленты аукциона сходки; `viaEvents` — вход из «Событий». */
export function auctionFaqData(auction: string, viaEvents = false): string {
  return viaEvents ? `v1:faq:${auction}:e` : `v1:faq:${auction}`;
}

/**
 * Данные кнопки «Отмена» для вопроса с этим шагом, заданного человеку
 * `askedBy`. Id идёт последней частью: самый длинный шаг — `ln` с токеном
 * аукциона и ключом создания лота — занимает с ним 60 байт из 64.
 */
export function questionData(step: QuestionStep, askedBy: number): string {
  return `${stepData(step)}:${askedBy}`;
}

// Первая буква кода вопроса формы лота: `l` — правка одного лота, `c` —
// цепочка нового лота (PER-618), `s` — правка всех лотов сета (PER-716).
function lotLead(step: { chain?: true; set?: true }): string {
  return step.chain === true ? "c" : step.set === true ? "s" : "l";
}

function stepData(step: QuestionStep): string {
  switch (step.kind) {
    case "lot-new":
      return `v1:q:ln:${step.auction}:${step.key}`;
    case "lot-text":
      return `v1:q:${step.set === true ? "s" : "l"}${step.field === "title" ? "t" : "d"}:${step.lot}`;
    // Цепочка нового лота (PER-618) — свои коды: `cp`, `cs`/`cy`, `ci`; правка
    // всех лотов сета (PER-716) — `sp`, `ss`/`sy`, `si`.
    case "lot-price":
      return `v1:q:${lotLead(step)}p:${step.lot}`;
    case "lot-step":
      // `ls` — один шаг, `ly` — пороги: способ восстанавливается из кнопки.
      return `v1:q:${lotLead(step)}${step.mode === "single" ? "s" : "y"}:${step.lot}:${step.price}`;
    case "lot-image":
      return `v1:q:${lotLead(step)}i:${step.lot}`;
    case "lot-copies":
      return `v1:q:lc:${step.lot}`;
    case "console-period":
      return `v1:q:hh:${step.auction}`;
    case "happy-hour-lot":
      return `v1:q:hk:${step.lot}:${step.period.index}:${step.period.print}:${happyHourFieldCodes[step.field]}`;
    case "console-week":
      return `v1:q:aw:${step.auction}`;
    case "console-raffle":
      return `v1:q:ar:${step.auction}`;
    case "console-raffle-prize":
      return `v1:q:ap:${step.auction}`;
    case "console-payment-term":
      return `v1:q:pt:${step.auction}`;
    case "console-final-time":
      return `v1:q:ft:${step.auction}`;
    case "console-payment-text":
      return `v1:q:ai:${step.auction}`;
    case "console-raffle-winner":
      return `v1:q:rw:${step.auction}`;
    case "console-raffle-prize-change":
      return `v1:q:rn:${step.auction}`;
    case "console-raffle-prize-photo":
      return `v1:q:rf:${step.auction}`;
    case "console-promo-video":
      return `v1:q:vp:${step.auction}`;
    case "console-window":
      return `v1:q:ah:${step.auction}`;
    case "console-launch":
      return `v1:q:al:${step.auction}`;
    case "console-set":
      return `v1:q:as:${step.auction}`;
    case "console-announcement-media":
      return `v1:q:am:${step.auction}:${buttonCodes[step.button]}:${step.print}:${refPart(step.lot)}:${audienceCodes[step.audience]}`;
    case "console-announcement":
      return `v1:q:ao:${step.auction}:${templateCodes[step.template]}${step.ref === undefined ? "" : `:${step.ref}`}`;
    case "console-section":
      return step.section === undefined
        ? `v1:q:aq:${step.auction}`
        : `v1:q:ae:${step.auction}:${step.section}`;
    case "final-ask":
      return `v1:q:fa:${step.auction}:${step.position}`;
    case "floor-search":
      return `v1:q:fs:${step.auction}`;
    case "field":
      return `v1:q:${step.mode === "edit" ? "fe" : step.fresh === "meetups" ? "fn" : step.fresh === "manage" ? "fg" : "fc"}:${step.token}:${step.field}`;
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
    case "administrator":
      return "v1:q:an";
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

/** Данные кнопки «Подать заявку» без кода канала. */
export const applyData = "v1:apply";

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
  if (parsed.data === applyData) return { kind: "apply" };
  if (parsed.data.startsWith(`${applyData}:`)) {
    const code = parsed.data.slice(applyData.length + 1);
    return /^[A-Za-z0-9_-]*$/.test(code)
      ? { kind: "apply", sourceCode: code }
      : { kind: "malformed" };
  }
  if (parsed.data === "v1:nav:settings") return { kind: "settings" };
  if (parsed.data === "v1:nav:ext") return { kind: "settings-extensions" };
  if (parsed.data === "v1:nav:exta") return { kind: "settings-auction" };
  if (parsed.data === "v1:nav:help") return { kind: "help" };
  if (parts[1] === "wn") return parseReleaseNotes(parts);
  if (parsed.data === "v1:nav:next") return { kind: "next" };
  if (parsed.data === "v1:nav:events") return { kind: "events" };
  if (parts.length === 4 && parts[1] === "manage" && parts[2] === "g") {
    const group = manageGroupOf(parts[3] ?? "");
    return group === undefined
      ? { kind: "malformed" }
      : { kind: "manage-group", group };
  }
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
  if (parts.length === 3 && parts[1] === "ext") {
    const extToken = TokenSchema.safeParse(parts[2]);
    return extToken.success
      ? { kind: "meetup-extensions", token: extToken.data }
      : { kind: "malformed" };
  }
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
  if (parts[1] === "ad") {
    return parseAdministrators(parts);
  }
  if (parts[1] === "aq") {
    return parseApplicationQueue(parts, "auction");
  }
  // Кнопки состава одним списком из прошлого релиза. «Закрыть» там исполнялось
  // сразу; теперь та же кнопка ведёт в подтверждение, как и новая. Допуск из
  // состава ушёл в «Заявки» (PER-547), и его кнопка устарела.
  if (parts.length === 4 && parts[1] === "community") {
    const username = parts[3] ?? "";
    if (parts[2] === "remove" && removableUsernamePattern.test(username)) {
      return { kind: "remove-allowed-username", username, page: 0 };
    }
    const identityToken = TokenSchema.safeParse(parts[3]);
    if (!identityToken.success) return { kind: "malformed" };
    if (parts[2] === "admit") return { kind: "outdated" };
    if (parts[2] === "block")
      return {
        kind: "ask-block-member",
        token: identityToken.data,
        place: firstMembersPage,
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
    if (!auction.success) return { kind: "malformed" };
    if (parts.length === 3)
      return { kind: "auction-faq", auction: auction.data };
    return parts.length === 4 && parts[3] === "e"
      ? { kind: "auction-faq", auction: auction.data, viaEvents: true }
      : { kind: "malformed" };
  }
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success || parts[1] !== "manage") {
    return { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "new")
    return { kind: "create-meetup", token: token.data };
  if (parts.length === 5 && parts[2] === "new" && parts[4] === "s")
    return { kind: "create-meetup", token: token.data, from: "meetups" };
  if (parts.length === 4 && parts[2] === "publish")
    return { kind: "publish-meetup", token: token.data };
  if (parts.length === 5 && parts[2] === "publish") {
    const version = VersionSchema.safeParse(parts[4]);
    return version.success
      ? { kind: "publish-meetup", token: token.data, version: version.data }
      : { kind: "malformed" };
  }
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
    return { kind: "enable-auction", token: token.data };
  if (parts.length === 4 && parts[2] === "republish")
    return { kind: "manage-publish", token: token.data, origin: "status" };
  // `d` — «Опубликовать» на черновике: «Нет» подтверждения вернёт на него.
  if (parts.length === 5 && parts[2] === "republish" && parts[4] === "d")
    return { kind: "manage-publish", token: token.data, origin: "draft" };
  if (parts.length === 5 && parts[2] === "confirm-publish") {
    const version = VersionSchema.safeParse(parts[4]);
    return version.success
      ? {
          kind: "manage-confirm-publish",
          token: token.data,
          version: version.data,
        }
      : { kind: "malformed" };
  }
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

// Кнопки формы лота: `v1:lot:new:<аукцион>`, `v1:lot:form:<лот>`,
// `v1:lot:view:<лот>`, `v1:lot:ask:<лот>:<поле>[:c|:s]`,
// `v1:lot:sm:<лот>:<цена>:<способ>[:c|:s]`, `v1:lot:sk:<лот>:<цена>[:s]`,
// `v1:lot:skip:<лот>`, `v1:lot:ph:<лот>` (экран «Фото лота», PER-721),
// `v1:lot:rm:<лот>:<номер>` и `v1:lot:ry:<лот>:<отпечаток фото>` («Убрать
// фото N» и его «Да», PER-715, PER-721) и прежняя `v1:lot:rm:<лот>`, которая
// открывает экран фото; `:c` — кнопка цепочки нового лота (PER-618). Копии,
// сет и удаление (PER-716): `v1:lot:cp:<лот>`, `v1:lot:sc:<лот>:<поле>`,
// `v1:lot:sr:<лот>:<поле>`, `v1:lot:dl:<лот>` и `v1:lot:dy:<лот>`; `:s` —
// правка всех лотов сета.
function parseLot(parts: readonly string[]): CallbackAction {
  const token = TokenSchema.safeParse(parts[3]);
  if (!token.success) return { kind: "malformed" };
  if (parts.length === 4 && parts[2] === "new") {
    return { kind: "lot-new", auction: token.data };
  }
  if (parts.length === 4 && parts[2] === "form") {
    return { kind: "lot-form", lot: token.data };
  }
  if (parts.length === 4 && parts[2] === "view") {
    return { kind: "lot-view", lot: token.data };
  }
  if (parts.length === 4 && parts[2] === "skip") {
    return { kind: "lot-skip", lot: token.data };
  }
  if (parts.length === 4 && parts[2] === "cp") {
    return { kind: "lot-copy", lot: token.data };
  }
  if (parts.length === 4 && parts[2] === "dl") {
    return { kind: "lot-remove", lot: token.data };
  }
  if (parts.length === 4 && parts[2] === "dy") {
    return { kind: "lot-remove-confirm", lot: token.data };
  }
  // «Счастливые часы» лота (PER-787).
  if (parts.length === 4 && parts[2] === "hh") {
    return { kind: "lot-happy-hours", lot: token.data };
  }
  if (parts[2] === "hv" || parts[2] === "hk" || parts[2] === "hc") {
    const index = WindowIndexSchema.safeParse(parts[4]);
    const print = WindowPrintSchema.safeParse(parts[5]);
    if (!index.success || !print.success) return { kind: "malformed" };
    const period = { index: index.data, print: print.data };
    if (parts[2] === "hk") {
      const field = happyHourFieldOf(parts[6]);
      return parts.length === 7 && field !== undefined
        ? { kind: "lot-happy-hour-ask", lot: token.data, period, field }
        : { kind: "malformed" };
    }
    if (parts.length !== 6) return { kind: "malformed" };
    return parts[2] === "hv"
      ? { kind: "lot-happy-hour", lot: token.data, period }
      : { kind: "lot-happy-hour-clear", lot: token.data, period };
  }
  if (parts.length === 6 && parts[2] === "sr" && parts[4] === "image") {
    const print = WindowPrintSchema.safeParse(parts[5]);
    return print.success
      ? {
          kind: "lot-set-retry",
          lot: token.data,
          field: "image",
          print: print.data,
        }
      : { kind: "malformed" };
  }
  if (parts.length === 5 && (parts[2] === "sc" || parts[2] === "sr")) {
    const field = LotFormFieldSchema.safeParse(parts[4]);
    if (!field.success) return { kind: "malformed" };
    return {
      kind: parts[2] === "sc" ? "lot-scope" : "lot-set-retry",
      lot: token.data,
      field: field.data,
    };
  }
  if ((parts.length === 5 || parts.length === 6) && parts[2] === "sk") {
    const price = RublesSchema.safeParse(parts[4]);
    const set =
      parts.length === 5
        ? {}
        : parts[5] === "s"
          ? { set: true as const }
          : undefined;
    return price.success && set !== undefined
      ? { kind: "lot-keep-step", lot: token.data, price: price.data, ...set }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "ph") {
    return { kind: "lot-photos", lot: token.data };
  }
  // «Убрать фото» под вопросом о фото до PER-721: открывает экран фото.
  if (parts.length === 4 && parts[2] === "rm") {
    return { kind: "lot-photos", lot: token.data, fromQuestion: true };
  }
  if (parts.length === 5 && parts[2] === "rm") {
    const index = PhotoIndexSchema.safeParse(parts[4]);
    return index.success
      ? { kind: "lot-photo-remove", lot: token.data, index: index.data }
      : { kind: "malformed" };
  }
  if (parts.length === 5 && parts[2] === "ry") {
    const print = WindowPrintSchema.safeParse(parts[4]);
    return print.success
      ? { kind: "lot-photo-remove-confirm", lot: token.data, print: print.data }
      : { kind: "malformed" };
  }
  // Хвост цепочки — только `c` и только у цены и фото: у названия и описания
  // цепочки нет. Хвост `s` — правка всех лотов сета (PER-716), у любого поля.
  const chain = (at: number) =>
    parts.length === at + 1 && parts[at] === "c"
      ? { chain: true as const }
      : parts.length === at + 1 && parts[at] === "s"
        ? { set: true as const }
        : parts.length === at
          ? {}
          : undefined;
  if (parts[2] === "ask") {
    const field = LotFormFieldSchema.safeParse(parts[4]);
    const tail = chain(5);
    if (!field.success || tail === undefined) return { kind: "malformed" };
    if ("chain" in tail && field.data !== "price" && field.data !== "image") {
      return { kind: "malformed" };
    }
    return { kind: "lot-ask", lot: token.data, field: field.data, ...tail };
  }
  if (parts[2] === "sm") {
    const price = RublesSchema.safeParse(parts[4]);
    const mode = LotStepModeSchema.safeParse(parts[5]);
    const tail = chain(6);
    return price.success && mode.success && tail !== undefined
      ? {
          kind: "lot-step-mode",
          lot: token.data,
          price: price.data,
          mode: mode.data,
          ...tail,
        }
      : { kind: "malformed" };
  }
  return { kind: "malformed" };
}

// Кнопки пульта аукциона (PER-320): `v1:ac:v:<аукцион>[:<страница>]`,
// `v1:ac:w:<аукцион>`, `v1:ac:f:<аукцион>:<0|1>`, `v1:ac:o:<аукцион>`,
// `v1:ac:y:<аукцион>:<ключ>`, `v1:ac:x:<аукцион>`, `v1:ac:z:<аукцион>:<ключ>`
// и `v1:ac:<s|d>:<аукцион>:<лот>:<страница>`. Состав финала (PER-619):
// `v1:ac:l:<аукцион>`, `v1:ac:lo:<аукцион>:<отпечаток>:<порядок>[:<страница>]`
// и `v1:ac:ly:<аукцион>:<отпечаток>:<порядок>`. Финал (PER-337):
// `v1:ac:g:<аукцион>`, `v1:ac:n:<аукцион>`, `v1:ac:<a|c>:<аукцион>:<номер>` и
// `v1:ac:k:<аукцион>:<номер>:<ключ>:<названное>`. «Счастливые часы»
// (PER-504): `v1:ac:h:<аукцион>`, `v1:ac:ha:<аукцион>`,
// `v1:ac:hw:<аукцион>:<окно>:<отпечаток>[:<страница>]`,
// `v1:ac:<hs|hd>:<аукцион>:<окно>:<отпечаток>:<лот>` и
// `v1:ac:hx:<аукцион>:<окно>:<отпечаток>`. Сеты лотов (PER-509):
// `v1:ac:t:<аукцион>`, `v1:ac:ta:<аукцион>`,
// `v1:ac:tw:<аукцион>:<сет>:<отпечаток>[:<страница>]`,
// `v1:ac:<ts|td>:<аукцион>:<сет>:<отпечаток>:<лот>` и
// `v1:ac:<tx|ty>:<аукцион>:<сет>:<отпечаток>`. Розыгрыш (PER-593):
// `v1:ac:r:<аукцион>` и `v1:ac:rx:<аукцион>`, итог вручную (PER-727):
// `v1:ac:rw:<аукцион>[:<страница>]`, `v1:ac:ra:<аукцион>` и
// `v1:ac:<rc|ry>:<аукцион>:<билет>`, смена приза (PER-737): `v1:ac:rn:<аукцион>`
// и `v1:ac:rv:<аукцион>:<отпечаток>`, фото приза (PER-773):
// `v1:ac:<rf|rg|rd|rr>:<аукцион>`. Видимость (PER-673):
// и `v1:ac:rv:<аукцион>:<отпечаток>`, промо-видео (PER-774):
// `v1:ac:<vo|vq|vr|vy>:<аукцион>`. Видимость (PER-673):
// `v1:ac:p:<аукцион>:<0|1>`. «Ставки зала» (PER-565):
// `v1:ac:b:<аукцион>[:<страница>]`, `v1:ac:<bs|bl>:<аукцион>` и
// `v1:ac:<bp|by>:<лот>:<человек>:<цена>`.
function parseConsole(parts: readonly string[]): CallbackAction {
  const auction = TokenSchema.safeParse(parts[3]);
  if (!auction.success) return { kind: "malformed" };
  const index = WindowIndexSchema.safeParse(parts[4]);
  const print = WindowPrintSchema.safeParse(parts[5]);
  const window =
    index.success && print.success
      ? { index: index.data, print: print.data }
      : undefined;
  // Объявление аукциона (PER-765): двухбуквенные коды на «n».
  if (parts[2]?.length === 2 && parts[2].startsWith("n")) {
    return parseAnnouncement(parts, auction.data);
  }
  switch (parts[2]) {
    case "b": {
      const page = PageSchema.safeParse(parts[4] ?? "0");
      return (parts.length === 4 || parts.length === 5) && page.success
        ? { kind: "console-floor", auction: auction.data, page: page.data }
        : { kind: "malformed" };
    }
    case "bs":
      return parts.length === 4
        ? { kind: "console-floor-search", auction: auction.data }
        : { kind: "malformed" };
    case "bl":
      return parts.length === 4
        ? { kind: "console-floor-leader", auction: auction.data }
        : { kind: "malformed" };
    // Третья часть здесь — лот, а не аукцион: токен у них одной формы.
    case "bp":
    case "by": {
      const person = TokenSchema.safeParse(parts[4]);
      const amount = FloorAmountSchema.safeParse(parts[5]);
      return parts.length === 6 && person.success && amount.success
        ? {
            kind:
              parts[2] === "bp"
                ? "console-floor-pick"
                : "console-floor-confirm",
            lot: auction.data,
            person: person.data,
            minorUnits: amount.data,
          }
        : { kind: "malformed" };
    }
    case "ds":
      return parts.length === 4
        ? { kind: "console-day-summary", auction: auction.data }
        : { kind: "malformed" };
    case "iv": {
      const page = PageSchema.safeParse(parts[4] ?? "0");
      return (parts.length === 4 || parts.length === 5) && page.success
        ? { kind: "console-invoices", auction: auction.data, page: page.data }
        : { kind: "malformed" };
    }
    case "ic": {
      const invoice = TokenSchema.safeParse(parts[4]);
      return parts.length === 5 && invoice.success
        ? {
            kind: "console-invoice",
            auction: auction.data,
            invoice: invoice.data,
          }
        : { kind: "malformed" };
    }
    // Итог розыгрыша вручную (PER-727): список `rw` со страницей, вопрос `ra`,
    // подтверждение `rc` и «Да» `ry` с номером билета.
    case "rw": {
      const page = PageSchema.safeParse(parts[4] ?? "0");
      return (parts.length === 4 || parts.length === 5) && page.success
        ? {
            kind: "console-raffle-winner",
            auction: auction.data,
            page: page.data,
          }
        : { kind: "malformed" };
    }
    case "ra":
      return parts.length === 4
        ? { kind: "console-raffle-winner-ask", auction: auction.data }
        : { kind: "malformed" };
    case "rc":
    case "ry": {
      const ticket = TicketSchema.safeParse(parts[4]);
      if (parts.length !== 5 || !ticket.success) return { kind: "malformed" };
      return {
        kind:
          parts[2] === "rc"
            ? "console-raffle-winner-pick"
            : "console-raffle-winner-confirm",
        auction: auction.data,
        ticket: ticket.data,
      };
    }
    // Промо-видео (PER-774): экран `vo`, вопрос `vq`, подтверждение снятия
    // `vr` и «Да» `vy`.
    case "vo":
    case "vq":
    case "vr":
    case "vy":
      return parts.length === 4
        ? {
            kind:
              parts[2] === "vo"
                ? "console-promo-video"
                : parts[2] === "vq"
                  ? "console-promo-video-ask"
                  : parts[2] === "vr"
                    ? "console-promo-video-remove"
                    : "console-promo-video-remove-confirm",
            auction: auction.data,
          }
        : { kind: "malformed" };
    // Смена приза идущего розыгрыша (PER-737): вопрос `rn` и «Да» `rv` с
    // отпечатком текста.
    case "rn":
      return parts.length === 4
        ? { kind: "console-raffle-prize-change", auction: auction.data }
        : { kind: "malformed" };
    case "rv": {
      const print = WindowPrintSchema.safeParse(parts[4]);
      return parts.length === 5 && print.success
        ? {
            kind: "console-raffle-prize-change-confirm",
            auction: auction.data,
            print: print.data,
          }
        : { kind: "malformed" };
    }
    // Фото приза идущего розыгрыша (PER-773): экран `rf`, вопрос `rg`,
    // подтверждение снятия `rd` и «Да» `rr`.
    case "rf":
    case "rg":
    case "rd":
    case "rr":
      return parts.length === 4
        ? {
            kind: (
              {
                rf: "console-raffle-prize-photo",
                rg: "console-raffle-prize-photo-ask",
                rd: "console-raffle-prize-photo-remove",
                rr: "console-raffle-prize-photo-remove-confirm",
              } as const
            )[parts[2]],
            auction: auction.data,
          }
        : { kind: "malformed" };
    // Текст «Как оплатить и получить» (PER-322): вопрос `it` и снятие `ix`.
    case "it":
      return parts.length === 4
        ? { kind: "console-payment-text", auction: auction.data }
        : { kind: "malformed" };
    case "ix":
      return parts.length === 4
        ? { kind: "console-payment-text-remove", auction: auction.data }
        : { kind: "malformed" };
    case "ip":
    case "iy": {
      const invoice = TokenSchema.safeParse(parts[4]);
      const mark = InvoiceMarkSchema.safeParse(parts[5]);
      if (parts.length !== 6 || !invoice.success || !mark.success) {
        return { kind: "malformed" };
      }
      const target = {
        auction: auction.data,
        invoice: invoice.data,
        mark: mark.data,
      };
      return parts[2] === "ip"
        ? { kind: "console-invoice-mark", ...target }
        : { kind: "console-invoice-mark-confirm", ...target };
    }
    // Третья часть здесь — лот, а не аукцион: токен у них одной формы.
    case "e": {
      const page = PageSchema.safeParse(parts[4] ?? "0");
      return (parts.length === 4 || parts.length === 5) && page.success
        ? { kind: "console-removal", lot: auction.data, page: page.data }
        : { kind: "malformed" };
    }
    case "ep": {
      const person = TokenSchema.safeParse(parts[4]);
      return parts.length === 5 && person.success
        ? {
            kind: "console-removal-pick",
            lot: auction.data,
            person: person.data,
          }
        : { kind: "malformed" };
    }
    case "ey": {
      const person = TokenSchema.safeParse(parts[4]);
      const version = LotVersionSchema.safeParse(parts[5]);
      return parts.length === 6 && person.success && version.success
        ? {
            kind: "console-removal-confirm",
            lot: auction.data,
            person: person.data,
            version: version.data,
          }
        : { kind: "malformed" };
    }
    case "h":
      return parts.length === 4
        ? { kind: "console-windows", auction: auction.data }
        : { kind: "malformed" };
    case "ha":
      return parts.length === 4
        ? { kind: "console-window-ask", auction: auction.data }
        : { kind: "malformed" };
    case "hw": {
      const page = PageSchema.safeParse(parts[6] ?? "0");
      return (parts.length === 6 || parts.length === 7) &&
        window !== undefined &&
        page.success
        ? {
            kind: "console-window",
            auction: auction.data,
            window,
            page: page.data,
          }
        : { kind: "malformed" };
    }
    case "hs":
    case "hd": {
      const lot = TokenSchema.safeParse(parts[6]);
      return parts.length === 7 && window !== undefined && lot.success
        ? {
            kind: "console-window-lot",
            auction: auction.data,
            window,
            lot: lot.data,
            selected: parts[2] === "hs",
          }
        : { kind: "malformed" };
    }
    case "hx":
      return parts.length === 6 && window !== undefined
        ? { kind: "console-window-remove", auction: auction.data, window }
        : { kind: "malformed" };
    // Периоды «Счастливых часов» (PER-787): номер и отпечаток периода стоят
    // там же, где у окна.
    case "hh":
      return parts.length === 4
        ? { kind: "console-periods", auction: auction.data }
        : { kind: "malformed" };
    case "hq":
      return parts.length === 4
        ? { kind: "console-period-ask", auction: auction.data }
        : { kind: "malformed" };
    case "hv":
    case "hr":
    case "hy":
      return parts.length === 6 && window !== undefined
        ? {
            kind:
              parts[2] === "hv"
                ? "console-period"
                : parts[2] === "hr"
                  ? "console-period-remove"
                  : "console-period-remove-confirm",
            auction: auction.data,
            period: window,
          }
        : { kind: "malformed" };
    // Сеты лотов (PER-509): номер и отпечаток сета стоят там же, где у окна.
    case "t":
      return parts.length === 4
        ? { kind: "console-sets", auction: auction.data }
        : { kind: "malformed" };
    case "ta":
      return parts.length === 4
        ? { kind: "console-set-ask", auction: auction.data }
        : { kind: "malformed" };
    case "tw": {
      const page = PageSchema.safeParse(parts[6] ?? "0");
      return (parts.length === 6 || parts.length === 7) &&
        window !== undefined &&
        page.success
        ? {
            kind: "console-set",
            auction: auction.data,
            set: window,
            page: page.data,
          }
        : { kind: "malformed" };
    }
    case "ts":
    case "td": {
      const lot = TokenSchema.safeParse(parts[6]);
      return parts.length === 7 && window !== undefined && lot.success
        ? {
            kind: "console-set-lot",
            auction: auction.data,
            set: window,
            lot: lot.data,
            selected: parts[2] === "ts",
          }
        : { kind: "malformed" };
    }
    case "tx":
    case "ty":
      return parts.length === 6 && window !== undefined
        ? {
            kind:
              parts[2] === "tx"
                ? "console-set-delete"
                : "console-set-delete-confirm",
            auction: auction.data,
            set: window,
          }
        : { kind: "malformed" };
    case "hl":
      return parts.length === 4
        ? { kind: "console-window-launch", auction: auction.data }
        : { kind: "malformed" };
    // Порядок и разделы ленты (PER-719).
    case "m":
      return parts.length === 4
        ? { kind: "console-layout", auction: auction.data }
        : { kind: "malformed" };
    case "ml": {
      const place = SectionSchema.safeParse(parts[4]);
      const page = PageSchema.safeParse(parts[5] ?? "0");
      return (parts.length === 5 || parts.length === 6) &&
        place.success &&
        page.success
        ? {
            kind: "console-layout-list",
            auction: auction.data,
            place: place.data,
            page: page.data,
          }
        : { kind: "malformed" };
    }
    case "mo":
    case "mu":
    case "md": {
      const lot = TokenSchema.safeParse(parts[4]);
      if (parts.length !== 5 || !lot.success) return { kind: "malformed" };
      return parts[2] === "mo"
        ? { kind: "console-layout-lot", auction: auction.data, lot: lot.data }
        : {
            kind: "console-layout-lot-move",
            auction: auction.data,
            lot: lot.data,
            direction: parts[2] === "mu" ? "up" : "down",
          };
    }
    case "mv": {
      const lot = TokenSchema.safeParse(parts[4]);
      const place = SectionSchema.safeParse(parts[5]);
      return parts.length === 6 && lot.success && place.success
        ? {
            kind: "console-layout-lot-place",
            auction: auction.data,
            lot: lot.data,
            place: place.data,
          }
        : { kind: "malformed" };
    }
    case "mq":
      return parts.length === 4
        ? { kind: "console-section-ask", auction: auction.data }
        : { kind: "malformed" };
    case "mr":
    case "mh":
    case "mj":
    case "mx":
    case "my": {
      const section = SectionSchema.safeParse(parts[4]);
      if (parts.length !== 5 || !section.success || section.data === 0) {
        return { kind: "malformed" };
      }
      switch (parts[2]) {
        case "mr":
          return {
            kind: "console-section-ask",
            auction: auction.data,
            section: section.data,
          };
        case "mh":
        case "mj":
          return {
            kind: "console-section-move",
            auction: auction.data,
            section: section.data,
            direction: parts[2] === "mh" ? "up" : "down",
          };
        case "mx":
          return {
            kind: "console-section-delete",
            auction: auction.data,
            section: section.data,
          };
        default:
          return {
            kind: "console-section-delete-confirm",
            auction: auction.data,
            section: section.data,
          };
      }
    }
    case "hm": {
      const draft = decodeLaunchDraft(parts[4] ?? "");
      return parts.length === 5 && draft !== undefined
        ? { kind: "console-window-launch-go", auction: auction.data, draft }
        : { kind: "malformed" };
    }
    case "ht": {
      const draft = decodeLaunchDraft(parts[4] ?? "");
      const lot = LaunchLotSchema.safeParse(parts[5]);
      return parts.length === 6 && draft !== undefined && lot.success
        ? {
            kind: "console-window-launch-lot",
            auction: auction.data,
            draft,
            lot: lot.data,
          }
        : { kind: "malformed" };
    }
    case "hp": {
      const draft = decodeLaunchDraft(parts[4] ?? "");
      // Страница без номера — первая: как у других экранов пульта.
      const page = PageSchema.safeParse(parts[5] ?? "0");
      return (parts.length === 5 || parts.length === 6) &&
        draft !== undefined &&
        page.success
        ? {
            kind: "console-window-launch-page",
            auction: auction.data,
            draft,
            page: page.data,
          }
        : { kind: "malformed" };
    }
    case "rs":
    case "es":
      return parts.length === 4
        ? {
            kind: "console-view",
            auction: auction.data,
            page: 0,
            sort: defaultConsoleSort,
            section: parts[2] === "rs" ? "raffle" : "more",
          }
        : { kind: "malformed" };
    case "fl": {
      if (parts.length > 6) return { kind: "malformed" };
      const page = PageSchema.safeParse(parts[4] ?? "0");
      const sort =
        parts.length === 6 ? parseConsoleSort(parts[5]) : defaultConsoleSort;
      return page.success && sort !== undefined
        ? {
            kind: "console-view",
            auction: auction.data,
            page: page.data,
            sort,
            section: "final",
          }
        : { kind: "malformed" };
    }
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
    case "r":
      return parts.length === 4
        ? { kind: "console-raffle", auction: auction.data }
        : { kind: "malformed" };
    case "rx":
      return parts.length === 4
        ? { kind: "console-raffle-remove", auction: auction.data }
        : { kind: "malformed" };
    // Приз розыгрыша (PER-649): вопрос о призе `rp` и его снятие `rz`.
    case "rp":
      return parts.length === 4
        ? { kind: "console-raffle-prize", auction: auction.data }
        : { kind: "malformed" };
    case "rz":
      return parts.length === 4
        ? { kind: "console-raffle-prize-remove", auction: auction.data }
        : { kind: "malformed" };
    // Срок оплаты счёта (PER-722): вопрос о числе дней `pt`.
    case "pt":
      return parts.length === 4
        ? { kind: "console-payment-term", auction: auction.data }
        : { kind: "malformed" };
    // Ориентировочное время финала (PER-663): вопрос о моменте `ft` и его
    // снятие `fx`.
    case "ft":
      return parts.length === 4
        ? { kind: "console-final-time", auction: auction.data }
        : { kind: "malformed" };
    case "fx":
      return parts.length === 4
        ? { kind: "console-final-time-remove", auction: auction.data }
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
    case "p": {
      const published = TargetStateSchema.safeParse(parts[4]);
      return parts.length === 5 && published.success
        ? {
            kind: "console-visibility",
            auction: auction.data,
            published: published.data === "1",
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
    case "x":
      return parts.length === 4
        ? { kind: "console-discard", auction: auction.data }
        : { kind: "malformed" };
    case "z": {
      const op = TokenSchema.safeParse(parts[4]);
      return parts.length === 5 && op.success
        ? {
            kind: "console-discard-confirm",
            auction: auction.data,
            op: op.data,
          }
        : { kind: "malformed" };
    }
    case "u":
      return parts.length === 4
        ? { kind: "console-cancel", auction: auction.data }
        : { kind: "malformed" };
    case "uy": {
      const op = TokenSchema.safeParse(parts[4]);
      return parts.length === 5 && op.success
        ? {
            kind: "console-cancel-confirm",
            auction: auction.data,
            op: op.data,
          }
        : { kind: "malformed" };
    }
    case "l":
      return parts.length === 4
        ? { kind: "console-lineup", auction: auction.data, page: 0 }
        : { kind: "malformed" };
    case "lo":
    case "ly": {
      const print = WindowPrintSchema.safeParse(parts[4]);
      const order = LineupOrderSchema.safeParse(parts[5]);
      if (!print.success || !order.success) return { kind: "malformed" };
      const pick = { print: print.data, order: order.data };
      if (parts[2] === "ly") {
        return parts.length === 6 && pick.order.length > 0
          ? { kind: "console-lineup-confirm", auction: auction.data, pick }
          : { kind: "malformed" };
      }
      const page = PageSchema.safeParse(parts[6] ?? "0");
      return (parts.length === 6 || parts.length === 7) && page.success
        ? {
            kind: "console-lineup",
            auction: auction.data,
            pick,
            page: page.data,
          }
        : { kind: "malformed" };
    }
    case "g":
      return parts.length === 4
        ? { kind: "console-start-final", auction: auction.data }
        : { kind: "malformed" };
    case "n":
      return parts.length === 4
        ? { kind: "console-next-lot", auction: auction.data }
        : { kind: "malformed" };
    case "go":
      return parts.length === 4
        ? { kind: "console-open-ask", auction: auction.data }
        : { kind: "malformed" };
    case "a":
    case "c": {
      const position = PositionSchema.safeParse(parts[4]);
      return parts.length === 5 && position.success
        ? {
            kind: parts[2] === "a" ? "console-ask" : "console-close",
            auction: auction.data,
            position: position.data,
          }
        : { kind: "malformed" };
    }
    case "k": {
      const position = PositionSchema.safeParse(parts[4]);
      const op = TokenSchema.safeParse(parts[5]);
      const quote = QuoteSchema.safeParse(parts[6]);
      return parts.length === 7 &&
        position.success &&
        op.success &&
        quote.success
        ? {
            kind: "console-close-confirm",
            auction: auction.data,
            position: position.data,
            op: op.data,
            quote: quote.data,
          }
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
  if (parts.length === 3 && parts[2] === "an") return { kind: "administrator" };
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
      case "st":
        return { kind: "lot-text", lot: token.data, field: "title", set: true };
      case "sd":
        return {
          kind: "lot-text",
          lot: token.data,
          field: "description",
          set: true,
        };
      case "lp":
        return { kind: "lot-price", lot: token.data };
      case "cp":
        return { kind: "lot-price", lot: token.data, chain: true };
      case "sp":
        return { kind: "lot-price", lot: token.data, set: true };
      case "li":
        return { kind: "lot-image", lot: token.data };
      case "ci":
        return { kind: "lot-image", lot: token.data, chain: true };
      case "si":
        return { kind: "lot-image", lot: token.data, set: true };
      case "lc":
        return { kind: "lot-copies", lot: token.data };
      case "hh":
        return { kind: "console-period", auction: token.data };
      case "aw":
        return { kind: "console-week", auction: token.data };
      case "ar":
        return { kind: "console-raffle", auction: token.data };
      case "ap":
        return { kind: "console-raffle-prize", auction: token.data };
      case "pt":
        return { kind: "console-payment-term", auction: token.data };
      case "ft":
        return { kind: "console-final-time", auction: token.data };
      case "ai":
        return { kind: "console-payment-text", auction: token.data };
      case "rw":
        return { kind: "console-raffle-winner", auction: token.data };
      case "rn":
        return { kind: "console-raffle-prize-change", auction: token.data };
      case "rf":
        return { kind: "console-raffle-prize-photo", auction: token.data };
      case "vp":
        return { kind: "console-promo-video", auction: token.data };
      case "ah":
        return { kind: "console-window", auction: token.data };
      case "fs":
        return { kind: "floor-search", auction: token.data };
      case "al":
        return { kind: "console-launch", auction: token.data };
      case "as":
        return { kind: "console-set", auction: token.data };
      case "aq":
        return { kind: "console-section", auction: token.data };
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
  // Стартовая или шаг лота в периоде (PER-787): лот, номер и отпечаток
  // периода и что спрошено.
  if (parts[2] === "hk") {
    const index = WindowIndexSchema.safeParse(parts[4]);
    const print = WindowPrintSchema.safeParse(parts[5]);
    const field = happyHourFieldOf(parts[6]);
    return parts.length === 7 &&
      index.success &&
      print.success &&
      field !== undefined
      ? {
          kind: "happy-hour-lot",
          lot: token.data,
          period: { index: index.data, print: print.data },
          field,
        }
      : undefined;
  }
  // Своё медиа объявления (PER-776): кнопка, отпечаток текста и лот — семь
  // частей, восьмая — аудитория (PER-779); вопрос до неё значит «всем».
  if (parts[2] === "am") {
    const button = codeOf(buttonCodes, parts[4]);
    const print = WindowPrintSchema.safeParse(parts[5]);
    const lot = refOf(parts[6]);
    const audience = audienceOf(parts[7]);
    return (parts.length === 7 || parts.length === 8) &&
      button !== undefined &&
      print.success &&
      lot !== "malformed" &&
      audience !== "malformed"
      ? {
          kind: "console-announcement-media",
          auction: token.data,
          button,
          print: print.data,
          audience,
          ...(lot === undefined ? {} : { lot }),
        }
      : undefined;
  }
  // Текст объявления (PER-765): шаблон и, у окна и лота, номер — шагу нужно
  // пять или шесть частей.
  if (parts[2] === "ao") {
    const template = codeOf(templateCodes, parts[4]);
    const ref = refOf(parts[5]);
    return (parts.length === 5 || parts.length === 6) &&
      template !== undefined &&
      ref !== "malformed"
      ? {
          kind: "console-announcement",
          auction: token.data,
          template,
          ...(ref === undefined ? {} : { ref }),
        }
      : undefined;
  }
  if (parts.length !== 5) return undefined;
  if (parts[2] === "ln") {
    const key = LotKeySchema.safeParse(parts[4]);
    return key.success
      ? { kind: "lot-new", auction: token.data, key: key.data }
      : undefined;
  }
  const stepCode = /^([lcs])([sy])$/.exec(parts[2] ?? "");
  if (stepCode !== null) {
    const price = RublesSchema.safeParse(parts[4]);
    const lead = stepCode[1];
    return price.success
      ? {
          kind: "lot-step",
          lot: token.data,
          price: price.data,
          mode: stepCode[2] === "s" ? "single" : "tiered",
          ...(lead === "c" ? { chain: true as const } : {}),
          ...(lead === "s" ? { set: true as const } : {}),
        }
      : undefined;
  }
  if (parts[2] === "ae") {
    const section = SectionSchema.safeParse(parts[4]);
    return section.success && section.data > 0
      ? { kind: "console-section", auction: token.data, section: section.data }
      : undefined;
  }
  if (parts[2] === "fa") {
    const position = PositionSchema.safeParse(parts[4]);
    return position.success
      ? { kind: "final-ask", auction: token.data, position: position.data }
      : undefined;
  }
  if (parts[2] === "ms") {
    const version = VersionSchema.safeParse(parts[4]);
    return version.success
      ? { kind: "material-source", token: token.data, version: version.data }
      : undefined;
  }
  if (
    parts[2] === "fe" ||
    parts[2] === "fc" ||
    parts[2] === "fn" ||
    parts[2] === "fg"
  ) {
    const field = FormFieldSchema.safeParse(parts[4]);
    return field.success
      ? {
          kind: "field",
          mode: parts[2] === "fe" ? "edit" : "create",
          token: token.data,
          field: field.data,
          ...(parts[2] === "fn"
            ? { fresh: "meetups" as const }
            : parts[2] === "fg"
              ? { fresh: "manage" as const }
              : {}),
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

// Администраторы (PER-521): `l` — список, `n` — вопрос о нике, `ay` — «Да»
// назначения с ником, `an` — его «Нет», `dq` и `dy` — подтверждение снятия и
// его «Да» с токеном человека.
function parseAdministrators(parts: readonly string[]): CallbackAction {
  const malformed = { kind: "malformed" } as const;
  const [, , verb, first, ...rest] = parts;
  if (rest.length > 0) return malformed;
  switch (verb) {
    case "l":
      return first === undefined ? { kind: "administrators" } : malformed;
    case "n":
      return first === undefined
        ? { kind: "ask-appoint-administrator" }
        : malformed;
    case "an":
      return first === undefined
        ? { kind: "decline-appoint-administrator" }
        : malformed;
    case "ay":
      return first !== undefined && removableUsernamePattern.test(first)
        ? { kind: "confirm-appoint-administrator", username: first }
        : malformed;
    case "dq":
    case "dy": {
      const token = TokenSchema.safeParse(first);
      if (!token.success) return malformed;
      return verb === "dq"
        ? { kind: "ask-dismiss-administrator", token: token.data }
        : { kind: "dismiss-administrator", token: token.data };
    }
    default:
      return malformed;
  }
}

// Состав (PER-547): `l` — список с местом, `v` — карточка человека, `mg` и
// `mv` — выдать и снять модерацию, `ag` и `av` — выдать и снять ведение
// аукциона (PER-654), `bq` и `by` — вопрос о закрытии доступа и
// его «Да», `dq` и `dy` — вопрос о понижении до гостя и его «Да» (PER-642);
// у карточки и её действий — токен человека и место в списке. `u` —
// ники, `rm` — убрать ник. Отказанные: `r` — список, `rq` и `ry` — вопрос о
// пересмотре и его «Да»; токен у них — заявки, а не человека. Карточка заявки:
// `q` — первая или следующая за курсором, `qc` — та же, `qa` — допустить, `qd`
// и `qy` — вопрос об отказе и его «Да». Кнопки прежних подэкранов ведут на
// новые места: `p` — очередь в «Заявки», `a` — участники, `m` — модераторы,
// `mc` — участники, у которых модерацию выдают с карточки; `ad` — допуск из
// очереди состава — устарел.
function parseCommunity(parts: readonly string[]): CallbackAction {
  const malformed = { kind: "malformed" } as const;
  if (parts.length > 5) return malformed;
  const [, , verb, first, second] = parts;
  switch (verb) {
    case "q":
    case "qc":
    case "qa":
    case "qd":
    case "qy":
    case "r":
    case "rq":
    case "ry":
      return parseApplicationQueue(parts, "community");
    case "l": {
      if (second !== undefined) return malformed;
      const place = parseCommunityPlace(first);
      return place === undefined ? malformed : { kind: "community", place };
    }
    case "v":
    case "mg":
    case "mv":
    case "ag":
    case "av":
    case "dq":
    case "dy":
    case "bq":
    case "by": {
      const token = TokenSchema.safeParse(first);
      if (!token.success) return malformed;
      // Прежние `mg:<токен>:<страница кандидатов>` и `mv:<токен>` несли не
      // место, а список, которого больше нет.
      const place =
        verb === "mg" && second !== undefined && /^\d{1,4}$/.test(second)
          ? firstMembersPage
          : verb === "mv" && second === undefined
            ? { filter: "moderators" as const, page: 0 }
            : parseCommunityPlace(second);
      if (place === undefined) return malformed;
      if (verb === "mg" || verb === "mv" || verb === "ag" || verb === "av") {
        return {
          kind:
            verb === "mg" || verb === "ag" ? "grant-record" : "revoke-record",
          right:
            verb === "mg" || verb === "mv" ? "admit-bidders" : "run-auctions",
          token: token.data,
          place,
        };
      }
      const kinds = {
        v: "community-member",
        bq: "ask-block-member",
        by: "block-member",
        dq: "ask-demote-member",
        dy: "demote-member",
      } as const;
      return { kind: kinds[verb], token: token.data, place };
    }
    case "p":
      if (second !== undefined) return malformed;
      if (first !== undefined && !TokenSchema.safeParse(first).success) {
        return malformed;
      }
      return { kind: "application-card", queue: "community" };
    case "a":
    case "mc": {
      if (second !== undefined) return malformed;
      const page = PageSchema.safeParse(first ?? "0");
      if (!page.success) return malformed;
      return {
        kind: "community",
        place: { filter: "members", page: verb === "a" ? page.data : 0 },
      };
    }
    case "m":
      return first === undefined
        ? { kind: "community", place: { filter: "moderators", page: 0 } }
        : malformed;
    case "ad":
      return TokenSchema.safeParse(first).success &&
        (second === undefined || TokenSchema.safeParse(second).success)
        ? { kind: "outdated" }
        : malformed;
    case "u": {
      if (second !== undefined) return malformed;
      const page = PageSchema.safeParse(first ?? "0");
      return page.success
        ? { kind: "community-usernames", page: page.data }
        : malformed;
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

// Очередь заявок и её отказанные — одни глаголы у двух доменов: `cm` читает
// очередь сообщества, `aq` — очередь аукциона (ADR-064, пункт 12). Очередь
// едет доменом, а не полем: курсор одной очереди не ставит другую.
function parseApplicationQueue(
  parts: readonly string[],
  queue: ApplicationQueue,
): CallbackAction {
  const malformed = { kind: "malformed" } as const;
  if (parts.length > 5) return malformed;
  const [, , verb, first, second] = parts;
  switch (verb) {
    case "q":
    case "qc": {
      if (verb === "q" && first === undefined) {
        return { kind: "application-card", queue };
      }
      const cursor = parseCardCursor(first, second);
      if (cursor === undefined) return malformed;
      return {
        kind: "application-card",
        queue,
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
        queue,
        cursor,
      };
    }
    case "r": {
      if (second !== undefined) return malformed;
      const page = PageSchema.safeParse(first ?? "0");
      return page.success
        ? { kind: "refused-applications", queue, page: page.data }
        : malformed;
    }
    case "rq":
    case "ry": {
      const token = TokenSchema.safeParse(first);
      const page = PageSchema.safeParse(second);
      if (!token.success || !page.success) return malformed;
      return {
        kind: verb === "rq" ? "ask-reconsider" : "reconsider",
        queue,
        token: token.data,
        page: page.data,
      };
    }
    default:
      return malformed;
  }
}

/** Домен кнопок очереди: `v1:cm` — сообщество, `v1:aq` — аукцион. */
export function queueDomain(queue: ApplicationQueue): "v1:cm" | "v1:aq" {
  return queue === "community" ? "v1:cm" : "v1:aq";
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

const ReleasePartSchema = z.string().regex(/^[1-9]\d{0,2}$/);

function parseReleaseNotes(parts: readonly string[]): CallbackAction {
  if (parts.length === 2) return { kind: "release-notes" };
  if (parts.length !== 3 && parts.length !== 4) return { kind: "malformed" };
  const token = TokenSchema.safeParse(parts[2]);
  if (!token.success) return { kind: "malformed" };
  if (parts.length === 3) return { kind: "release-notes", token: token.data };
  const part = ReleasePartSchema.safeParse(parts[3]);
  return part.success
    ? { kind: "release-notes", token: token.data, part: Number(part.data) }
    : { kind: "malformed" };
}

// Хвост `:n` у настроек аукциона — экран открыт из вести (№73): разбор тот
// же, что без хвоста, и признак едет дальше.
const detachedTail = "n";
const detachedSettings: ReadonlySet<string | undefined> = new Set([
  "outbid",
  "final",
  "live",
  "news",
]);

function parseNotify(parts: readonly string[]): CallbackAction {
  if (
    parts.length > 3 &&
    parts.at(-1) === detachedTail &&
    detachedSettings.has(parts[2])
  ) {
    const inner = parseNotify(parts.slice(0, -1));
    return inner.kind === "notify-outbid" ||
      inner.kind === "notify-set-outbid" ||
      inner.kind === "notify-set-final" ||
      inner.kind === "notify-set-live" ||
      inner.kind === "notify-set-news"
      ? { ...inner, detached: true }
      : { kind: "malformed" };
  }
  if (parts.length === 3 && parts[2] === "outbid") {
    return { kind: "notify-outbid" };
  }
  if (parts.length === 4 && parts[2] === "outbid") {
    const frequency = OutbidFrequencySchema.safeParse(parts[3]);
    return frequency.success
      ? { kind: "notify-set-outbid", frequency: frequency.data }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "final") {
    const state = TargetStateSchema.safeParse(parts[3]);
    return state.success
      ? { kind: "notify-set-final", enabled: state.data === "1" }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "live") {
    const state = TargetStateSchema.safeParse(parts[3]);
    return state.success
      ? { kind: "notify-set-live", enabled: state.data === "1" }
      : { kind: "malformed" };
  }
  if (parts.length === 4 && parts[2] === "news") {
    const state = TargetStateSchema.safeParse(parts[3]);
    return state.success
      ? { kind: "notify-set-news", enabled: state.data === "1" }
      : { kind: "malformed" };
  }
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
