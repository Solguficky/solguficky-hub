import type {
  AccessRight,
  AuctionSummaryView,
  LotLayoutView,
  LotView,
  RaffleTicketView,
  RaffleView,
} from "../../../auction-ui/index.js";
import type {
  AuctionNotificationChange,
  AuctionNotificationSettings,
} from "../../../core/notifications/outbid.js";
import type { CommunityDay } from "../community-time.js";
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
import type {
  AuctionAnnouncementRequest,
  AuctionAnnouncementResult,
} from "./auction-announcements.js";

// Человек, каким его разрешил Identity. Допуск в хаб и пункты «Управления»
// решают `rights` (RFC-016); те же права уходят смотрящим в Meetups и Auction,
// и сервис решает по ним сам.
export type Person = {
  identityId: string;
  rights: readonly AccessRight[];
};
// Как карточка называет автора (PER-404): самому автору — «вы», остальным —
// ник, который Identity отдаёт только для действующего администратора.
// Отсутствие поля в результате — строки автора нет: ника нет, Identity
// отказал или не ответил.
export type MeetupAuthor =
  | { kind: "self" }
  | { kind: "organizer"; telegramUsername: string };
// Аукцион сходки в её меню «Расширения» (PER-605) и строке карточки
// (PER-594). `none` — ответ Auction «аукциона нет», а не отказ: только тогда
// администратор видит «Включить». `unavailable` — Auction не ответил: меню
// говорит об этом, а не прячет аукцион, а карточка остаётся без строки.
export type MeetupAuctionView =
  | { kind: "none" }
  | { kind: "open"; auctionId: string; auction?: AuctionSummaryView }
  | { kind: "unavailable" };
// Что отмена сходки сделает с её аукционом: торги идут — аукцион отменится, и
// `sold` проданных лотов останутся проданными; `unknown` — Auction не ответил,
// и подтверждение называет последствие условно (PER-606). Нет поля — торгов
// нет или аукциона нет, и подтверждение прежнее.
export type AuctionCancelConsequence =
  | { kind: "trading"; sold: number }
  | { kind: "unknown" };
// `source` — ссылка канала прихода `s_<код>` (ADR-060, пункт 17). Код —
// недоверенный хвост без префикса: Identity сам решает, известен ли канал, и
// до него код доносит операция входа `RequestAccess`.
export type DeepLink =
  | { kind: "meetup"; payload: string }
  | { kind: "source"; code: string }
  | { kind: "unclassified"; payload: string };
export type FormField = "title" | "schedule" | "venue" | "description";

// Форма лота администратора (PER-319). Текст лота — карточка каталога: у
// проданного и закрытого без продажи она не меняется, в остальных состояниях
// меняется. Цена и шаг — условия торгов: Auction принимает их только парой и
// только до старта торгов.
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
//
// `chain` — вопрос задан цепочкой нового лота (PER-618): после названия форма
// сама спрашивает цену, шаг и фото по порядку. Признак едет в кнопке вопроса
// и переживает рестарт; юзкейс его не читает — следующий шаг выбирает край.
//
// `set` — правка всего сета лота (PER-716): «Все лоты сета» выбраны до
// вопроса, и признак едет в кнопке, как `chain`. С цепочкой он не бывает: у
// нового лота сета нет.
export type LotQuestion =
  | { kind: "new"; auctionId: string; lotId: NewLotId }
  | { kind: "text"; field: LotTextField; lotId: string; set?: true }
  | { kind: "price"; lotId: string; chain?: true; set?: true }
  // Способ шага выбирается до вопроса о нём (PER-491): один шаг или пороги.
  | {
      kind: "step";
      lotId: string;
      priceRubles: number;
      mode: LotStepMode;
      chain?: true;
      set?: true;
    }
  | { kind: "image"; lotId: string; chain?: true; set?: true }
  // Сколько всего лотов будет вместе с этим (PER-716): копии с той же
  // карточкой, ценой и шагом, собранные в сет.
  | { kind: "copies"; lotId: string };

// Почему вопрос формы лота задан заново.
export type LotAskError =
  | "empty-title"
  | "empty-description"
  | "amount-format"
  | "amount-range"
  // Порог не разобран: не строка «от цены — шаг» либо сумма не число формы.
  | "step-format"
  // Первый порог не с нуля: обычно стартовая цена вместо 0.
  | "step-start"
  // Цены порогов идут не по возрастанию.
  | "step-order"
  // Шаг следующего порога меньше прежнего (PER-709): правило формы, не Auction.
  | "step-decreasing"
  // Auction отклонил политику шага целиком.
  | "step-refused"
  // Отказы Auction на фото: больше его предела либо не изображение.
  | "image-too-large"
  | "unsupported-image"
  // Ответ на вопрос о фото — не фотография: текст, файл, стикер.
  | "photo-needed"
  // Telegram не отдал файл фотографии: её можно прислать ещё раз.
  | "photo-unavailable"
  // Auction не ответил на фото вовремя или недоступен (PER-728): то же фото
  // можно прислать ещё раз, второго фото повтор не заведёт.
  | "photo-not-saved"
  // Число лотов для копий — не целое от 2 до 20 (PER-716).
  | "copies-count";

// Способ задать шаг (PER-491): один на все цены либо по ценовым порогам.
export type LotStepMode = "single" | "tiered";

// Порог шага по цене в форме: нижняя граница и шаг от неё.
export type LotTierView = { lowerBound: LotAmount; step: LotAmount };

// `unset` — лот без условий торгов. `closed` — торги по лоту начались или
// закончились: условия заморожены. Шага у `set` нет, когда он по порогам:
// тогда его несёт `tiers`.
export type LotTermsView =
  | { kind: "unset" }
  | {
      kind: "set";
      startingPrice: LotAmount;
      step?: LotAmount;
      tiers?: readonly LotTierView[];
    }
  // Торги начались. `soldFor` — лот продан: его название, описание и фото
  // больше не меняются (решение владельца 15 октября 2026 года).
  | { kind: "closed"; soldFor?: LotAmount };

// Сумма в минимальных единицах валюты, как в `auction.v1.Money`.
export type LotAmount = { minorUnits: number; currency: string };

// Лот на экране правки. Названия нет, когда у лота нет карточки каталога.
export type LotFormView = {
  lotId: string;
  auctionId: string;
  title?: string;
  description: string;
  // Фото лота в порядке показа, первое — обложка (PER-721).
  photos: readonly LotFormPhoto[];
  terms: LotTermsView;
  // Реестр аукциона лота (PER-716): открыт ли он и сет лота. Его несёт только
  // экран правки, прочитанный вместе с пультом; нет — пульт не прочитан, и
  // экран не предлагает ни копий, ни удаления, ни правки сета.
  registry?: LotRegistryView;
};

// Фото на экране «Фото лота». `print` — отпечаток фото для кнопки «Убрать»:
// идентификатор в 64 байта не помещается. `photoId` нет — Auction до списка
// фото назвал только обложку, и снимается она правкой карточки.
export type LotFormPhoto = { print: string; photoId?: string };

// `open` — онлайн-торги не открыты: лоты добавляются и снимаются. `set` — сет,
// в который лот входит, с числом его лотов; неполный сет тоже.
export type LotRegistryView = {
  open: boolean;
  set?: { name: string; size: number };
};

// Почему правка сета не дошла до лота (PER-716): лот продан или закрыт без
// продажи, торги по лоту начались, у лота предел фото (PER-721), лота нет в
// реестре, Auction не ответил или отказал иначе.
export type LotSetMiss =
  | "sold"
  | "card-closed"
  | "terms-closed"
  | "photo-limit"
  | "not-in-auction"
  | "unavailable"
  | "refused";

// Поле, которое правка сета разносит по лотам.
export type LotSetField = LotTextField | "image" | "price";

