import type { AccessRight, LotView } from "../../../auction-ui/index.js";
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

// Человек, каким его разрешил Identity. Допуск в хаб и пункты «Управления»
// решают `rights`; роли едут транзитом в Meetups и Auction, и по роли
// администратора бот показывает только пункты, которые Meetups решает по ней.
export type Person = {
  identityId: string;
  globalRoles: readonly string[];
  rights: readonly AccessRight[];
};
// Как карточка называет автора (PER-404): самому автору — «вы», остальным —
// ник, который Identity отдаёт только для действующего администратора.
// Отсутствие поля в результате — строки автора нет: ника нет, Identity
// отказал или не ответил.
export type MeetupAuthor =
  | { kind: "self" }
  | { kind: "organizer"; telegramUsername: string };
// Аукцион сходки на карточке. `none` — ответ Auction «аукциона нет», а не
// отказ: только тогда администратор видит «Включить аукцион».
export type MeetupAuctionView =
  | { kind: "none" }
  | { kind: "open"; auctionId: string };
// `source` — ссылка канала прихода `s_<код>` (ADR-060, пункт 17). Код —
// недоверенный хвост без префикса: Identity сам решает, известен ли канал, и
// до него код доносит операция входа `RequestRole`.
export type DeepLink =
  | { kind: "meetup"; payload: string }
  | { kind: "source"; code: string }
  | { kind: "unclassified"; payload: string };
export type FormField = "title" | "schedule" | "venue" | "description";

// Форма лота администратора (PER-319). Текст лота — карточка каталога, и она
// правится в любом состоянии лота. Цена и шаг — условия торгов: Auction
// принимает их только парой и только до старта торгов.
export type LotTextField = "title" | "description";

/**
 * Идентификатор лота, которого ещё нет. Его рождает край до вопроса о названии
 * и возит в кнопке вопроса ключом создания — короче самого идентификатора.
 * Бренд не даёт подставить сюда идентификатор существующего лота: тот в ключ не
 * сворачивается, и кнопка назвала бы другой лот.
 */
export type NewLotId = string & { readonly __newLot: true };

// Что спросил вопрос формы лота. Этого хватает, чтобы принять ответ: шаг
// переживает рестарт в кнопке вопроса. У нового лота идентификатор рождён до
// вопроса, поэтому повторный ответ создаёт тот же лот, а не второй. Вопрос о
// шаге несёт цену из предыдущего ответа, в целых рублях. Ответ на вопрос о
// фото — фотография, а не текст (PER-452).
export type LotQuestion =
  | { kind: "new"; auctionId: string; lotId: NewLotId }
  | { kind: "text"; field: LotTextField; lotId: string }
  | { kind: "price"; lotId: string }
  | { kind: "step"; lotId: string; priceRubles: number }
  | { kind: "image"; lotId: string };

// Почему вопрос формы лота задан заново.
export type LotAskError =
  | "empty-title"
  | "empty-description"
  | "amount-format"
  | "amount-range"
  | "step-refused"
  // Отказы Auction на фото: больше его предела либо не изображение.
  | "image-too-large"
  | "unsupported-image"
  // Ответ на вопрос о фото — не фотография: текст, файл, стикер.
  | "photo-needed"
  // Альбом: лоту нужна одна фотография.
  | "photo-album"
  // Telegram не отдал файл фотографии: её можно прислать ещё раз.
  | "photo-unavailable";

// `unset` — лот без условий торгов. `closed` — торги по лоту начались или
// закончились: условия заморожены. Шага у `set` нет, когда он не один на все
// цены: сетку форма не показывает и не задаёт.
export type LotTermsView =
  | { kind: "unset" }
  | { kind: "set"; startingPrice: LotAmount; step?: LotAmount }
  | { kind: "closed" };

// Сумма в минимальных единицах валюты, как в `auction.v1.Money`.
export type LotAmount = { minorUnits: number; currency: string };

// Лот на экране правки. Названия нет, когда у лота нет карточки каталога.
export type LotFormView = {
  lotId: string;
  auctionId: string;
  title?: string;
  description: string;
  hasImage: boolean;
  terms: LotTermsView;
};

export type LotRefusal =
  // Auction или Meetups не подтвердили администратора сходки.
  | "not-administrator"
  // Торги начались: в аукцион нельзя добавить лот.
  | "lots-frozen"
  // Торги начались: цену и шаг лота изменить нельзя.
  | "terms-closed"
  | "lot-not-found"
  | "auction-not-found"
  // Лот сняли с аукциона, пока форма была открыта.
  | "lot-not-in-auction";
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
      // Включение аукциона у сходки (PER-307). `opId` рождается на нажатие:
      // аукцион сходки один при любом числе нажатий, его ключ выводит Auction.
      identity: Person;
      intent: "enable-auction";
      meetupId: string;
      opId: string;
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
      /**
       * Версия, которую человек видел на подтверждении. Нет — кнопка прошлого
       * релиза: команда идёт с версией снимка в момент нажатия.
       */
      expectedVersion?: number;
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
  | BroadcastRequest
  | LotFormRequest
  | AuctionConsoleRequest;

