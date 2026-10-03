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
export type ResolveIdentityResult =
  | {
      kind: "resolved";
      identityId: string;
      globalRoles: readonly string[];
      blocked: boolean;
    }
  | { kind: "unavailable"; cause: unknown }
  | { kind: "rejected"; code: string; cause: unknown };

export type IdentityResolver = {
  resolve(
    input: ResolveIdentityInput,
    meta?: RpcMetadata,
  ): Promise<ResolveIdentityResult>;
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
