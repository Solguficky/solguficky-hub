import type {
  RoleRequestOutcome,
  SurfaceCircle,
} from "@solguficky/auction-bot-ui";
import type { RpcMetadata } from "../rpc-metadata.js";

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
// ролей: блокировка отзывает роли, и заблокированный иначе неотличим от
// человека, который ни разу не начинал.
export type IdentityFailure =
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type ResolveIdentityResult =
  | {
      kind: "resolved";
      identityId: string;
      globalRoles: readonly string[];
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
// разрешения личности, плюс круг поверхности, код канала и имя для карточки
// модератора.
export type RequestRoleInput = ResolveIdentityInput & {
  requestedRole: SurfaceCircle;
  // Код канала из payload `s_<код>` без префикса, как пришёл. Нет — payload
  // префикса не нёс; пустая строка — пустой код после `s_`.
  sourceCode?: string;
  firstName: string;
};

// Отметки блокировки в ответе входа нет: её несёт исход `blocked`. Словарь
// исходов — общего пакета: по нему политика пакета решает вход.
export type RequestRoleResult =
  | {
      kind: "answered";
      identityId: string;
      globalRoles: readonly string[];
      outcome: RoleRequestOutcome;
    }
  | IdentityFailure;

export type RoleRequester = {
  requestRole(
    input: RequestRoleInput,
    meta?: RpcMetadata,
  ): Promise<RequestRoleResult>;
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

export type IdentityActor = {
  identityId: string;
  globalRoles: readonly string[];
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
export type CommunityMember = {
  identityId: string;
  telegramUsername?: string;
  // Нет у ответа старого Identity, который поле не присылает.
  telegramUserId?: bigint;
  admitted: boolean;
};
export type CommunitySnapshot = {
  members: readonly CommunityMember[];
  allowedUsernames: readonly string[];
};
export type IdentityAdminResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "unavailable"; cause: unknown };

export type CommunityAdministrator = {
  community(
    actor: IdentityActor,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<CommunitySnapshot>>;
  admit(
    actor: IdentityActor,
    identityId: string,
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<boolean>>;
  block(
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

export type ApplicationModerator = {
  readApplicationQueue(
    actor: IdentityActor,
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
    meta?: RpcMetadata,
  ): Promise<IdentityAdminResult<readonly RefusedApplication[]>>;
  reconsiderApplication(
    actor: IdentityActor,
    applicationId: string,
    meta?: RpcMetadata,
  ): Promise<ReconsiderResult>;
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