type LotFormCall = {
  identity: Person;
  requestId?: string;
  useCase?: string;
  deadlineAt?: number;
};

// Значения приходят строкой, как их написал человек: разбор принадлежит
// юзкейсу, чтобы отказ разбора и отказ Auction жили в одном месте.
export type LotFormRequest =
  // `lotId` и `opId` рождает край. У создания ключ команды один на вопрос о
  // названии, как и идентификатор лота; у условий торгов — свой на каждый ответ.
  | (LotFormCall & {
      intent: "create-lot";
      auctionId: string;
      lotId: NewLotId;
      title: string;
      opId: string;
    })
  | (LotFormCall & { intent: "view-lot-form"; lotId: string })
  | (LotFormCall & {
      intent: "set-lot-text";
      lotId: string;
      field: LotTextField;
      value: string;
    })
  // Цена проверяется до вопроса о шаге: иначе отказ пришёл бы после второго
  // ответа. В Auction она уходит вместе с шагом.
  | (LotFormCall & { intent: "check-lot-price"; lotId: string; value: string })
  | (LotFormCall & {
      intent: "set-lot-terms";
      lotId: string;
      priceRubles: number;
      value: string;
      opId: string;
    })
  // Фото уже скачано у Telegram краем: юзкейс получает только байты.
  | (LotFormCall & {
      intent: "set-lot-image";
      lotId: string;
      image: Uint8Array;
    });

// Пульт аукциона администратора (PER-320). Пульт — экран хаба, а не тело
// пакета, как форма лота: своего состояния у него нет, и всё, что нужно
// следующему шагу, едет в кнопке или в вопросе.

// Где аукцион, словами Auction (`AuctionSnapshot.status`).
export type ConsoleAuctionStatus =
  | "draft"
  | "scheduled"
  | "prebidding"
  | "settling"
  | "break"
  | "lineup-frozen"
  | "final"
  | "finished";

// Сроки онлайн-недели из конфигурации аукциона: мгновения RFC 3339 в UTC.
// Мгновения нет, когда его нет в конфигурации: формат без онлайн-фазы или
// фаза, которую закрывает человек, а не время.
export type AuctionWeek = {
  opensAt?: string;
  closesAt?: string;
  final: boolean;
};

// Лот на пульте: снимок, число ставок, отметка «в финал» и просрочка — торги
// идут дольше дедлайна, а лот не закрыт (решает Auction).
export type ConsoleLotSnapshot = {
  lot: LotView;
  bidCount: number;
  markedForFinal: boolean;
  overdue: boolean;
};

export type ConsoleLot = ConsoleLotSnapshot & {
  uniqueParticipantCount: number;
  priceGrowth?: LotAmount;
};

export type ConsoleSortMetric = "bids" | "participants" | "growth";
export type ConsoleSortDirection = "ascending" | "descending";
export type ConsoleSort = {
  metric: ConsoleSortMetric;
  direction: ConsoleSortDirection;
};

// `week` нет у черновика: сроков у него ещё не задавали.
export type AuctionConsoleSnapshot = {
  auctionId: string;
  status: ConsoleAuctionStatus;
  week?: AuctionWeek;
  lots: readonly ConsoleLotSnapshot[];
};

export type AuctionConsoleView = Omit<AuctionConsoleSnapshot, "lots"> & {
  lots: readonly ConsoleLot[];
};

// Строка исхода команды пульта: принятая команда и именованный отказ Auction,
// который человеку показывают на том же экране, а не кадром отказа.
export type ConsoleNote =
  | "week-saved"
  | "week-opened"
  | "week-already-open"
  | "week-not-scheduled"
  | "week-frozen"
  | "week-needed"
  | "marked"
  | "unmarked"
  | "already-marked"
  | "not-marked"
  | "deadline-passed"
  | "not-in-prebidding"
  | "lot-not-open"
  | "not-in-online-phase"
  | "lot-not-in-auction"
  | "selection-not-applicable"
  // Открывать неделю нельзя: конец прошёл либо лотов с ценой и шагом нет.
  | "week-ended"
  | "no-lots-to-open";

// Почему вопрос о сроках недели задан заново.
export type WeekAskError =
  | "week-format"
  | "week-moment"
  | "week-order"
  | "week-ended";

type AuctionConsoleCall = LotFormCall & { auctionId: string };

