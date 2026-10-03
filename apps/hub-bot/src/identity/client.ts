import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  ApplicationOutcome,
  IdentityService,
  type RefusedApplication as WireRefusedApplication,
} from "../../gen/identity/v1/identity_service_pb.js";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import { communityLocalTime } from "../community-time.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
  type RpcMetadata,
} from "../rpc-metadata.js";
import { type RpcClientOptions, traceRpc } from "../tracing.js";
import type {
  ApplicationAdministrator,
  CommunityAdministrator,
  IdentityResolver,
  OrganizerResolver,
  OrganizerUsernameResult,
  ReconsiderResult,
  RefusedApplication,
  ResolveIdentityInput,
  ResolveIdentityResult,
  TelegramRecipientResolver,
  TelegramRecipientResult,
} from "./port.js";

export const identityRpcTimeoutMs = 3_000;

export { requestIdHeader, useCaseHeader } from "../rpc-metadata.js";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: рукописная
// копия форм запроса, ответа и CallOptions расходится с contracts/proto молча,
// а Pick по сгенерированному Client роняет typecheck на первом же расхождении.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  "resolveIdentity"
>;
export type TelegramRecipientRpc = Pick<
  Client<typeof IdentityService>,
  "resolveTelegramUserId"
>;
export type OrganizerRpc = Pick<
  Client<typeof IdentityService>,
  "resolveOrganizerUsername"
>;
type IdentityAdminRpc = Pick<
  Client<typeof IdentityService>,
  | "listCommunityMembers"
  | "admitCommunityMember"
  | "blockCommunityMember"
  | "listAllowedUsernames"
  | "addAllowedUsername"
  | "removeAllowedUsername"
>;
type ApplicationAdminRpc = Pick<
  Client<typeof IdentityService>,
  "listRefusedApplications" | "reconsiderApplication"
>;

export type IdentityClient = IdentityResolver &
  TelegramRecipientResolver &
  OrganizerResolver &
  CommunityAdministrator &
  ApplicationAdministrator & {
    close(): void;
  };

export function createIdentityClient(
  baseUrl: string,
  {
    communityTimeZone,
    tracing,
    serviceToken,
    timeoutMs = identityRpcTimeoutMs,
  }: RpcClientOptions & { communityTimeZone: string },
): IdentityClient {
  const sessionManager = new Http2SessionManager(baseUrl);
  const transport = createGrpcTransport({
    baseUrl,
    defaultTimeoutMs: timeoutMs,
    sessionManager,
    interceptors: [presentServiceToken(serviceToken), traceRpc(tracing)],
  });
  const client = createClient(IdentityService, transport);
  const resolver = createIdentityResolver(client, timeoutMs);
  const administrator = createCommunityAdministrator(client, timeoutMs);
  const applications = createApplicationAdministrator(client, {
    timeoutMs,
    communityTimeZone,
  });
  const recipients = createTelegramRecipientResolver(client, timeoutMs);
  const organizers = createOrganizerResolver(client, timeoutMs);
  return {
    resolve: (input, meta) => resolver.resolve(input, meta),
    resolveTelegramUserId: (identityId, meta) =>
      recipients.resolveTelegramUserId(identityId, meta),
    resolveOrganizerUsername: (viewer, identityId, meta) =>
      organizers.resolveOrganizerUsername(viewer, identityId, meta),
    ...administrator,
    ...applications,
    close() {
      sessionManager.abort();
    },
  };
}

