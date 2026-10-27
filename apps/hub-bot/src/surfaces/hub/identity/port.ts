import type {
  AccessRequestOutcome,
  AccessRight,
  ApplicationQueue,
} from "../../../auction-ui/index.js";
import type { RpcMetadata } from "../../../core/rpc-metadata.js";

export type ResolveIdentityInput = {
  telegramUserId: bigint;
  telegramUsername?: string;
};

export function toResolveIdentityInput(
  telegramUserId: bigint,
  telegramUsername: string | undefined,
): ResolveIdentityInput {
  if (telegramUsername === undefined) {
    return { telegramUserId };
  }
  return { telegramUserId, telegramUsername };
}

// Три исхода, а не два: недоступность зависимости и нарушение контракта
// различаются наблюдаемо. Повтор лечит первое и никогда не лечит второе,
// поэтому first-slice.md требует различать их в логах и метриках.
//
// Отметка блокировки идёт отдельным полем, а не выводится из пустого набора
// прав: блокировка отзывает права, и заблокированный иначе неотличим от
// человека, который ни разу не начинал.
export type IdentityFailure =
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type ResolveIdentityResult =
  | {
      kind: "resolved";
      identityId: string;
      rights: readonly AccessRight[];
      blocked: boolean;
    }
  | IdentityFailure;

export type IdentityResolver = {
  resolve(
    input: ResolveIdentityInput,
    meta?: RpcMetadata,
  ): Promise<ResolveIdentityResult>;
};

// Вход на `/start` (ADR-060, пункты 1–7 и 17–19): человек тот же, что у
// разрешения личности, плюс очередь поверхности, код канала и имя для карточки
// модератора.
export type RequestAccessInput = ResolveIdentityInput & {
  queue: ApplicationQueue;
  // Код канала из payload `s_<код>` без префикса, как пришёл. Нет — payload
  // префикса не нёс; пустая строка — пустой код после `s_`.
  sourceCode?: string;
  firstName: string;
};

// Отметки блокировки в ответе входа нет: её несёт исход `blocked`. Словарь
// исходов — аукционного дерева: по нему политика дерева решает вход.
export type RequestAccessResult =
  | {
      kind: "answered";
      identityId: string;
      rights: readonly AccessRight[];
      outcome: AccessRequestOutcome;
    }
  | IdentityFailure;

export type AccessRequester = {
  requestAccess(
    input: RequestAccessInput,
    meta?: RpcMetadata,
  ): Promise<RequestAccessResult>;
};