export type LotRefusal =
  // Auction или Meetups не подтвердили администратора сходки.
  | "not-administrator"
  // Торги начались: в аукцион нельзя добавить лот.
  | "lots-frozen"
  // Торги начались: цену и шаг лота изменить нельзя.
  | "terms-closed"
  // Лот продан: покупатель купил его под этим названием, описанием и фото.
  | "lot-sold"
  // Лот продан или закрыт без продажи: Auction отказал правке карточки.
  | "card-closed"
  | "lot-not-found"
  | "auction-not-found"
  // Лот сняли с аукциона, пока форма была открыта.
  | "lot-not-in-auction"
  // Сходку отменили: аукцион наследует отмену (ADR-047, дополнение 2026-10-12).
  | "meetup-cancelled"
  // Копии собираются в сет, а лот уже в сете (PER-716).
  | "lot-in-set"
  // Сетов у аукциона столько, сколько держит экран сетов (PER-716).
  | "set-limit"
  // Торги начались: лот из аукциона уже не снять (PER-716).
  | "removal-frozen"
  // У лота уже предел фото (PER-721): новое не добавить, пока не убрать одно.
  | "photo-limit";
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
      // Подтверждение отмены сходки называет последствие для её аукциона
      // (ADR-064, дополнение 2026-10-12): только оно платит за чтение лотов.
      withCancelConsequence?: true;
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      // Меню «Расширения» сходки (PER-605): сходка и её аукцион.
      identity: Person;
      intent: "view-meetup-extensions";
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
      intent: "set-meetup-field";
      field: FormField;
      value: string;
      meetupId: string;
      // Название новой сходки с кнопки «Создать сходку»: сходку рождает этот
      // ответ (прогон 14.10, №14).
      fresh?: true;
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
      // Версия, которую человек видел на подтверждении публикации: правка
      // между экраном и «Да» даёт конфликт, а не публикацию поверх неё.
      expectedVersion?: number;
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
  | ReleaseNotesRequest
  | BroadcastRequest
  | PreviewBroadcastRequest
  | LotFormRequest
  | AuctionConsoleRequest
  | FloorBidsRequest
  | ParticipantRemovalRequest
  | LotSetsRequest
  | LotLayoutRequest
  | AuctionInvoicesRequest
  | RaffleWinnerRequest
  | RafflePrizeChangeRequest
  | RafflePrizePhotoRequest
  | PromoVideoRequest
  | AuctionAnnouncementRequest;

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
  // `registry` — экрану нужен реестр аукциона (PER-716): копии, удаление и
  // правка сета. Остальным нажатиям пульт не читается.
  | (LotFormCall & { intent: "view-lot-form"; lotId: string; registry?: true })
  // Предпросмотр лота глазами участника (PER-512): снимок целиком, его тело
  // строит аукционное дерево.
  | (LotFormCall & { intent: "view-lot-preview"; lotId: string })
  // `set` — правка всего сета лота (PER-716); ключ рождает край, и из него
  // выводятся ключи команд каждого лота.
  | (LotFormCall & {
      intent: "set-lot-text";
      lotId: string;
      field: LotTextField;
      value: string;
      set?: true;
    })
  // Цена проверяется до вопроса о шаге: иначе отказ пришёл бы после второго
  // ответа. В Auction она уходит вместе с шагом.
  | (LotFormCall & { intent: "check-lot-price"; lotId: string; value: string })
  | (LotFormCall & {
      intent: "set-lot-terms";
      lotId: string;
      priceRubles: number;
      // Способ шага выбран до вопроса: один шаг или пороги (PER-491).
      mode: LotStepMode;
      value: string;
      opId: string;
      set?: true;
    })
  // Новая цена с прежним шагом лота (PER-714): «Оставить шаг» на экране выбора
  // способа шага. Шаг юзкейс берёт из чтения лота.
  | (LotFormCall & {
      intent: "keep-lot-step";
      lotId: string;
      priceRubles: number;
      opId: string;
      set?: true;
    })
  // Фото в конец списка (PER-721). Его уже скачал у Telegram край: юзкейс
  // получает только байты. `photoId` край выводит из лота и байтов фото
  // (`lotPhotoIdOf`): повтор того же фото даёт тот же идентификатор.
  | (LotFormCall & {
      intent: "add-lot-photo";
      lotId: string;
      photoId: string;
      image: Uint8Array;
      set?: true;
    })
  // «Повторить для оставшихся» (PER-716): поле лота разносится по его сету
  // заново — значение берётся у самого лота, правка которого уже прошла.
  | (LotFormCall & {
      intent: "retry-lot-set";
      lotId: string;
      field: LotSetField;
      opId: string;
      // У фото — отпечаток версии фото, которое разносили (PER-721): повтор
      // добавляет то же фото, а не последнее из галереи.
      photoPrint?: string;
    })
  // Копии лота (PER-716): ответ — сколько всего лотов будет вместе с ним.
  | (LotFormCall & {
      intent: "copy-lot";
      lotId: string;
      value: string;
      opId: string;
    })
  // «Да, удалить лот» (PER-716): лот уходит из реестра и из своего сета.
  | (LotFormCall & { intent: "remove-lot"; lotId: string; opId: string })
  // Снятие фото лота (PER-715, PER-721): «Да» под подтверждением «Убрать
  // фото?».
  | (LotFormCall & {
      intent: "remove-lot-photo";
      lotId: string;
      // Отпечаток фото, которое подтвердили снять.
      photoPrint: string;
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
  | "finished"
  | "cancelled";

// Сроки онлайн-недели из конфигурации аукциона: мгновения RFC 3339 в UTC.
// Мгновения нет, когда его нет в конфигурации: формат без онлайн-фазы или
// фаза, которую закрывает человек, а не время.
export type AuctionWeek = {
  opensAt?: string;
  closesAt?: string;
  final: boolean;
  // Окна «Счастливых часов» (PER-504) в порядке конфигурации: номер окна —
  // его позиция, ею же Auction называет окно в отказе.
  windows: readonly StepWindow[];
  // Момент закрытия регистрации в розыгрыше (PER-593, ADR-066 п. 5); нет —
  // неделя без розыгрыша.
  raffleClosesAt?: string;
  // Приз розыгрыша одной строкой (PER-649); нет — приз не объявлен. Лежит рядом
  // с моментом: задаётся до открытия недели и после него не меняется.
  rafflePrize?: string;
  // Срок оплаты счёта в секундах от продажи (PER-722). Auction хранит его в
  // каждой конфигурации; нет — снимок его не отдал, и команда его не шлёт.
  paymentTermSeconds?: number;
};

// Окно сниженного шага (ADR-047, дополнение 2026-10-08): полуоткрытый
// интервал `[from, until)` онлайн-недели, шаг в нём и лоты, которые назвал
// организатор. Лоты окна — не обязательно лоты реестра: Auction их против
// реестра не сверяет.
export type StepWindow = {
  from: string;
  until: string;
  step: LotAmount;
  lotIds: readonly string[];
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
  // Имя лидера в аукционе (прогон 14.10, №76). Нет — лидера нет либо имя не
  // прочиталось: строка лота идёт без него.
  leaderName?: string;
};

// Лот в сводке дня (PER-492): агрегаты окна суток, которые отдал Auction, и
// название из карточки пульта. Заголовка нет, когда у лота нет карточки.
// `leaderChanges` и `longestDuel` — тоже окна (PER-511); `bidsBefore` — ставки
// лота до окна, всего минус окно, и `priceGrowth` — рост от стартовой цены за
// всё время: по ним сводка ищет «тёмную лошадку».
export type DaySummaryLot = {
  lotId: string;
  title?: string;
  bidCount: number;
  maxPrice?: LotAmount;
  growth?: LotAmount;
  leaderChanges: number;
  longestDuel: number;
  bidsBefore: number;
  priceGrowth?: LotAmount;
};

export type ConsoleSortMetric = "bids" | "participants" | "growth";
export type ConsoleSortDirection = "ascending" | "descending";
export type ConsoleSort = {
  metric: ConsoleSortMetric;
  direction: ConsoleSortDirection;
};

// Экраны под пультом (PER-802): «Розыгрыш» — момент, приз, фото и итог,
// «Финал» — отбор лотов и время финала, «Ещё» — снятие с публикации,
// удаление и отмена. Без раздела — сам пульт.
export type ConsoleSection = "raffle" | "final" | "more";

// Замороженный состав финала (PER-337): лоты в порядке выхода и лот, который
// ведущий торгует сейчас. Активного лота нет между лотами и до первого.
export type FinalLineup = {
  order: readonly string[];
  activeLotId?: string;
};

// `week` нет у черновика: сроков у него ещё не задавали. `lineup` есть, только
// пока состав заморожен или идёт финал.
export type AuctionConsoleSnapshot = {
  auctionId: string;
  status: ConsoleAuctionStatus;
  // Аукцион скрыт от участников (ADR-047, дополнение 2026-10-20): Auction
  // отдаёт признак только держателю `run_auctions` и снимает его открытием
  // онлайн-торгов.
  hidden: boolean;
  // Сходка аукциона (`AuctionConsole.meetup_id`): только пульт ведёт от
  // аукциона к сходке. Нет — Auction её не назвал.
  meetupId?: string;
  // Ориентировочное время финала (PER-663): анонс трансляции, а не условие
  // торгов. Момент RFC 3339 в UTC; нет — анонс не выставлен.
  finalAt?: string;
  week?: AuctionWeek;
  lineup?: FinalLineup;
  // Запущенные по ходу торгов окна сниженного шага (PER-615) в порядке
  // запуска: их нет в конфигурации, а конфигурация после открытия недели
  // заморожена. Пульт показывает их рядом с объявленными.
  launchedWindows: readonly StepWindow[];
  lots: readonly ConsoleLotSnapshot[];
  // Сеты лотов аукциона (ADR-073, PER-509) в порядке идентификатора — все, и
  // неполные: снимок лота сет меньше чем из двух лотов не показывает, а
  // организатор собирает его постепенно. Сеты читаются с агрегатом и могут
  // назвать лот, которого `lots` ещё не отдаёт.
  lotSets: readonly LotSet[];
  // Порядок и разделы ленты (PER-719), как их выставил администратор. Нет —
  // лоты не упорядочены, и лента идёт в порядке создания.
  layout?: LotLayoutView;
  // Промо-видео аукциона (PER-774): номер поста в чате медиа ботов. Нет —
  // видео нет.
  promoVideo?: number;
  // Сколько участников зарегистрировалось в розыгрыше сейчас (PER-734):
  // отменённая регистрация не считается. Есть, только пока розыгрыш держит
  // регистрации; нет — розыгрыша нет, пул зафиксирован или Auction числа не
  // отдал.
  raffleRegistrations?: number;
  // Прогнозы аукциона числами (PER-734), без людей и ответов. Нет — игры ещё
  // нет или Auction их не отдал.
  predictionTally?: PredictionTally;
};

// Прогнозы всех раундов вместе: участники хотя бы с одним ответом и все их
// ответы. Очищенный прогноз ответов не несёт и не считается.
export type PredictionTally = { participants: number; answers: number };

// Сет лотов: название и лоты в порядке организатора. Неполный — меньше двух
// лотов: участнику он не показывается и собранным не бывает (ADR-073, п. 1).
export type LotSet = { lotSetId: string; name: string; lotIds: string[] };

// Ставка текущего лота финала на пульте ведущего: сумма и имя, которое ставит
// Auction. Имени нет, когда Auction его не назвал.
export type FinalBid = { amount: LotAmount; name?: string };

// Торги текущего лота финала: последние ставки, новые первыми, и имя лидера.
// `lotId` — лот, чьи это ставки: принятая команда может сменить активный лот.
export type FinalTrading = {
  lotId: string;
  bids: readonly FinalBid[];
  leaderName?: string;
};

export type AuctionConsoleView = Omit<AuctionConsoleSnapshot, "lots"> & {
  lots: readonly ConsoleLot[];
  // Есть, только пока в финале торгуется лот.
  trading?: FinalTrading;
  // Розыгрыш после закрытия регистрации (PER-618): статус и итог для строки
  // пульта. Нет — момент не прошёл, розыгрыша нет или чтение отказало, и
  // строка называет момент закрытия.
  raffle?: RaffleView;
  // Сходка аукциона скрыта (PER-801): онлайн-неделя не откроется, пока её не
  // опубликуют, и пульт говорит это до «Открыть онлайн-неделю». Читается у
  // Meetups только до открытия недели; нет — сходка видна, неизвестна или
  // чтение отказало.
  meetupHidden?: true;
  // Сходка аукциона опубликована (PER-802): строка «✓» чек-листа подготовки.
  // Читается тем же чтением, что `meetupHidden`; нет обоих — сходка
  // неизвестна, и строка говорит об этом.
  meetupPublished?: true;
};

// Аукцион, у которого идут торги сообщества (PER-603, PER-618): слот один, и
// открыть неделю другого нельзя. Сроки — из чтения активных аукционов;
// `meetupTitle` — его сходка, если бот её знает.
export type TradingHolder = {
  auctionId: string;
  opensAt?: string;
  closesAt?: string;
  meetupTitle?: string;
};

// Строка исхода команды пульта: принятая команда и именованный отказ Auction,
// который человеку показывают на том же экране, а не кадром отказа.
export type ConsoleNote =
  | "week-saved"
  | "week-opened"
  | "week-already-open"
  | "week-not-scheduled"
  // Торги идут у другого аукциона сообщества: открыть неделю нельзя.
  | "another-auction-active"
  | "week-frozen"
  | "week-needed"
  // Момент розыгрыша (PER-593): задан либо убран.
  | "raffle-saved"
  | "raffle-removed"
  // Приз розыгрыша (PER-649): задан либо убран; без момента розыгрыша приза
  // нет — приз без розыгрыша Auction не принимает.
  | "prize-saved"
  | "prize-removed"
  | "prize-without-raffle"
  // Срок оплаты счёта (PER-722) сохранён.
  | "payment-term-saved"
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
  | "no-lots-to-open"
  // Удалить аукцион можно только до открытия недели.
  | "discard-too-late"
  // Отменить аукцион можно только после открытия недели и до его конца
  // (ADR-047, дополнение 2026-10-12); принятая отмена — свой исход.
  | "cancel-too-early"
  | "cancel-too-late"
  | "already-cancelled"
  | "auction-cancelled"
  // Скрытая сходка закрывает открытие онлайн-недели (ADR-047, дополнение
  // 2026-10-12): исход — пульт по перечитанному снимку с возвратом в него.
  | "meetup-hidden"
  // Видимость (PER-673): опубликован, снят с публикации либо неделя уже
  // открыта и видимость больше не меняется.
  | "published"
  | "unpublished"
  | "visibility-too-late"
  // Ориентировочное время финала (PER-663): выставлено, снято либо уже поздно
  // — финал начался, аукцион завершён или отменён.
  | "final-time-saved"
  | "final-time-removed"
  | "final-already-started"
  | "auction-already-finished"
  | "auction-already-cancelled"
  // Финал ведущего (PER-337): принятые команды и отказы Auction.
  | "final-started"
  | "lineup-not-frozen"
  | "not-in-final"
  | "another-lot-active"
  | "lineup-exhausted"
  | "final-lot-closed"
  | "deadline-not-reached"
  | "final-finished"
  // Состав финала (PER-619): объявлен — этой кнопкой или раньше — либо
  // объявлять нечего и некогда.
  | "lineup-frozen"
  | "lineup-empty"
  | "lineup-too-long"
  | "not-in-break";

// Почему вопрос о сроках недели задан заново. `week-cuts-window` — окно
// «Счастливых часов» не помещается в новые сроки; номер окна едет рядом.
// `week-cuts-raffle` — заданный момент розыгрыша не помещается в новые сроки.
export type WeekAskError =
  | "week-format"
  | "week-moment"
  | "week-order"
  | "week-ended"
  | "week-cuts-window"
  | "week-cuts-raffle";

// Почему вопрос о моменте розыгрыша задан заново (PER-593). Момент лежит
// строго внутри недели (ADR-066, п. 5): бот проверяет это сам по прочитанным
// срокам, а отказ Auction переводит в ту же причину.
export type RaffleAskError =
  | "raffle-format"
  | "raffle-moment"
  | "raffle-ended"
  | "raffle-not-after-opens"
  | "raffle-not-before-closes";

// Почему вопрос о призе розыгрыша задан заново (PER-649). Приз — одна строка
// не длиннее 200 знаков: пустой приз говорит, что приза не будет, а предел
// держит и бот, и Auction.
export type RafflePrizeAskError = "prize-blank" | "prize-too-long";

// Почему вопрос о сроке оплаты счёта задан заново (PER-722). Срок — целое
// число дней от 1 до 30: тот же предел держит Auction.
export type PaymentTermAskError = "payment-term-format" | "payment-term-range";

// Почему вопрос об ориентировочном времени финала задан заново (PER-663).
// Момент лежит в будущем и в поясе сообщества: анонс трансляции не должен
// называть время, которого нет.
export type FinalTimeAskError =
  | "final-time-format"
  | "final-time-moment"
  | "final-time-past";

// Почему вопрос об окне «Счастливых часов» задан заново (PER-504). Сроки окна
// разбираются тем же правилом, что сроки недели; остальное решает Auction.
// Отказы запуска окна по ходу торгов (PER-615) делят с планированием всё, кроме
// случаев, которых у планирования нет: начало в прошлом, торги не идут, лот не
// открыт и пересечение с уже запущенным окном.
export type WindowAskError =
  | "window-format"
  | "window-moment"
  | "window-order"
  | "window-ended"
  | "amount-format"
  | "amount-range"
  | "window-outside-week"
  | "window-overlap"
  | "window-step"
  // Начало запуска раньше момента команды: окно не действует задним числом
  // (ADR-047, дополнение 2026-10-12).
  | "window-in-past"
  // Онлайн-торги не идут: запуск закрывается вместе с онлайн-этапом.
  | "window-not-in-prebidding"
  // Лот запуска не в реестре аукциона или его открытие не подтверждено.
  | "window-lot-not-in-auction"
  | "window-lot-not-open"
  // Пересечение с объявленным или уже запущенным окном: номер окна у запуска
  // нет, окно одно, поэтому текст называет лот и границы другого окна.
  | "launch-overlap";

// Окно в кнопке пульта: номер в конфигурации и отпечаток его сроков и шага.
// Номер сдвигается, когда другое окно удалили; отпечаток ловит это, и кнопка
// со старого экрана не правит чужое окно.
export type WindowRef = { index: number; print: string };

// Исход команды над окнами: свой экран с возвратом к «Счастливым часам».
// `window` — номер окна для человека, с единицы.
export type WindowNote =
  | { kind: "saved"; window: number }
  | { kind: "removed"; window: number }
  // Окна изменились с тех пор, как экран показан: кнопка устарела.
  | { kind: "changed" }
  // Окно без лотов Auction не принимает: снять последний лот нельзя.
  | { kind: "last-lot"; window: number }
  // Лотов в реестре нет: окну нечего назвать.
  | { kind: "no-lots" }
  // Окон уже столько, сколько держит пульт.
  | { kind: "limit" }
  // Лот окна уже стоит в другом окне, которое пересекается с этим по времени.
  | { kind: "overlap"; window: number; other: number }
  // Окно запущено по ходу торгов (PER-615): Auction отвечает записанными
  // границами окна, а чтение пульта может отставать и окна ещё не показывать.
  | { kind: "launched"; from: string; until: string; step: LotAmount }
  // Запуск окна закрыт: онлайн-торги не идут либо неделя кончилась.
  | { kind: "launch-closed" }
  // У запускаемого окна не осталось лотов: окну нужны лоты.
  | { kind: "launch-empty" };

// Черновик запуска окна по ходу торгов (PER-615): сроки, шаг и выбранные лоты.
// `from` нет — окно начинается с момента, в который сервис решил команду.
// Лоты — номерами в отсортированном реестре: реестр во время онлайн-торгов
// заморожен, а лот в кнопку пульта не помещается.
export type LaunchDraft = {
  from?: string;
  until: string;
  step: LotAmount;
  lots: readonly number[];
};

/**
 * Сколько лотов реестра запускаемое окно может назвать (PER-615): набор едет в
 * кнопке пульта битовой маской, а кнопка в 64 байта не помещается. Реестр
 * больше — пульт запускает окно на первых лотах и говорит об этом.
 */
export const launchLotLimit = 64;

// Порядок состава финала в кнопке (PER-619): номера лотов в наборе
// удержанных, который пульт держит по возрастанию идентификатора, и отпечаток
// этого набора. Набор изменился — номера указывают на другие лоты, и отпечаток
// это ловит.
export type LineupPick = { print: string; order: readonly number[] };

// Почему вопрос о следующей цене лота финала задан заново.
export type FinalAskError =
  | "amount-format"
  | "amount-range"
  | "ask-below-current-price";

export type AuctionConsoleCall = LotFormCall & { auctionId: string };

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
  // Розыгрыш (PER-593): вопрос о моменте закрытия регистрации, ответ строкой,
  // как его написал человек, и снятие момента.
  | (AuctionConsoleCall & { intent: "ask-auction-raffle" })
  | (AuctionConsoleCall & {
      intent: "set-auction-raffle";
      value: string;
      opId: string;
    })
  | (AuctionConsoleCall & { intent: "remove-auction-raffle"; opId: string })
  // Приз розыгрыша (PER-649): вопрос об одной строке, ответ, как его написал
  // человек, и снятие приза.
  | (AuctionConsoleCall & { intent: "ask-auction-raffle-prize" })
  | (AuctionConsoleCall & {
      intent: "set-auction-raffle-prize";
      value: string;
      opId: string;
    })
  | (AuctionConsoleCall & {
      intent: "remove-auction-raffle-prize";
      opId: string;
    })
  // Срок оплаты счёта (PER-722): вопрос о числе дней и ответ, как его написал
  // человек. Снятия нет: срок у аукциона есть всегда.
  | (AuctionConsoleCall & { intent: "ask-auction-payment-term" })
  | (AuctionConsoleCall & {
      intent: "set-auction-payment-term";
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
  // Видимость до торгов (PER-673): кнопка несёт целевое состояние.
  | (AuctionConsoleCall & {
      intent: "set-auction-visibility";
      published: boolean;
      opId: string;
    })
  // Ориентировочное время финала (PER-663): вопрос о моменте, ответ строкой,
  // как его написал человек, и снятие момента.
  | (AuctionConsoleCall & { intent: "ask-auction-final-time" })
  | (AuctionConsoleCall & {
      intent: "set-auction-final-time";
      value: string;
      opId: string;
    })
  | (AuctionConsoleCall & { intent: "remove-auction-final-time"; opId: string })
  // Подтверждение удаления, пока неделя не открыта; ключ уедет в «Да».
  | (AuctionConsoleCall & { intent: "prepare-auction-discard"; opId: string })
  | (AuctionConsoleCall & { intent: "discard-auction"; opId: string })
  // Подтверждение отмены после старта торгов; ключ уедет в «Да».
  | (AuctionConsoleCall & { intent: "prepare-auction-cancel"; opId: string })
  | (AuctionConsoleCall & { intent: "cancel-auction"; opId: string })
  | (AuctionConsoleCall & {
      intent: "mark-auction-finalist";
      lotId: string;
      selected: boolean;
      opId: string;
    })
  // Сводка дня торгов (PER-492): окно суток считает край — во времени
  // сообщества, с начала текущего дня по часы бота.
  | (AuctionConsoleCall & { intent: "view-day-summary" })
  // «Счастливые часы» (PER-504): список окон, окно с его лотами, вопрос о
  // новом окне и команды. Каждая команда читает конфигурацию заново и отдаёт
  // её Auction целиком: своего состояния у пульта нет.
  | (AuctionConsoleCall & { intent: "view-step-windows" })
  | (AuctionConsoleCall & {
      intent: "view-step-window";
      window: WindowRef;
      page: number;
    })
  | (AuctionConsoleCall & { intent: "ask-step-window" })
  // Окно приходит строкой, как его написал человек: разбор — дело юзкейса.
  | (AuctionConsoleCall & {
      intent: "add-step-window";
      value: string;
      opId: string;
    })
  // Кнопка несёт целевое состояние лота в окне, а не переворот.
  | (AuctionConsoleCall & {
      intent: "set-step-window-lot";
      window: WindowRef;
      lotId: string;
      selected: boolean;
      opId: string;
    })
  | (AuctionConsoleCall & {
      intent: "remove-step-window";
      window: WindowRef;
      opId: string;
    })
  // Запуск окна сниженного шага по ходу торгов (PER-615): вопрос о начале,
  // конце и шаге, ответ строкой, выбор лотов и сама команда. Черновик едет в
  // кнопке, состояния у пульта нет.
  | (AuctionConsoleCall & { intent: "ask-step-window-launch" })
  | (AuctionConsoleCall & {
      intent: "add-step-window-launch";
      value: string;
    })
  | (AuctionConsoleCall & {
      intent: "set-step-window-launch-lot";
      draft: LaunchDraft;
      lot: number;
    })
  | (AuctionConsoleCall & {
      intent: "view-step-window-launch";
      draft: LaunchDraft;
      page: number;
    })
  | (AuctionConsoleCall & {
      intent: "launch-step-window";
      draft: LaunchDraft;
      opId: string;
    })
  // Состав финала (PER-619): выбор порядка по одному лоту и объявление.
  // Без `pick` выбор начинается заново. Ключ объявления рождается на нажатие
  // «Да»: в кнопке рядом с порядком ему нет места, а повтор после принятого
  // объявления пульт узнаёт по статусу аукциона.
  | (AuctionConsoleCall & {
      intent: "order-final-lineup";
      pick?: LineupPick;
      page: number;
    })
  | (AuctionConsoleCall & {
      intent: "freeze-final-lineup";
      pick: LineupPick;
      opId: string;
    })
  // Финал ведущего (PER-337). Лот финала кнопка называет номером в
  // замороженном составе: токен лота рядом с аукционом и ключом в 64 байта не
  // помещается, а порядок после заморозки не меняется.
  | (AuctionConsoleCall & { intent: "start-auction-final"; opId: string })
  | (AuctionConsoleCall & { intent: "start-final-lot"; opId: string })
  // Вопрос о следующей цене лота: вопрос называет текущую.
  | (AuctionConsoleCall & { intent: "ask-final-price"; position: number })
  // Цена приходит строкой, как её написал человек: разбор — дело юзкейса.
  | (AuctionConsoleCall & {
      intent: "advance-final-ask";
      position: number;
      value: string;
      opId: string;
    })
  // Подтверждение закрытия лота; ключ уедет в «Да».
  | (AuctionConsoleCall & {
      intent: "prepare-final-close";
      position: number;
      opId: string;
    })
  // `quote` — что назвало подтверждение: продажа по цене в минорных единицах
  // либо закрытие без продажи. `freshOpId` — ключ нового подтверждения, если
  // лот с тех пор изменился.
  | (AuctionConsoleCall & {
      intent: "close-final-lot";
      position: number;
      opId: string;
      quote: CloseQuote;
      freshOpId: string;
    });

// Что подтверждение закрытия назвало человеку (PER-337).
export type CloseQuote =
  | { kind: "sale"; minorUnits: number }
  | { kind: "no-sale" };

// «Ставки зала» помощника ведущего (PER-565, ADR-070 пп. 4–6). Кнопка человека
// и «Да» несут лот, человека и цену: устаревший экран не ставит ни на другую
// цену, ни на другой лот. Ключ ставки рождается на нажатие «Да» — повторное
// «Да» Auction отклонит, потому что цена ушла или человек уже лидер.
type FloorCall = LotFormCall;
export type FloorBidTarget = {
  lotId: string;
  participantId: string;
  amount: LotAmount;
};
export type FloorBidsRequest =
  | (FloorCall & {
      intent: "view-floor-bids";
      auctionId: string;
      page: number;
      // Ответ на «Другой человек…»: люди, в чьём имени есть эта строка.
      search?: string;
    })
  | (FloorCall & { intent: "ask-floor-search"; auctionId: string })
  | (FloorCall & { intent: "prepare-floor-bid"; target: FloorBidTarget })
  | (FloorCall & {
      intent: "place-floor-bid";
      target: FloorBidTarget;
      opId: string;
    });

// Сеты лотов аукциона (ADR-073, PER-509): список, сет с лотами реестра,
// вопрос о названии нового сета и команды. Состояния нет: сет кнопка называет
// номером и отпечатком, и каждая команда читает пульт заново, а Auction
// заменяет состав сета целиком.
export type LotSetRef = { index: number; print: string };
export type LotSetsRequest =
  | (AuctionConsoleCall & { intent: "view-lot-sets" })
  | (AuctionConsoleCall & { intent: "ask-lot-set" })
  // Название приходит строкой, как его написал человек; `lotSetId` рождает
  // край, как ключ команды.
  | (AuctionConsoleCall & {
      intent: "add-lot-set";
      value: string;
      lotSetId: string;
      opId: string;
    })
  | (AuctionConsoleCall & {
      intent: "view-lot-set";
      set: LotSetRef;
      page: number;
    })
  // Кнопка несёт целевое состояние лота в сете, а не переворот.
  | (AuctionConsoleCall & {
      intent: "set-lot-set-lot";
      set: LotSetRef;
      lotId: string;
      selected: boolean;
      opId: string;
    })
  | (AuctionConsoleCall & { intent: "prepare-lot-set-delete"; set: LotSetRef })
  | (AuctionConsoleCall & {
      intent: "delete-lot-set";
      set: LotSetRef;
      opId: string;
    });

// Исход команды над сетами: экран исхода с возвратом к «Сетам». `name` —
// название сета, о котором исход.
export type LotSetNote =
  | { kind: "deleted"; name: string }
  | { kind: "already-deleted" }
  // Сет по кнопке не найден: его удалили или номера сдвинулись.
  | { kind: "changed" }
  // Онлайн-торги открыты: сеты заморожены вместе с реестром (ADR-073, п. 2).
  | { kind: "frozen" }
  | { kind: "limit" }
  | { kind: "lot-not-in-auction" }
  | { kind: "lot-in-another-set"; name?: string };

// Порядок и разделы ленты (PER-719): разделы, список раздела или общий
// список, лот в раскладке, вопрос о названии раздела и команды. Состояния
// нет: место кнопка называет номером раздела — `0` — общий список, — а лот
// токеном; каждая команда читает пульт заново и отдаёт Auction раскладку
// целиком.
export type LotLayoutRequest =
  | (AuctionConsoleCall & { intent: "view-lot-layout" })
  | (AuctionConsoleCall & {
      intent: "view-lot-layout-list";
      place: number;
      page: number;
    })
  | (AuctionConsoleCall & { intent: "view-lot-layout-lot"; lotId: string })
  | (AuctionConsoleCall & {
      intent: "move-lot-layout-lot";
      lotId: string;
      direction: LayoutDirection;
      opId: string;
    })
  // Перенос лота в раздел или в общий список: лот встаёт в конец места.
  | (AuctionConsoleCall & {
      intent: "place-lot-layout-lot";
      lotId: string;
      place: number;
      opId: string;
    })
  // Вопрос о названии: нового раздела или, с `sectionId`, переименования.
  | (AuctionConsoleCall & { intent: "ask-lot-section"; sectionId?: number })
  | (AuctionConsoleCall & {
      intent: "name-lot-section";
      sectionId?: number;
      value: string;
      opId: string;
    })
  | (AuctionConsoleCall & {
      intent: "move-lot-section";
      sectionId: number;
      direction: LayoutDirection;
      opId: string;
    })
  | (AuctionConsoleCall & {
      intent: "prepare-lot-section-delete";
      sectionId: number;
    })
  | (AuctionConsoleCall & {
      intent: "delete-lot-section";
      sectionId: number;
      opId: string;
    });

export type LayoutDirection = "up" | "down";

// Исход команды над раскладкой: экран исхода с возвратом к «Порядку и
// разделам». `name` — название раздела, о котором исход.
export type LotLayoutNote =
  | { kind: "deleted"; name: string }
  // Раздел или лот по кнопке не найден: раскладка изменилась.
  | { kind: "changed" }
  // Финал начался или аукцион закончился: лента идёт порядком зала либо
  // больше не меняется (PER-639).
  | { kind: "closed" }
  | { kind: "limit" }
  | { kind: "lot-not-in-auction" };

// Снятие участника с лота администратором (ADR-072, PER-659): участники лота,
// предпросмотр и снятие. Состояния нет: лот, человек и номер лота
// предпросмотра едут в кнопке, а ключ команды рождается на нажатие «Да».
export type RemovalTargetInput = { lotId: string; participantId: string };
export type ParticipantRemovalRequest =
  | (FloorCall & { intent: "view-lot-removal"; lotId: string; page: number })
  | (FloorCall & {
      intent: "prepare-participant-removal";
      target: RemovalTargetInput;
    })
  | (FloorCall & {
      intent: "remove-participant";
      target: RemovalTargetInput;
      version: number;
      opId: string;
    });

// Отказы снятия, которые экран называет словами. Право и сходку пульт
// называет общими кадрами отказа.
export type RemovalRefusal =
  | "lot-not-in-auction"
  | "not-in-prebidding"
  | "lineup-frozen"
  | "lot-not-open"
  | "not-in-online-phase"
  | "deadline-passed"
  | "not-a-lot-participant"
  | "already-removed";

export type RemovalLot = { lotId: string; auctionId: string; title?: string };
// Имени нет — Auction его не назвал: экран не называет человека
// идентификатором.
export type RemovalPerson = { participantId: string; name?: string };

// Лот после снятия, как его решил предпросмотр. `leaderName` нет при лидере —
// Auction не назвал имя.
export type RemovalForecast = {
  price: LotAmount;
  leader: "none" | { name?: string };
  extendedDeadline?: string;
};

// Исход снятия — свой экран (дизайн-код, «Экран исхода»).
export type RemovalNote =
  | {
      kind: "removed";
      name?: string;
      // Лот, прочитанный после снятия; нет — чтение отказало.
      after?: RemovalForecast;
    }
  // С лота в этой фазе не снимают (ADR-072, п. 4): решено по снимку лота
  // до вызова Auction или отказом Auction.
  | { kind: "refused"; reason: RemovalRefusal }
  // Ставок на лоте нет либо все участники уже сняты: снимать некого.
  | { kind: "no-participants" }
  | { kind: "everyone-removed" };

// Подтверждение, которое пришлось задать заново, называет это первой
// строкой: лот ушёл от номера прежнего предпросмотра (ADR-072, дополнение
// 2026-10-21).
export type RemovalConfirm = {
  lot: RemovalLot;
  person: RemovalPerson;
  forecast: RemovalForecast;
  version: number;
  changed?: true;
};

// Счета проданных лотов в пульте организатора (PER-321): сводка, счёт,
// подтверждение отметки и её исход. Статусы и переходы — у счёта в Auction
// (PER-338), бот их не повторяет: просрочку и итоги он считает из полного
// списка, как велит integration.md, «Счета».
export type InvoiceStatus = "awaiting-payment" | "paid" | "handed-over";

// `unspecified` — победитель способ ещё не выбрал; это значение, а не пропуск.
export type FulfillmentMethod =
  | "unspecified"
  | "pickup"
  | "delivery"
  | "digital";

// Счёт, как его отдаёт Auction.
export type Invoice = {
  invoiceId: string;
  auctionId: string;
  lotId: string;
  winnerId: string;
  amount: LotAmount;
  // RFC 3339 в UTC: оплатить до этого мига.
  paymentDueAt: string;
  fulfillment: FulfillmentMethod;
  status: InvoiceStatus;
};

// Строка сводки: счёт с названием лота и именем победителя. Названия нет у
// лота без карточки, имени — если чтение имён отказало.
export type InvoiceRow = Invoice & {
  title?: string;
  winnerName?: string;
  // Ждёт оплаты после срока; просрочка — не статус (integration.md, «Счета»).
  overdue: boolean;
};

// Отметка, которую ставит организатор: оплата либо выдача.
export type InvoiceMark = "paid" | "handed-over";

// Итог по валютам: суммы разных валют не складываются.
export type InvoiceTotals = {
  collected: readonly LotAmount[];
  expected: readonly LotAmount[];
};

export type InvoiceMarkNote =
  | "marked"
  // Оплата или выдача уже отмечены: второго перехода нет, Auction принял
  // повтор молча, а бот это называет.
  | "already-marked"
  // Выдача неоплаченного счёта: Auction её не принимает.
  | "not-paid";

export type AuctionInvoicesRequest =
  | (AuctionConsoleCall & { intent: "view-auction-invoices"; page: number })
  | (AuctionConsoleCall & { intent: "view-auction-invoice"; invoiceId: string })
  | (AuctionConsoleCall & {
      intent: "prepare-invoice-mark";
      invoiceId: string;
      mark: InvoiceMark;
    })
  | (AuctionConsoleCall & {
      intent: "mark-invoice";
      invoiceId: string;
      mark: InvoiceMark;
      opId: string;
    })
  // Текст «Как оплатить и получить» (PER-322): вопрос, ответ на него и снятие.
  | (AuctionConsoleCall & { intent: "ask-auction-payment-text" })
  | (AuctionConsoleCall & {
      intent: "set-auction-payment-text";
      value: string;
      opId: string;
    })
  | (AuctionConsoleCall & {
      intent: "remove-auction-payment-text";
      opId: string;
    });

// Итог розыгрыша вручную (PER-727; ADR-066, дополнение 2026-10-24): экран
// списка билетов со страницей, вопрос о номере, ответ на него, подтверждение
// по номеру из кнопки и «Да» с ключом, рождённым на нажатие.
export type RaffleWinnerRequest =
  | (AuctionConsoleCall & { intent: "view-raffle-winner"; page: number })
  | (AuctionConsoleCall & { intent: "ask-raffle-winner" })
  | (AuctionConsoleCall & { intent: "pick-raffle-winner"; value: string })
  | (AuctionConsoleCall & { intent: "prepare-raffle-winner"; ticket: number })
  | (AuctionConsoleCall & {
      intent: "assign-raffle-winner";
      ticket: number;
      opId: string;
    });

// Смена приза идущего розыгрыша (PER-737; ADR-066, дополнение 2026-10-25):
// вопрос о тексте, ответ на него — подтверждение «было → станет» — и «Да» с
// текстом из экрана подтверждения и ключом, рождённым на нажатие.
export type RafflePrizeChangeRequest =
  | (AuctionConsoleCall & { intent: "ask-raffle-prize-change" })
  | (AuctionConsoleCall & { intent: "pick-raffle-prize-change"; value: string })
  | (AuctionConsoleCall & {
      intent: "change-raffle-prize";
      prize: string;
      opId: string;
    });

// Промо-видео аукциона (PER-774): экран видео из пульта (PER-802) и одна
// команда — задать, заменить или, без `postId`, убрать. Пост в чате медиа
// публикует край до команды: это вызов Telegram. Ключ рождается на ответ с
// видео и на «Да» снятия.
export type PromoVideoRequest =
  | (AuctionConsoleCall & { intent: "view-promo-video" })
  | (AuctionConsoleCall & {
      intent: "set-promo-video";
      opId: string;
      postId?: number;
    });

// Исход промо-видео — свой экран. `set` и `removed` — Auction принял команду;
// `media-off` — чат медиа выключен, `media-failed` — пост в нём не
// опубликовался: команды не было.
export type PromoVideoNote = "set" | "removed" | "media-off" | "media-failed";

// Исход смены приза — свой экран. `changed` несёт приз из ответа Auction,
// `already-drawn` — итог уже есть, `without-result` — итога не будет,
// `no-raffle` — розыгрыша у аукциона нет.
export type RafflePrizeChangeOutcome =
  | { note: "changed"; prize: string }
  | { note: "already-drawn" }
  | { note: "without-result" }
  | { note: "no-raffle" };

// Фото приза идущего розыгрыша (PER-773): экран фото, вопрос о фото, ответ
// фотографией с `photoId` из самого ответа и снятие с ключом, рождённым на
// нажатие «Да».
export type RafflePrizePhotoRequest =
  | (AuctionConsoleCall & { intent: "view-raffle-prize-photo" })
  | (AuctionConsoleCall & { intent: "ask-raffle-prize-photo" })
  | (AuctionConsoleCall & {
      intent: "set-raffle-prize-photo";
      photoId: string;
      image: Uint8Array;
    })
  | (AuctionConsoleCall & {
      intent: "remove-raffle-prize-photo";
      opId: string;
    });

// Непринятый ответ на вопрос о фото приза: не фотография, Telegram файл не
// отдал, Auction не ответил, файл велик или не изображение.
export type RafflePrizePhotoAskError =
  | "photo-needed"
  | "photo-unavailable"
  | "photo-not-saved"
  | "image-too-large"
  | "unsupported-image";

// Исход фото приза — свой экран. `set` и `removed` — команда принята,
// остальное — как у смены приза: итог есть, итога не будет, розыгрыша нет.
export type RafflePrizePhotoOutcome =
  | { note: "set" }
  | { note: "removed" }
  | { note: "already-drawn" }
  | { note: "without-result" }
  | { note: "no-raffle" };

// Непринятый ответ о номере победителя: не номер или вне пула.
export type RaffleWinnerAskError = "winner-format" | "winner-range";

// Исход итога розыгрыша — свой экран. `already-drawn` называет выигравший
// билет, `not-in-pool` — число билетов пула; `not-awaiting` — розыгрыш итога
// не ждёт, `no-raffle` — розыгрыша у аукциона нет.
export type RaffleWinnerOutcome =
  | { note: "assigned"; ticket: RaffleTicketView }
  | { note: "already-drawn"; ticket: RaffleTicketView }
  | { note: "not-in-pool"; tickets: number }
  | { note: "not-awaiting" }
  | { note: "no-raffle" };

// Непринятый ответ о тексте оплаты (PER-322): пустой после обрезки краёв или
// длиннее предела Auction.
export type PaymentTextAskError =
  | "payment-text-empty"
  | "payment-text-too-long";

// Исход команды над текстом оплаты — строка над сводкой счетов.
export type PaymentTextNote = "payment-text-saved" | "payment-text-removed";

// Человек зала — тот, кто выбрал имя в этом аукционе (ADR-070 п. 3).
export type FloorPerson = { participantId: string; name: string };

// Лот, который торгуется в финале сейчас. Следующей цены нет — чтение
// отстаёт от открытия лота, и ставить пока не на что.
export type FloorLot = {
  lotId: string;
  title?: string;
  version: number;
  currentPrice: LotAmount;
  nextPrice?: LotAmount;
  leaderId?: string;
  leaderName?: string;
};

export type FloorView = {
  auctionId: string;
  status: ConsoleAuctionStatus;
  // Нет — лот не открыт: до старта финала, между лотами и после.
  lot?: FloorLot;
  // По алфавиту имени: место человека на экране не меняется от ставок
  // (решение владельца 20.10.2026, дополнение ADR-070).
  people: readonly FloorPerson[];
  // Версии лотов аукциона: по ним живой экран узнаёт изменение в потоке.
  versions: Readonly<Record<string, number>>;
};

// Строка исхода ставки зала над экраном (ADR-070 п. 5). `price` — цена,
// которую назвала кнопка.
export type FloorNote =
  | { kind: "accepted"; name: string; price: LotAmount }
  | {
      kind: "proxy-answered";
      name: string;
      price: LotAmount;
      answer: LotAmount;
    }
  // Принято, но цену уже подняли после ставки — кто, экран не знает.
  | { kind: "outbid"; name: string; price: LotAmount; now: LotAmount }
  | { kind: "price-taken"; price: LotAmount; leader?: string }
  | { kind: "lot-changed" }
  | { kind: "price-changed" }
  | { kind: "bidder-is-leader"; name: string }
  | { kind: "lot-not-open" }
  | { kind: "name-not-chosen"; name?: string }
  | { kind: "cannot-bid"; name?: string }
  | { kind: "removed-from-lot"; name?: string }
  // Ответа на ставку не было: она могла пройти, и лидера показывает экран.
  | { kind: "unanswered"; name?: string; price: LotAmount }
  | { kind: "not-found"; search: string };

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

export type PreviewBroadcastRequest = {
  identity: Person;
  intent: "preview-broadcast";
  audience: BroadcastAudience;
  requestId?: string;
  useCase?: string;
  deadlineAt?: number;
};

export type ReleaseNotesRequest = {
  identity: Person;
  intent: "view-release-notes";
  summaryId?: string;
  part?: number;
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
  // Настройки уведомлений аукциона (PER-552, PER-539): частота — режим
  // целиком, финал — целевое состояние; одна настройка за нажатие.
  | {
      identity: Person;
      intent: "view-auction-notifications";
      requestId?: string;
      useCase?: string;
      deadlineAt?: number;
    }
  | {
      identity: Person;
      intent: "set-auction-notifications";
      change: AuctionNotificationChange;
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
  // Объявление аукциона в пульте (PER-765): шаги и исходы.
  | AuctionAnnouncementResult
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
      cancelConsequence?: AuctionCancelConsequence;
    }
  // Аукцион включён. `alreadyExisted` — аукцион у сходки уже был, и второго
  // не родилось.
  | {
      kind: "auction-enabled";
      meetupId: string;
      auctionId: string;
      alreadyExisted: boolean;
    }
  // Auction отказал по праву администратора сходки или потому, что сходку
  // отменили, — отказ окончательный, и бот его не повторяет.
  | {
      kind: "auction-refused";
      reason: "not-administrator" | "meetup-cancelled";
    }
  // Экран правки лота (PER-319). `saved` — что только что записано: лот собран
  // из ответа команды, потому что чтение Auction её ещё могло не увидеть.
  | {
      kind: "lot-form";
      lot: LotFormView;
      // `photo-missing` — фото, которое подтвердили снять, у лота уже нет:
      // снимать нечего.
      saved?:
        | "created"
        | "text"
        | "terms"
        | "photo-added"
        | "photo-removed"
        | "photo-missing";
    }
  // Предпросмотр лота (PER-512): снимок, прочитанный правом администратора.
  | { kind: "lot-preview"; lot: LotView }
  // Цена принята, спрашивается способ шага (PER-491): один шаг или пороги.
  // Кнопка выбора несёт цену, чтобы рестарт не терял её.
  | { kind: "lot-step-mode"; lot: LotFormView; priceRubles: number }
  // Вопрос формы лота: следующий шаг либо тот же заново, с причиной отказа.
  // Лота нет у нового лота и там, где его не читали.
  | {
      kind: "lot-ask";
      question: LotQuestion;
      lot?: LotFormView;
      error?: LotAskError;
      // Предел Auction в байтах, когда фото его превысило.
      maxImageBytes?: number;
      // Исправленные пороги к отказу `step-start`: те же строки с первой
      // границей 0, когда такой ввод форма приняла бы (PER-709).
      suggestedTiers?: LotTierView[];
    }
  // Отказ Auction, который человеку показывают, а не повторяют. `setName` —
  // сет, в котором лот уже лежит, у отказа `lot-in-set` (PER-716).
  | {
      kind: "lot-refused";
      reason: LotRefusal;
      lotId?: string;
      auctionId?: string;
      // Предел фото, как его назвал Auction, у отказа `photo-limit`.
      maxPhotos?: number;
      setName?: string;
    }
  // Копии заведены и собраны в сет (PER-716): `lot` — исходный лот с новым
  // названием, `total` — лотов в сете вместе с ним, `name` — имя сета.
  | { kind: "lot-copies"; lot: LotFormView; total: number; name: string }
  // Правка сета разнесена (PER-716): до скольких лотов дошла и какие лоты, с
  // причиной, остались без неё.
  | {
      kind: "lot-set-applied";
      lot: LotFormView;
      field: LotSetField;
      // Отпечаток версии разнесённого фото (PER-721) для «Повторить».
      photoPrint?: string;
      applied: number;
      total: number;
      missed: readonly { title: string; reason: LotSetMiss }[];
    }
  // Лот снят из реестра (PER-716). `already` — снятие прошло раньше.
  | {
      kind: "lot-removed";
      auctionId: string;
      title?: string;
      already?: true;
    }
  // Пульт аукциона (PER-320). `note` — исход команды первой строкой. После
  // команды пульт собран из чтения Auction и принятой команды: чтения
  // отстают от команд.
  | {
      kind: "auction-console";
      console: AuctionConsoleView;
      note?: ConsoleNote;
      // Торги идут у другого аукциона: его называет заметка
      // `another-auction-active`.
      holder?: TradingHolder;
      // Переключатель финала принят: исход — всплывающий текст, а не строка.
      toggled?: true;
      // Лот, о котором заметка отметки финала: исход называет его (прогон
      // 14.10, №76).
      noteLot?: string;
    }
  // Вопрос о сроках недели: первый либо тот же заново, с причиной. `window` —
  // номер окна с единицы при `week-cuts-window`.
  | {
      kind: "auction-week-ask";
      auctionId: string;
      week?: AuctionWeek;
      error?: WeekAskError;
      window?: number;
    }
  // Вопрос о моменте розыгрыша (PER-593): первый либо тот же заново, с
  // причиной. Сроки недели заданы: без них вопроса нет.
  | {
      kind: "auction-raffle-ask";
      auctionId: string;
      week: AuctionWeek;
      error?: RaffleAskError;
    }
  // Вопрос о призе розыгрыша (PER-649): первый либо тот же заново, с причиной.
  | {
      kind: "auction-raffle-prize-ask";
      auctionId: string;
      prize?: string;
      error?: RafflePrizeAskError;
    }
  // Вопрос о сроке оплаты счёта (PER-722): первый либо тот же заново, с
  // причиной. `days` — текущий срок в днях, его вопрос повторяет.
  | {
      kind: "auction-payment-term-ask";
      auctionId: string;
      days?: number;
      error?: PaymentTermAskError;
    }
  // Вопрос об ориентировочном времени финала (PER-663): первый либо тот же
  // заново, с причиной. `finalAt` — выставленный анонс, его вопрос повторяет.
  | {
      kind: "auction-final-time-ask";
      auctionId: string;
      finalAt?: string;
      error?: FinalTimeAskError;
    }
  // Сводка дня торгов (PER-492): лоты реестра с агрегатами окна и подпись
  // самого дня. Отбор строк и порядок делает экран, как у пульта.
  | {
      kind: "auction-day-summary";
      auctionId: string;
      day: CommunityDay;
      lots: readonly DaySummaryLot[];
    }
  // «Ставки зала» (PER-565): экран помощника с исходом ставки первой строкой
  // либо люди, найденные по имени (`search`).
  | {
      kind: "floor-bids";
      floor: FloorView;
      page: number;
      note?: FloorNote;
      search?: string;
      // Чтение после ставки отказало: экран — прочитанный до неё, и цена
      // могла устареть.
      stale?: true;
    }
  // Вопрос «Другой человек…»: имя или его часть.
  | { kind: "floor-search-ask"; auctionId: string }
  // Подтверждение ставки зала (ADR-070 п. 4): лот, человек и цена уедут в «Да».
  | {
      kind: "floor-confirm";
      auctionId: string;
      lot: FloorLot;
      person: FloorPerson;
      amount: LotAmount;
    }
  // Снятие участника с лота (PER-659): кого снять, подтверждение с
  // предпросмотром и исход.
  | {
      kind: "removal-people";
      lot: RemovalLot;
      people: readonly RemovalPerson[];
      page: number;
    }
  | ({ kind: "removal-confirm" } & RemovalConfirm)
  | {
      kind: "removal-outcome";
      lot: RemovalLot;
      note: RemovalNote;
      // Номер лота из ответа на снятие: «‹ Лот» дочитывает карточку до него.
      lotVersion?: number;
    }
  // Сеты лотов (PER-509): список либо исход команды над ними.
  // Счета аукциона (PER-321): сводка со страницей, счёт, подтверждение
  // отметки и её исход. Строки сводки уже упорядочены: просроченные первыми.
  // `paymentInstructions` — текст «Как оплатить и получить», `note` — исход
  // команды над ним (PER-322).
  | {
      kind: "auction-invoices";
      auctionId: string;
      invoices: readonly InvoiceRow[];
      totals: InvoiceTotals;
      page: number;
      paymentInstructions?: string;
      note?: PaymentTextNote;
    }
  // Итог розыгрыша вручную (PER-727): список билетов, вопрос о номере с
  // числом билетов пула, подтверждение и исход.
  | {
      kind: "raffle-winner";
      auctionId: string;
      raffle: RaffleView;
      page: number;
    }
  | {
      kind: "raffle-winner-ask";
      auctionId: string;
      tickets: number;
      error?: RaffleWinnerAskError;
    }
  | {
      kind: "raffle-winner-confirm";
      auctionId: string;
      ticket: RaffleTicketView;
    }
  | ({ kind: "raffle-winner-outcome"; auctionId: string } & RaffleWinnerOutcome)
  // Смена приза идущего розыгрыша (PER-737): вопрос с текущим призом,
  // подтверждение «было → станет» и исход.
  | {
      kind: "raffle-prize-change-ask";
      auctionId: string;
      prize?: string;
      error?: RafflePrizeAskError;
    }
  | {
      kind: "raffle-prize-change-confirm";
      auctionId: string;
      before?: string;
      after: string;
    }
  | ({
      kind: "raffle-prize-change-outcome";
      auctionId: string;
    } & RafflePrizeChangeOutcome)
  // Фото приза идущего розыгрыша (PER-773): экран фото, вопрос и исход.
  | { kind: "raffle-prize-photo"; auctionId: string; hasPhoto: boolean }
  | {
      kind: "raffle-prize-photo-ask";
      auctionId: string;
      error?: RafflePrizePhotoAskError;
      maxBytes?: number;
    }
  | ({
      kind: "raffle-prize-photo-outcome";
      auctionId: string;
    } & RafflePrizePhotoOutcome)
  // Промо-видео (PER-774): экран из пульта (PER-802) и исход команды.
  | { kind: "promo-video"; auctionId: string; video: boolean }
  | { kind: "promo-video-outcome"; auctionId: string; note: PromoVideoNote }
  // Вопрос о тексте оплаты (PER-322): первый либо тот же заново, с причиной.
  | { kind: "payment-text-ask"; auctionId: string; error?: PaymentTextAskError }
  | { kind: "auction-invoice"; invoice: InvoiceRow }
  | { kind: "invoice-mark-confirm"; invoice: InvoiceRow; mark: InvoiceMark }
  | {
      kind: "invoice-mark-outcome";
      invoice: InvoiceRow;
      mark: InvoiceMark;
      note: InvoiceMarkNote;
    }
  // Счёта по кнопке в аукционе нет: кнопка подделана или от другого аукциона.
  | { kind: "invoice-missing"; auctionId: string }
  | { kind: "lot-sets"; console: AuctionConsoleSnapshot; note?: LotSetNote }
  // Порядок и разделы ленты (PER-719): экран разделов либо исход команды.
  | {
      kind: "lot-layout";
      console: AuctionConsoleSnapshot;
      note?: LotLayoutNote;
    }
  // Список раздела (`place` — его номер) или общий список (`0`): страница
  // либо лот, чью страницу показать.
  | {
      kind: "lot-layout-list";
      console: AuctionConsoleSnapshot;
      place: number;
      at: { page: number } | { lotId: string };
    }
  // Лот в раскладке; `moved` — команда принята, исход — всплывающий текст.
  | {
      kind: "lot-layout-lot";
      console: AuctionConsoleSnapshot;
      lotId: string;
      moved?: true;
    }
  // Вопрос о названии раздела: первый либо тот же заново.
  | {
      kind: "lot-section-ask";
      auctionId: string;
      sectionId?: number;
      error?: "name-empty" | "name-taken";
    }
  | {
      kind: "lot-section-delete-confirm";
      console: AuctionConsoleSnapshot;
      sectionId: number;
    }
  // Сет и лоты реестра с отметкой «в сете»: страница списка либо лот, чью
  // страницу показать. `toggled` — принят переключатель лота.
  | {
      kind: "lot-set";
      console: AuctionConsoleSnapshot;
      index: number;
      at: { page: number } | { lotId: string };
      toggled?: { selected: boolean };
    }
  // Вопрос о названии нового сета: первый либо тот же заново.
  | { kind: "lot-set-ask"; auctionId: string; error?: "name-empty" }
  // Подтверждение удаления сета; ключ команды рождается на «Да».
  | {
      kind: "lot-set-delete-confirm";
      console: AuctionConsoleSnapshot;
      index: number;
    }
  // «Счастливые часы» (PER-504): список окон либо исход команды над ними.
  | {
      kind: "step-windows";
      console: AuctionConsoleView;
      note?: WindowNote;
      // Запуск окна доступен (PER-615): идут онлайн-торги и общий дедлайн не
      // прошёл. Решает край по часам бота — статус аукциона может отставать.
      launch?: boolean;
    }
  // Окно и лоты реестра с отметкой «в окне»: страница списка либо лот, чью
  // страницу показать. `toggled` — принят переключатель лота: исход —
  // всплывающий текст, а не экран.
  | {
      kind: "step-window";
      console: AuctionConsoleView;
      index: number;
      at: { page: number } | { lotId: string };
      toggled?: { selected: boolean };
    }
  // Вопрос о новом окне: первый либо тот же заново, с причиной. `window` —
  // номер окна с единицы, с которым новое пересеклось.
  | {
      kind: "step-window-ask";
      auctionId: string;
      week?: AuctionWeek;
      error?: WindowAskError;
      window?: number;
    }
  // Запуск окна по ходу торгов (PER-615): вопрос о начале, конце и шаге и
  // экран запуска с лотами. `error` — причина, по которой вопрос задан заново;
  // `lot` — лот, который отказ назвал, `other` — границы окна, с которым
  // запущенное пересеклось.
  | {
      kind: "step-window-launch-ask";
      auctionId: string;
      week?: AuctionWeek;
      error?: WindowAskError;
      lot?: string;
      other?: { from: string; until: string };
    }
  // Экран запуска окна: черновик и лоты реестра переключателями.
  | {
      kind: "step-window-launch";
      console: AuctionConsoleView;
      draft: LaunchDraft;
      at: { page: number } | { lot: number };
      toggled?: { selected: boolean };
    }
  // Подтверждение открытия недели: сколько лотов откроется и сколько
  // останется без торгов — без цены и шага. `opId` уедет в «Да».
  | {
      kind: "auction-week-confirm";
      console: AuctionConsoleView;
      opId: string;
      opening: number;
      idle: number;
      // Начало недели ещё впереди: Auction открывает лоты сразу, и
      // подтверждение говорит, что ставки не ждут начала (прогон 14.10, №58).
      early?: true;
    }
  // Подтверждение удаления аукциона до торгов: `lots` — сколько лотов уйдёт
  // из аукциона вместе с ним. `opId` уедет в «Да».
  | {
      kind: "auction-discard-confirm";
      auctionId: string;
      opId: string;
      lots: number;
    }
  // Аукцион удалён: у сходки снова «Включить аукцион».
  | { kind: "auction-discarded"; auctionId: string }
  // Подтверждение отмены аукциона после старта торгов: `sold` — сколько лотов
  // уже продано, они останутся проданными. `opId` уедет в «Да».
  | {
      kind: "auction-cancel-confirm";
      auctionId: string;
      opId: string;
      sold: number;
    }
  // Вопрос о следующей цене лота финала: первый либо тот же заново, с
  // причиной. `mustExceed` — порог, который назвал отказ Auction.
  | {
      kind: "final-ask";
      auctionId: string;
      position: number;
      title?: string;
      nextPrice?: LotAmount;
      error?: FinalAskError;
      mustExceed?: LotAmount;
    }
  // Лот финала закрыт: продан покупателю за цену либо закрыт без продажи.
  // Имени покупателя нет, когда Auction его не назвал; `buyerUsername` —
  // настоящий аккаунт для организатора (PER-648), когда ему его отдал Identity.
  | {
      kind: "final-lot-closed";
      auctionId: string;
      title?: string;
      closure:
        | {
            kind: "sold";
            price: LotAmount;
            buyerName?: string;
            buyerUsername?: string;
          }
        | { kind: "unsold" };
      // Закрыт последний лот состава — аукцион завершён (PER-639): сколько
      // лотов аукциона продано и за сколько всего, с этим закрытием.
      finished?: { soldLots: number; total: LotAmount };
    }
  // Подтверждение закрытия лота финала: продажа лидеру по текущей цене либо
  // закрытие без продажи, если ставок нет. `opId` уедет в «Да».
  | {
      kind: "final-close-confirm";
      auctionId: string;
      position: number;
      opId: string;
      title?: string;
      price?: LotAmount;
      leaderName?: string;
      // Настоящий аккаунт лидера для организатора (PER-648); участнику
      // Identity его не отдаёт, и поле остаётся пустым.
      leaderUsername?: string;
      // Подтверждение задано заново: цена или лидер изменились после
      // прежнего, и закрывать по нему бот не стал.
      changed?: true;
    }
  // Выбор порядка состава финала (PER-619): удержанные лоты по возрастанию
  // идентификатора и уже выбранные номера. `changed` — набор удержанных
  // изменился после прежнего экрана, и выбор начат заново.
  | {
      kind: "lineup-order";
      console: AuctionConsoleView;
      held: readonly ConsoleLot[];
      pick: LineupPick;
      page: number;
      changed?: true;
    }
  // Подтверждение состава: `pick` полон и уедет в «Да».
  | {
      kind: "lineup-confirm";
      console: AuctionConsoleView;
      held: readonly ConsoleLot[];
      pick: LineupPick;
    }
  // Отказ пульту целиком: не администратор сходки, аукциона нет или сходку
  // отменили. Скрытая сходка — исход пульта (`ConsoleNote`), а не отказ ему.
  | {
      kind: "auction-console-refused";
      reason: "not-administrator" | "auction-not-found" | "meetup-cancelled";
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
  | {
      kind: "release-post";
      summaryId: string;
      summarizedAt: string;
      lines: readonly string[];
      part: number;
      partCount: number;
      older?: { summaryId: string; part: number };
      newer?: { summaryId: string; part: number };
    }
  | { kind: "release-empty" }
  | { kind: "auction-notifications"; settings: AuctionNotificationSettings }
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
  // дата сходки раньше сегодняшнего дня сообщества, и в «Сходках» её нет.
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
      // Поле точечной правки: итог называет его и новое значение (прогон
      // 14.10, №56). Нет у ответа формы, пришедшего после публикации.
      field?: FormField;
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
  | {
      kind: "broadcast-audience";
      audience: BroadcastAudience;
      recipientCount: number;
    }
  | { kind: "material-attached"; meetup: MeetupSnapshot }
  | { kind: "material-removed"; meetup: MeetupSnapshot }
  | {
      kind: "edit-unavailable";
      reason: "cancelled";
      meetup: MeetupSnapshot;
    }
  // Ответ на старую кнопку «Создать сходку»: сходка с её id уже названа или
  // опубликована, и ответ её не трогает.
  | { kind: "meetup-exists"; meetup: MeetupSnapshot }
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