export function createCommunityAdministrator(
  rpc: IdentityAdminRpc,
  timeoutMs = identityRpcTimeoutMs,
): CommunityAdministrator {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  const actorMessage = (actor: {
    identityId: string;
    globalRoles: readonly string[];
  }) => ({
    identityId: actor.identityId,
    globalRoles: actor.globalRoles.map(roleValue),
  });
  const change = async (call: () => Promise<{ changed: boolean }>) => {
    try {
      return { kind: "ok" as const, value: (await call()).changed };
    } catch (cause) {
      return classifyAdminFailure(cause);
    }
  };
  return {
    async community(actor, meta) {
      try {
        const wireActor = actorMessage(actor);
        const [members, usernames] = await Promise.all([
          rpc.listCommunityMembers({ actor: wireActor }, options(meta)),
          rpc.listAllowedUsernames({ actor: wireActor }, options(meta)),
        ]);
        return {
          kind: "ok",
          value: {
            members: members.members.map((member) => ({
              identityId: member.identityId,
              ...(member.telegramUsername === undefined
                ? {}
                : { telegramUsername: member.telegramUsername }),
              // Настоящий Telegram id всегда положителен, ноль — поле не пришло.
              ...(member.telegramUserId > 0n
                ? { telegramUserId: member.telegramUserId }
                : {}),
              admitted: member.admitted,
            })),
            allowedUsernames: usernames.usernames,
          },
        };
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
    },
    admit: (actor, identityId, meta) =>
      change(() =>
        rpc.admitCommunityMember(
          { actor: actorMessage(actor), identityId },
          options(meta),
        ),
      ),
    block: (actor, identityId, meta) =>
      change(() =>
        rpc.blockCommunityMember(
          { actor: actorMessage(actor), identityId },
          options(meta),
        ),
      ),
    addAllowedUsername: (actor, username, meta) =>
      change(() =>
        rpc.addAllowedUsername(
          { actor: actorMessage(actor), username },
          options(meta),
        ),
      ),
    removeAllowedUsername: (actor, username, meta) =>
      change(() =>
        rpc.removeAllowedUsername(
          { actor: actorMessage(actor), username },
          options(meta),
        ),
      ),
  };
}

// Список отказанных и пересмотр (ADR-060, пункт 14). Момент отказа переводится
// в пояс сообщества здесь, как момент публикации у Meetups: экран показывает
// местное время, а не UTC.
export function createApplicationAdministrator(
  rpc: ApplicationAdminRpc,
  {
    timeoutMs = identityRpcTimeoutMs,
    communityTimeZone,
  }: { timeoutMs?: number; communityTimeZone: string },
): ApplicationAdministrator {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  const actorMessage = (actor: {
    identityId: string;
    globalRoles: readonly string[];
  }) => ({
    identityId: actor.identityId,
    globalRoles: actor.globalRoles.map(roleValue),
  });
  return {
    async refusedApplications(actor, meta) {
      let response: Awaited<
        ReturnType<ApplicationAdminRpc["listRefusedApplications"]>
      >;
      try {
        response = await rpc.listRefusedApplications(
          { actor: actorMessage(actor) },
          options(meta),
        );
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
      const applications: RefusedApplication[] = [];
      for (const application of response.applications) {
        const refused = refusedOf(application, communityTimeZone);
        // Строка вне контракта — рассинхрон схемы: пропустить её значило бы
        // молча спрятать отказ от администратора.
        if (refused === undefined) return { kind: "invalid" };
        applications.push(refused);
      }
      return { kind: "ok", value: applications };
    },
    async reconsiderApplication(actor, applicationId, meta) {
      try {
        const response = await rpc.reconsiderApplication(
          { actor: actorMessage(actor), applicationId },
          options(meta),
        );
        return { kind: "ok", value: response.changed };
      } catch (cause) {
        return classifyReconsiderFailure(cause);
      }
    },
  };
}

function refusedOf(
  value: WireRefusedApplication,
  communityTimeZone: string,
): RefusedApplication | undefined {
  const circle =
    value.requestedRole === GlobalRole.MEMBER
      ? "member"
      : value.requestedRole === GlobalRole.PUBLIC
        ? "public"
        : undefined;
  const outcome =
    value.decision?.outcome === ApplicationOutcome.BLOCKED
      ? "blocked"
      : value.decision?.outcome === ApplicationOutcome.DECLINED
        ? "declined"
        : undefined;
  if (circle === undefined || outcome === undefined) return undefined;
  let decidedAt: RefusedApplication["decidedAt"];
  try {
    decidedAt = communityLocalTime(
      value.decision?.decidedAt ?? "",
      communityTimeZone,
    );
  } catch {
    return undefined;
  }
  const decider = value.decision?.decidedBy;
  return {
    applicationId: value.applicationId,
    identityId: value.identityId,
    telegramUserId: value.telegramUserId,
    ...(value.telegramUsername === undefined
      ? {}
      : { telegramUsername: value.telegramUsername }),
    circle,
    outcome,
    ...(decider === undefined
      ? {}
      : {
          decidedBy: {
            telegramUserId: decider.telegramUserId,
            ...(decider.telegramUsername === undefined
              ? {}
              : { telegramUsername: decider.telegramUsername }),
          },
        }),
    decidedAt,
  };
}

// FAILED_PRECONDITION контракт отдал ожидаемому исходу: отказ не пересмотреть
// (integration.md, ReconsiderApplication). Остальное — как у команд состава.
function classifyReconsiderFailure(cause: unknown): ReconsiderResult {
  if (cause instanceof ConnectError && cause.code === Code.FailedPrecondition) {
    return { kind: "not-refused" };
  }
  return classifyAdminFailure(cause);
}

function classifyAdminFailure(cause: unknown) {
  if (cause instanceof ConnectError) {
    if (
      cause.code === Code.PermissionDenied ||
      cause.code === Code.Unauthenticated
    )
      return { kind: "forbidden" as const };
    if (permanentCodes.has(cause.code)) return { kind: "invalid" as const };
  }
  return { kind: "unavailable" as const, cause };
}

function roleValue(role: string): GlobalRole {
  switch (role) {
    case "admin":
      return GlobalRole.ADMIN;
    case "maintainer":
      return GlobalRole.MAINTAINER;
    case "member":
      return GlobalRole.MEMBER;
    case "public":
      return GlobalRole.PUBLIC;
    default:
      return GlobalRole.UNSPECIFIED;
  }
}

export function createIdentityResolver(
  rpc: IdentityRpc,
  timeoutMs = identityRpcTimeoutMs,
): IdentityResolver {
  return {
    async resolve(input: ResolveIdentityInput, meta?: RpcMetadata) {
      try {
        // Дедлайн один и принадлежит транспорту: он же отменяет вызов и даёт
        // ConnectError с кодом. Рукописная гонка таймеров рядом отдавала голую
        // ошибку без кода и поток не отменяла.
        const response = await rpc.resolveIdentity(input, {
          timeoutMs: callTimeoutMs(meta, timeoutMs),
          ...callHeaders(meta),
        });
        return {
          kind: "resolved" as const,
          identityId: response.identityId,
          globalRoles: response.globalRoles.flatMap(
            (role) => roleName(role) ?? [],
          ),
          blocked: response.blocked,
        };
      } catch (cause) {
        return classifyFailure(cause);
      }
    },
  };
}

export function createTelegramRecipientResolver(
  rpc: TelegramRecipientRpc,
  timeoutMs = identityRpcTimeoutMs,
): TelegramRecipientResolver {
  return {
    async resolveTelegramUserId(identityId, meta) {
      try {
        const response = await rpc.resolveTelegramUserId(
          { identityId },
          { timeoutMs: callTimeoutMs(meta, timeoutMs), ...callHeaders(meta) },
        );
        return { kind: "resolved", telegramUserId: response.telegramUserId };
      } catch (cause) {
        return classifyRecipientFailure(cause);
      }
    },
  };
}

export function createOrganizerResolver(
  rpc: OrganizerRpc,
  timeoutMs = identityRpcTimeoutMs,
): OrganizerResolver {
  return {
    async resolveOrganizerUsername(viewer, identityId, meta) {
      try {
        const response = await rpc.resolveOrganizerUsername(
          {
            actor: {
              identityId: viewer.identityId,
              globalRoles: viewer.globalRoles.map(roleValue),
            },
            identityId,
          },
          { timeoutMs: callTimeoutMs(meta, timeoutMs), ...callHeaders(meta) },
        );
        return response.telegramUsername === undefined
          ? { kind: "resolved" }
          : { kind: "resolved", telegramUsername: response.telegramUsername };
      } catch (cause) {
        return classifyOrganizerFailure(cause);
      }
    },
  };
}

function classifyOrganizerFailure(cause: unknown): OrganizerUsernameResult {
  if (cause instanceof ConnectError) {
    if (cause.code === Code.NotFound) return { kind: "not-found" };
    if (permanentCodes.has(cause.code)) {
      return { kind: "rejected", code: Code[cause.code], cause };
    }
  }
  return { kind: "unavailable", cause };
}

// NOT_FOUND и FAILED_PRECONDITION контракт отдал двум окончательным исходам
// (contracts/proto/identity/v1/identity_service.proto); остальные постоянные
// коды — рассинхрон схемы, а не свойство получателя.
function classifyRecipientFailure(cause: unknown): TelegramRecipientResult {
  if (cause instanceof ConnectError) {
    if (cause.code === Code.NotFound) return { kind: "not-found" };
    if (cause.code === Code.FailedPrecondition) return { kind: "blocked" };
    if (permanentCodes.has(cause.code)) {
      return { kind: "rejected", code: Code[cause.code], cause };
    }
  }
  return { kind: "unavailable", cause };
}

// Отказ, который не пройдёт и со второй попытки: нарушение контракта, рассинхрон
// схемы, отсутствующий метод. Всё остальное — недоступность зависимости, где
// повтор осмыслен.
const permanentCodes: ReadonlySet<Code> = new Set([
  Code.InvalidArgument,
  Code.NotFound,
  Code.AlreadyExists,
  Code.PermissionDenied,
  Code.Unauthenticated,
  Code.FailedPrecondition,
  Code.OutOfRange,
  Code.Unimplemented,
]);

function classifyFailure(cause: unknown): ResolveIdentityResult {
  if (cause instanceof ConnectError && permanentCodes.has(cause.code)) {
    return { kind: "rejected", code: Code[cause.code], cause };
  }
  return { kind: "unavailable", cause };
}

function roleName(role: GlobalRole): string | undefined {
  switch (role) {
    case GlobalRole.MAINTAINER:
      return "maintainer";
    case GlobalRole.ADMIN:
      return "admin";
    case GlobalRole.MEMBER:
      return "member";
    case GlobalRole.PUBLIC:
      return "public";
    case GlobalRole.UNSPECIFIED:
      return "unspecified";
    default:
      // Новое значение словаря обязано получить имя: параметр типа never не
      // соберётся. Число, которого словарь ещё не знает, игнорируется.
      return ignoreUnknownRole(role);
  }
}

function ignoreUnknownRole(_role: never): undefined {
  return undefined;
}