// Обратный путь для канала доставки: уведомление несёт внутренний идентификатор,
// а писать можно только по Telegram id. Отсутствующий и заблокированный профиль
// — разные исходы: оба окончательные, но в журнале и логах различимы, а
// недоступность Identity, в отличие от них, лечится повтором.
export type TelegramRecipientResult =
  | { kind: "resolved"; telegramUserId: bigint }
  | { kind: "not-found" }
  | { kind: "blocked" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type TelegramRecipientResolver = {
  resolveTelegramUserId(
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<TelegramRecipientResult>;
};

// Действующий в командах Identity. Права Identity читает у себя (RFC-016):
// бот передаёт только идентификатор.
export type IdentityActor = {
  identityId: string;
};

// Ник автора сходки для карточки (PER-404). Identity отвечает только про
// действующего администратора: для остальных, отсутствующих и заблокированных
// — одинаковый `not-found`. Отсутствие ника — `resolved` без поля, а не отказ.
export type OrganizerUsernameResult =
  | { kind: "resolved"; telegramUsername?: string }
  | { kind: "not-found" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type OrganizerResolver = {
  resolveOrganizerUsername(
    viewer: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<OrganizerUsernameResult>;
};

// Настоящий аккаунт участника аукциона для экранов организатора (PER-648).
// Identity отвечает только держателю права `run-auctions`: `denied` — обычный
// ответ участнику, который открыл карточку проданного лота, и экран остаётся с
// псевдонимом. Отсутствие ника — `resolved` без поля, а не отказ.
export type ParticipantUsernameResult =
  | { kind: "resolved"; telegramUsername?: string }
  | { kind: "denied" }
  | { kind: "not-found" }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type ParticipantUsernameResolver = {
  resolveParticipantUsername(
    viewer: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<ParticipantUsernameResult>;
};
// Круг человека состава (ADR-065, п. 1). `none` — круга нет: человек нажал
// кнопку бота, но не допущен ни в один круг.
export type CommunityCircle = "member" | "guest" | "none";
export type CommunityMember = {
  identityId: string;
  telegramUsername?: string;
  // Нет у ответа старого Identity, который поле не присылает.
  telegramUserId?: bigint;
  circle: CommunityCircle;
  // Запись admit_bidders (ADR-065, п. 4): её снимает отзыв. У держателя
  // набора admin, который тоже в составе (PER-618), право от набора, а не
  // записью, и здесь оно ложно.
  auctionModeration: boolean;
  // Запись run_auctions (ADR-070, п. 1) — так же: у набора admin ложно.
  auctionRunning: boolean;
};
// Фильтр состава (PER-547): люди без круга не входят ни в один.
export type CommunityFilter = "members" | "guests" | "moderators";
export type CommunitySnapshot = {
  members: readonly CommunityMember[];
  allowedUsernames: readonly string[];
};
export type IdentityAdminResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "unavailable"; cause: unknown };

// Карточка человека состава. Отказы — значения ответа Identity (PER-547):
// `identity-unknown` — профиля нет, `blocked` — доступ уже закрыт,
// `holds-preset` — человек держит набор и ведётся экраном администраторов.
export type CommunityMemberResult =
  | IdentityAdminResult<CommunityMember>
  | { kind: "identity-unknown" }
  | { kind: "blocked" }
  | { kind: "holds-preset" };

export type CommunityAdministrator = {
  community(
    actor: IdentityActor,
    filter: CommunityFilter,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<CommunitySnapshot>>;
  communityMember(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<CommunityMemberResult>;
  block(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  // Понижение участника до гостя (PER-642): тот же отказ по кругу `member`,
  // что и отказ по заявке (ADR-060, п. 13). `false` — круга `member` у человека
  // уже нет, в том числе у заблокированного. Держатель набора — отказ Identity
  // (ADR-065, п. 8), а не значение ответа: карточку такого человека бот и так
  // не показывает.
  demote(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  addAllowedUsername(
    actor: IdentityActor,
    username: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  removeAllowedUsername(
    actor: IdentityActor,
    username: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
};

// Отказанная заявка (ADR-060, пункт 14). Круг — то, что выдаст пересмотр;
// исход — как отказали: блокировкой в `public` или `declined` в `member`.
// Имени нет: его обнулило решение. Момент отказа — уже в поясе сообщества.
export type RefusedApplication = {
  applicationId: string;
  identityId: string;
  telegramUserId: bigint;
  telegramUsername?: string;
  circle: "member" | "public";
  outcome: "blocked" | "declined";
  // Нет, когда заявку закрыл не администратор.
  decidedBy?: { telegramUserId: bigint; telegramUsername?: string };
  decidedAt: CommunityMoment;
};
export type CommunityMoment = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
};
// `not-refused` — отказ сейчас не пересмотреть: заявка уже не в отказе или
// профиль заблокирован, и пересмотр `declined` блокировку не снимает.
export type ReconsiderResult =
  | IdentityAdminResult<boolean>
  | { kind: "not-refused" };

// Место в очереди заявок: момент создания и идентификатор карточки. Момент —
// миллисекунды эпохи: Identity хранит его ровно с этой точностью и сравнивает
// курсор как момент, поэтому кнопка несёт его короче строки RFC 3339.
export type ApplicationCursor = { createdAtMs: number; applicationId: string };

// Карточка заявки (ADR-060, пункт 21). Источник различает три случая: кода не
// было, код был, но реестр его не знал, и канал с подписью.
export type ApplicationCard = {
  applicationId: string;
  identityId: string;
  telegramUserId: bigint;
  telegramUsername?: string;
  // Нет у заявок, созданных миграцией данных.
  firstName?: string;
  circle: "member" | "public";
  source:
    | { kind: "none" }
    | { kind: "unknown" }
    | { kind: "channel"; label: string };
  createdAtMs: number;
};

// Пустая очередь после курсора — карточки нет, а `total` всё равно считает все
// открытые заявки: по нему экран отличает конец очереди от пустой очереди.
export type ApplicationQueueRead = {
  card?: { application: ApplicationCard; position: number };
  total: number;
};

export type ApplicationOutcome =
  | "admitted"
  | "declined"
  | "blocked"
  | "closed-by-grant"
  | "closed-by-block";

// `already` — заявку закрыли раньше этого вызова, и он ничего не изменил
// (ADR-060, пункт 9). Решившего нет, когда заявку закрыл разрешённый ник.
export type ApplicationDecision = {
  already: boolean;
  outcome: ApplicationOutcome;
  decidedBy?: { telegramUserId: bigint; telegramUsername?: string };
};

// Очередь заявок называет каждый вызов чтения: две очереди читаются порознь, и
// курсор одной не ставит другую (ADR-064, пункт 12). Решение и пересмотр берут
// очередь из самой заявки.
export type ApplicationModerator = {
  readApplicationQueue(
    actor: IdentityActor,
    queue: ApplicationQueue,
    after: ApplicationCursor | undefined,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<ApplicationQueueRead>>;
  admitApplication(
    actor: IdentityActor,
    applicationId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<ApplicationDecision>>;
  declineApplication(
    actor: IdentityActor,
    applicationId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<ApplicationDecision>>;
};

export type ApplicationAdministrator = {
  refusedApplications(
    actor: IdentityActor,
    queue: ApplicationQueue,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<readonly RefusedApplication[]>>;
  reconsiderApplication(
    actor: IdentityActor,
    applicationId: string,
    meta?: RpcMetadata,
  ): Promise<ReconsiderResult>;
};

// Право, которое участнику выдают поштучной записью с карточки состава:
// модерация аукциона (ADR-065, п. 4) и ведение аукциона (ADR-070, п. 1).
export type RecordRight = "admit-bidders" | "run-auctions";

// `not-member` у выдачи — человек не участник или заблокирован: запись
// получает только участник, который остаётся в своём круге.
export type GrantRecordResult =
  | IdentityAdminResult<boolean>
  | { kind: "not-member" };

// Выдача и отзыв записи — у держателя права управлять составом; Identity
// решает это сам по своему хранилищу.
export type RightRecordAdministrator = {
  grantRightRecord(
    actor: IdentityActor,
    identityId: string,
    right: RecordRight,
    meta?: RpcMetadata,
  ): Promise<GrantRecordResult>;
  revokeRightRecord(
    actor: IdentityActor,
    identityId: string,
    right: RecordRight,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
};

// Держатель набора admin, maintainer или обоих (ADR-065). `admin` — набор
// снимается из бота; один `maintainer` снимается только общим секретом.
export type Administrator = {
  identityId: string;
  telegramUserId: bigint;
  telegramUsername?: string;
  maintainer: boolean;
  admin: boolean;
};

// Отказы методов администраторов — значения ответа Identity, а не статусы
// (PER-521): каждый назван своим видом. `forbidden` — у актора нет права
// grant_admins; о цели он тогда ничего не узнаёт. `invalid` — Identity не
// разобрал запрос: ник не ник Telegram или идентификатор не канонический.
export type AppointAdministratorResult =
  | { kind: "ok"; value: { identityId: string; changed: boolean } }
  | { kind: "forbidden" }
  | { kind: "username-unknown" }
  | { kind: "not-member" }
  | { kind: "blocked" }
  | { kind: "username-unresolved" }
  | { kind: "invalid" }
  | { kind: "unavailable"; cause: unknown };
export type DismissAdministratorResult =
  | IdentityAdminResult<boolean>
  | { kind: "identity-unknown" };

// Назначение и снятие набора admin — у держателя права grant_admins (ADR-065,
// пункты 6 и 7); право Identity читает сам.
export type AdministratorManager = {
  administrators(
    actor: IdentityActor,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<readonly Administrator[]>>;
  appointAdministrator(
    actor: IdentityActor,
    telegramUsername: string,
    meta?: RpcMetadata,
  ): Promise<AppointAdministratorResult>;
  dismissAdministrator(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<DismissAdministratorResult>;
};

// Канал прихода (ADR-060, пункт 18): код из payload `s_<код>` без префикса и
// подпись, которую модератор видит на карточке заявки.
export type SourceChannel = { code: string; label: string };

// `invalid` у заведения — Identity отверг код или подпись: их вводит
// администратор, и неверный ввод здесь отказ, а не «неизвестный источник».
// `ok` с `false` — канал с этим кодом уже заведён, подпись не переписана.
export type SourceChannelAdministrator = {
  sourceChannels(
    actor: IdentityActor,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<readonly SourceChannel[]>>;
  createSourceChannel(
    actor: IdentityActor,
    channel: SourceChannel,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
};