// `opId` рождает край: у открытия недели — в кнопке подтверждения, у
// остальных команд — на каждое нажатие и каждый ответ.
export type AuctionConsoleRequest =
  | (AuctionConsoleCall & { intent: "view-auction-console" })
  // Вопрос о сроках, если их ещё можно менять.
  | (AuctionConsoleCall & { intent: "ask-auction-week" })
  // Подтверждение открытия недели, если открывать можно и есть что.
  | (AuctionConsoleCall & {
      intent: "prepare-auction-week-start";
      opId: string;
    })
  // Сроки приходят строкой, как их написал человек: разбор — дело юзкейса.
  | (AuctionConsoleCall & {
      intent: "schedule-auction-week";
      value: string;
      opId: string;
    })
  // Кнопка несёт целевое состояние финала, а не переворот.
  | (AuctionConsoleCall & {
      intent: "set-auction-final";
      final: boolean;
      opId: string;
    })
  | (AuctionConsoleCall & { intent: "start-auction-week"; opId: string })
  | (AuctionConsoleCall & {
      intent: "mark-auction-finalist";
      lotId: string;
      selected: boolean;
      opId: string;
    });

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
  // `auction` отсутствует, когда Auction не ответил или не настроен: тогда ни
  // входа в аукцион, ни кнопки включения на карточке нет — по тому же правилу,
  // что у подписки.
  | {
      kind: "meetup-card";
      meetup: MeetupSnapshot;
      subscribed?: boolean;
      categories?: readonly CategoryState<MeetupCategory>[];
      author?: MeetupAuthor;
      auction?: MeetupAuctionView;
    }
  // Аукцион включён: карточка перечитана после команды. `alreadyExisted` —
  // аукцион у сходки уже был, и второго не родилось. `card` нет — аукцион
  // включён, а перечитать карточку не вышло: бюджет действия ушёл на команду.
  | {
      kind: "auction-enabled";
      meetupId: string;
      auctionId: string;
      card?: Extract<ExecuteResult, { kind: "meetup-card" }>;
      alreadyExisted: boolean;
    }
  // Auction отказал по праву администратора сходки — отказ окончательный, и
  // бот его не повторяет.
  | { kind: "auction-refused"; reason: "not-administrator" }
  // Экран правки лота (PER-319). `saved` — что только что записано: лот собран
  // из ответа команды, потому что чтение Auction её ещё могло не увидеть.
  | {
      kind: "lot-form";
      lot: LotFormView;
      saved?: "created" | "text" | "terms" | "image";
    }
  // Вопрос формы лота: следующий шаг либо тот же заново, с причиной отказа.
  // Лота нет у нового лота и там, где его не читали.
  | {
      kind: "lot-ask";
      question: LotQuestion;
      lot?: LotFormView;
      error?: LotAskError;
      // Предел Auction в байтах, когда фото его превысило.
      maxImageBytes?: number;
    }
  // Отказ Auction, который человеку показывают, а не повторяют.
  | {
      kind: "lot-refused";
      reason: LotRefusal;
      lotId?: string;
      auctionId?: string;
    }
  // Пульт аукциона (PER-320). `note` — исход команды первой строкой. После
  // команды пульт собран из чтения Auction и принятой команды: чтения
  // отстают от команд.
  | {
      kind: "auction-console";
      console: AuctionConsoleView;
      note?: ConsoleNote;
      // Переключатель финала принят: исход — всплывающий текст, а не строка.
      toggled?: true;
    }
  // Вопрос о сроках недели: первый либо тот же заново, с причиной.
  | {
      kind: "auction-week-ask";
      auctionId: string;
      week?: AuctionWeek;
      error?: WeekAskError;
    }
  // Подтверждение открытия недели: сколько лотов откроется и сколько
  // останется без торгов — без цены и шага. `opId` уедет в «Да».
  | {
      kind: "auction-week-confirm";
      console: AuctionConsoleView;
      opId: string;
      opening: number;
      idle: number;
    }
  // Отказ пульту целиком: не администратор сходки либо аукциона нет.
  | {
      kind: "auction-console-refused";
      reason: "not-administrator" | "auction-not-found";
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
  // Результаты формы, которые бот показывает карточкой сходки, — `draft` у уже
  // видимой сходки, `published`, `publication-scheduled`,
  // `publication-unavailable`, `meetup-updated` и `meetup-state-changed` —
  // несут и `auction` по тому же правилу, что `meetup-card`: иначе карточка
  // сразу после «Опубликовать» была бы без ряда аукциона, а та же карточка из
  // списка — с ним. Дописывает его диспетчер; отказ Auction карточку не роняет.
  //
  // Черновик после принятого ответа формы создания: дальше человек сам
  // выбирает, какое поле заполнить, и публикует с того же экрана. Если сходку
  // успели опубликовать, пока вопрос висел, бот показывает её карточкой, и
  // диспетчер дописывает `auction` только в этом случае.
  | { kind: "draft"; meetup: MeetupSnapshot; auction?: MeetupAuctionView }
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
      auction?: MeetupAuctionView;
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
      auction?: MeetupAuctionView;
    }
  // Назначить публикацию нельзя в текущем состоянии сходки: она уже
  // опубликована, отменена или у неё нет названия (FAILED_PRECONDITION).
  // Снимок — перечитанный, по нему кадр и выбирает причину.
  | {
      kind: "publication-unavailable";
      meetup: MeetupSnapshot;
      author?: MeetupAuthor;
      auction?: MeetupAuctionView;
    }
  | {
      kind: "meetup-updated";
      meetup: MeetupSnapshot;
      archived?: true;
      author?: MeetupAuthor;
      auction?: MeetupAuctionView;
    }
  | {
      kind: "meetup-state-changed";
      action: MeetupStateAction;
      meetup: MeetupSnapshot;
      author?: MeetupAuthor;
      auction?: MeetupAuctionView;
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
