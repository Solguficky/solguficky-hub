import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  Circle as WireCircle,
  ApplicationQueue as WireQueue,
  AccessRight as WireRight,
} from "../../../../gen/identity/v1/access_pb.js";
import {
  ApplicationOutcome,
  type DecideApplicationResponse,
  IdentityService,
  AccessRequestOutcome as WireAccessRequestOutcome,
  type ApplicationCard as WireApplicationCard,
  CommunityFilter as WireCommunityFilter,
  type CommunityMember as WireCommunityMember,
  type RefusedApplication as WireRefusedApplication,
} from "../../../../gen/identity/v1/identity_service_pb.js";
import { classifyRecipientFailure as classifyDeliveryRecipientFailure } from "../../../core/delivery/index.js";
import { rightsOf, wireQueue } from "../../../core/identity/access.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
  type RpcMetadata,
} from "../../../core/rpc-metadata.js";
import { type RpcClientOptions, traceRpc } from "../../../core/tracing.js";
import { communityLocalTime } from "../community-time.js";
import type {
  AccessRequester,
  Administrator,
  AdministratorManager,
  ApplicationAdministrator,
  ApplicationCard,
  ApplicationDecision,
  ApplicationModerator,
  CommunityAdministrator,
  CommunityFilter,
  CommunityMember,
  IdentityFailure,
  IdentityResolver,
  OrganizerResolver,
  OrganizerUsernameResult,
  ApplicationOutcome as Outcome,
  ReconsiderResult,
  RecordRight,
  RefusedApplication,
  RequestAccessInput,
  RequestAccessResult,
  ResolveIdentityInput,
  RightRecordAdministrator,
  SourceChannelAdministrator,
  TelegramRecipientResolver,
  TelegramRecipientResult,
} from "./port.js";

export const identityRpcTimeoutMs = 3_000;

export { requestIdHeader, useCaseHeader } from "../../../core/rpc-metadata.js";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: рукописная
// копия форм запроса, ответа и CallOptions расходится с contracts/proto молча,
// а Pick по сгенерированному Client роняет typecheck на первом же расхождении.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  "resolveIdentity"
>;
export type AccessRequestRpc = Pick<
  Client<typeof IdentityService>,
  "requestAccess"
>;
export type TelegramRecipientRpc = Pick<
  Client<typeof IdentityService>,
  "resolveTelegramUserId"
>;
export type AccessRightRpc = Pick<
  Client<typeof IdentityService>,
  "checkAccessRight"
>;
export type OrganizerRpc = Pick<
  Client<typeof IdentityService>,
  "resolveOrganizerUsername"
>;
type IdentityAdminRpc = Pick<
  Client<typeof IdentityService>,
  | "listCommunityMembers"
  | "getCommunityMember"
  | "blockCommunityMember"
  | "listAllowedUsernames"
  | "addAllowedUsername"
  | "removeAllowedUsername"
>;
type ApplicationAdminRpc = Pick<
  Client<typeof IdentityService>,
  "listRefusedApplications" | "reconsiderApplication"
>;
type SourceChannelAdminRpc = Pick<
  Client<typeof IdentityService>,
  "listSourceChannels" | "createSourceChannel"
>;
type RightRecordRpc = Pick<
  Client<typeof IdentityService>,
  "grantRight" | "revokeRight"
>;
type AdministratorRpc = Pick<
  Client<typeof IdentityService>,
  "listAdministrators" | "appointAdministrator" | "dismissAdministrator"
>;
type ApplicationModeratorRpc = Pick<
  Client<typeof IdentityService>,
  "readApplicationQueue" | "admitApplication" | "declineApplication"
>;

export type IdentityClient = IdentityResolver &
  AccessRequester &
  TelegramRecipientResolver &
  OrganizerResolver &
  CommunityAdministrator &
  ApplicationAdministrator &
  SourceChannelAdministrator &
  ApplicationModerator &
  RightRecordAdministrator &
  AdministratorManager & {
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
): IdentityClient & PlaceBidsReader {
  const sessionManager = new Http2SessionManager(baseUrl);
  const transport = createGrpcTransport({
    baseUrl,
    defaultTimeoutMs: timeoutMs,
    sessionManager,
    interceptors: [presentServiceToken(serviceToken), traceRpc(tracing)],
  });
  const client = createClient(IdentityService, transport);
  const resolver = createIdentityResolver(client, timeoutMs);
  const requester = createAccessRequester(client, timeoutMs);
  const administrator = createCommunityAdministrator(client, timeoutMs);
  const applications = createApplicationAdministrator(client, {
    timeoutMs,
    communityTimeZone,
  });
  const sourceChannels = createSourceChannelAdministrator(client, timeoutMs);
  const moderator = createApplicationModerator(client, timeoutMs);
  const records = createRightRecordAdministrator(client, timeoutMs);
  const administrators = createAdministratorManager(client, timeoutMs);
  const recipients = createTelegramRecipientResolver(client, timeoutMs);
  const organizers = createOrganizerResolver(client, timeoutMs);
  return {
    resolve: (input, meta) => resolver.resolve(input, meta),
    requestAccess: (input, meta) => requester.requestAccess(input, meta),
    resolveTelegramUserId: (identityId, meta) =>
      recipients.resolveTelegramUserId(identityId, meta),
    resolveOrganizerUsername: (viewer, identityId, meta) =>
      organizers.resolveOrganizerUsername(viewer, identityId, meta),
    ...createPlaceBidsReader(client, timeoutMs),
    ...administrator,
    ...applications,
    ...sourceChannels,
    ...moderator,
    ...records,
    ...administrators,
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
  const actorMessage = (actor: { identityId: string }) => ({
    identityId: actor.identityId,
  });
  const change = async (call: () => Promise<{ changed: boolean }>) => {
    try {
      return { kind: "ok" as const, value: (await call()).changed };
    } catch (cause) {
      return classifyAdminFailure(cause);
    }
  };
  return {
    async community(actor, filter, meta) {
      try {
        const wireActor = actorMessage(actor);
        const [members, usernames] = await Promise.all([
          rpc.listCommunityMembers(
            { actor: wireActor, ...wireFilter[filter] },
            options(meta),
          ),
          rpc.listAllowedUsernames({ actor: wireActor }, options(meta)),
        ]);
        return {
          kind: "ok",
          value: {
            members: members.members.map(communityMemberOf),
            allowedUsernames: usernames.usernames,
          },
        };
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
    },
    async communityMember(actor, identityId, meta) {
      let response: Awaited<ReturnType<IdentityAdminRpc["getCommunityMember"]>>;
      try {
        response = await rpc.getCommunityMember(
          { actor: actorMessage(actor), identityId },
          options(meta),
        );
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
      const outcome = response.outcome;
      if (outcome.case === "found") {
        return { kind: "ok", value: communityMemberOf(outcome.value) };
      }
      const unknown = {
        kind: "unavailable" as const,
        cause: new Error(
          "GetCommunityMember answered an outcome the bot does not know",
        ),
      };
      if (outcome.case !== "refused") return unknown;
      switch (outcome.value.reason.case) {
        case "notMembersManager":
          return { kind: "forbidden" };
        case "identityUnknown":
          return { kind: "identity-unknown" };
        case "identityBlocked":
          return { kind: "blocked" };
        case "identityHoldsPreset":
          return { kind: "holds-preset" };
        default:
          return unknown;
      }
    },
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

// Модераторы — держатели записи `ADMIT_BIDDERS`: фильтр по выданному праву,
// а не по кругу (PER-651).
const wireFilter: Readonly<
  Record<
    CommunityFilter,
    { filter?: WireCommunityFilter; grantedRight?: WireRight }
  >
> = {
  members: { filter: WireCommunityFilter.MEMBERS },
  guests: { filter: WireCommunityFilter.GUESTS },
  moderators: { grantedRight: WireRight.ADMIT_BIDDERS },
};

// Старый Identity круга не присылает: участника тогда называет `admitted`, а
// гостя от человека без круга он не отличает.
function communityMemberOf(member: WireCommunityMember): CommunityMember {
  return {
    identityId: member.identityId,
    ...(member.telegramUsername === undefined
      ? {}
      : { telegramUsername: member.telegramUsername }),
    // Настоящий Telegram id всегда положителен, ноль — поле не пришло.
    ...(member.telegramUserId > 0n
      ? { telegramUserId: member.telegramUserId }
      : {}),
    circle:
      member.circle === WireCircle.MEMBER || member.admitted
        ? "member"
        : member.circle === WireCircle.GUEST
          ? "guest"
          : "none",
    auctionModeration: member.grantedRights.includes(WireRight.ADMIT_BIDDERS),
    auctionRunning: member.grantedRights.includes(WireRight.RUN_AUCTIONS),
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
  const actorMessage = (actor: { identityId: string }) => ({
    identityId: actor.identityId,
  });
  return {
    async refusedApplications(actor, queue, meta) {
      let response: Awaited<
        ReturnType<ApplicationAdminRpc["listRefusedApplications"]>
      >;
      try {
        response = await rpc.listRefusedApplications(
          { actor: actorMessage(actor), queue: wireQueue(queue) },
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

// Записи прав, которые выдаёт держатель права управлять составом: модерация
// аукциона (ADR-064, пункт 7) и ведение аукциона (ADR-070, п. 1) — общими
// GrantRight и RevokeRight (PER-651). FAILED_PRECONDITION у выдачи — штатный
// ответ: человек не участник или заблокирован.
const recordWire: Readonly<Record<RecordRight, WireRight>> = {
  "admit-bidders": WireRight.ADMIT_BIDDERS,
  "run-auctions": WireRight.RUN_AUCTIONS,
};

export function createRightRecordAdministrator(
  rpc: RightRecordRpc,
  timeoutMs = identityRpcTimeoutMs,
): RightRecordAdministrator {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  const actorMessage = (actor: { identityId: string }) => ({
    identityId: actor.identityId,
  });
  return {
    async grantRightRecord(actor, identityId, right, meta) {
      try {
        const response = await rpc.grantRight(
          { actor: actorMessage(actor), identityId, right: recordWire[right] },
          options(meta),
        );
        return { kind: "ok", value: response.changed };
      } catch (cause) {
        if (
          cause instanceof ConnectError &&
          cause.code === Code.FailedPrecondition
        ) {
          return { kind: "not-member" };
        }
        return classifyAdminFailure(cause);
      }
    },
    async revokeRightRecord(actor, identityId, right, meta) {
      try {
        const response = await rpc.revokeRight(
          { actor: actorMessage(actor), identityId, right: recordWire[right] },
          options(meta),
        );
        return { kind: "ok", value: response.changed };
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
    },
  };
}

// Назначение и снятие набора admin (ADR-065, пункты 6 и 7). Отказы Identity
// отдаёт значением ответа (PER-521), и каждый переводится в свой вид. Пустой
// `oneof` и незнакомая причина — ответ, которого бот не понимает: это не
// отказ по делу, а рассинхрон с Identity, поэтому — недоступность с причиной.
export function createAdministratorManager(
  rpc: AdministratorRpc,
  timeoutMs = identityRpcTimeoutMs,
): AdministratorManager {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  const actorMessage = (actor: { identityId: string }) => ({
    identityId: actor.identityId,
  });
  const unknownAnswer = (method: string) => ({
    kind: "unavailable" as const,
    cause: new Error(`${method} answered an outcome the bot does not know`),
  });
  return {
    async administrators(actor, meta) {
      let response: Awaited<ReturnType<AdministratorRpc["listAdministrators"]>>;
      try {
        response = await rpc.listAdministrators(
          { actor: actorMessage(actor) },
          options(meta),
        );
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
      const outcome = response.outcome;
      if (outcome.case === "refused") {
        return outcome.value.reason.case === "notAdminGrantor"
          ? { kind: "forbidden" }
          : unknownAnswer("ListAdministrators");
      }
      if (outcome.case !== "listed") return unknownAnswer("ListAdministrators");
      const administrators: Administrator[] = outcome.value.administrators.map(
        (administrator) => ({
          identityId: administrator.identityId,
          telegramUserId: administrator.telegramUserId,
          ...(administrator.telegramUsername === undefined
            ? {}
            : { telegramUsername: administrator.telegramUsername }),
          maintainer: administrator.maintainer,
          admin: administrator.admin,
        }),
      );
      return { kind: "ok", value: administrators };
    },
    async appointAdministrator(actor, telegramUsername, meta) {
      let response: Awaited<
        ReturnType<AdministratorRpc["appointAdministrator"]>
      >;
      try {
        response = await rpc.appointAdministrator(
          { actor: actorMessage(actor), telegramUsername },
          options(meta),
        );
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
      const outcome = response.outcome;
      if (outcome.case === "appointed") {
        return {
          kind: "ok",
          value: {
            identityId: outcome.value.identityId,
            changed: outcome.value.changed,
          },
        };
      }
      if (outcome.case !== "refused") {
        return unknownAnswer("AppointAdministrator");
      }
      switch (outcome.value.reason.case) {
        case "notAdminGrantor":
          return { kind: "forbidden" };
        case "usernameUnknown":
          return { kind: "username-unknown" };
        case "identityNotMember":
          return { kind: "not-member" };
        case "identityBlocked":
          return { kind: "blocked" };
        case "usernameUnresolved":
          return { kind: "username-unresolved" };
        default:
          return unknownAnswer("AppointAdministrator");
      }
    },
    async dismissAdministrator(actor, identityId, meta) {
      let response: Awaited<
        ReturnType<AdministratorRpc["dismissAdministrator"]>
      >;
      try {
        response = await rpc.dismissAdministrator(
          { actor: actorMessage(actor), identityId },
          options(meta),
        );
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
      const outcome = response.outcome;
      if (outcome.case === "dismissed") {
        return { kind: "ok", value: outcome.value.changed };
      }
      if (outcome.case !== "refused") {
        return unknownAnswer("DismissAdministrator");
      }
      switch (outcome.value.reason.case) {
        case "notAdminGrantor":
          return { kind: "forbidden" };
        case "identityUnknown":
          return { kind: "identity-unknown" };
        default:
          return unknownAnswer("DismissAdministrator");
      }
    },
  };
}

// Реестр каналов прихода (ADR-060, пункт 18). Переименования на экране нет:
// задача PER-441 его не заказывала, и RenameSourceChannel бот не зовёт.
export function createSourceChannelAdministrator(
  rpc: SourceChannelAdminRpc,
  timeoutMs = identityRpcTimeoutMs,
): SourceChannelAdministrator {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  const actorMessage = (actor: { identityId: string }) => ({
    identityId: actor.identityId,
  });
  return {
    async sourceChannels(actor, meta) {
      try {
        const response = await rpc.listSourceChannels(
          { actor: actorMessage(actor) },
          options(meta),
        );
        return {
          kind: "ok",
          value: response.channels.map(({ code, label }) => ({ code, label })),
        };
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
    },
    async createSourceChannel(actor, channel, meta) {
      try {
        const response = await rpc.createSourceChannel(
          { actor: actorMessage(actor), ...channel },
          options(meta),
        );
        return { kind: "ok", value: response.changed };
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
    },
  };
}

function refusedOf(
  value: WireRefusedApplication,
  communityTimeZone: string,
): RefusedApplication | undefined {
  const circle = circleOf(value.queue);
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

// Карточка заявки и решение по ней (ADR-060, пункты 9 и 21). Курсор едет в
// Identity строкой RFC 3339, собранной из миллисекунд: Identity сравнивает его
// как момент, а момент создания хранит ровно с этой точностью.
export function createApplicationModerator(
  rpc: ApplicationModeratorRpc,
  timeoutMs = identityRpcTimeoutMs,
): ApplicationModerator {
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  const actorMessage = (actor: { identityId: string }) => ({
    identityId: actor.identityId,
  });
  const decide = async (
    call: () => Promise<DecideApplicationResponse>,
  ): Promise<
    | { kind: "ok"; value: ApplicationDecision }
    | ReturnType<typeof classifyAdminFailure>
  > => {
    let response: DecideApplicationResponse;
    try {
      response = await call();
    } catch (cause) {
      return classifyAdminFailure(cause);
    }
    const decision = decisionOf(response);
    return decision === undefined
      ? { kind: "invalid" }
      : { kind: "ok", value: decision };
  };
  return {
    async readApplicationQueue(actor, queue, after, meta) {
      let response: Awaited<
        ReturnType<ApplicationModeratorRpc["readApplicationQueue"]>
      >;
      try {
        response = await rpc.readApplicationQueue(
          {
            actor: actorMessage(actor),
            queue: wireQueue(queue),
            ...(after === undefined
              ? {}
              : {
                  after: {
                    createdAt: new Date(after.createdAtMs).toISOString(),
                    applicationId: after.applicationId,
                  },
                }),
          },
          options(meta),
        );
      } catch (cause) {
        return classifyAdminFailure(cause);
      }
      if (response.application === undefined) {
        return { kind: "ok", value: { total: response.total } };
      }
      const application = cardOf(response.application);
      // Карточка вне контракта — рассинхрон схемы: показать её без круга или
      // момента значило бы решать заявку вслепую.
      if (application === undefined) return { kind: "invalid" };
      return {
        kind: "ok",
        value: {
          card: { application, position: response.position },
          total: response.total,
        },
      };
    },
    admitApplication: (actor, applicationId, meta) =>
      decide(() =>
        rpc.admitApplication(
          { actor: actorMessage(actor), applicationId },
          options(meta),
        ),
      ),
    declineApplication: (actor, applicationId, meta) =>
      decide(() =>
        rpc.declineApplication(
          { actor: actorMessage(actor), applicationId },
          options(meta),
        ),
      ),
  };
}

// Круг, который выдаст заявка, — по её очереди: сообщество выдаёт участника,
// аукцион — гостя. Незнакомая очередь карточку не даёт.
function circleOf(queue: WireQueue): "member" | "public" | undefined {
  return queue === WireQueue.COMMUNITY
    ? "member"
    : queue === WireQueue.AUCTION
      ? "public"
      : undefined;
}

function cardOf(value: WireApplicationCard): ApplicationCard | undefined {
  const circle = circleOf(value.queue);
  const createdAtMs = Date.parse(value.createdAt);
  if (circle === undefined || Number.isNaN(createdAtMs)) return undefined;
  const label = value.source?.channelLabel;
  return {
    applicationId: value.applicationId,
    identityId: value.identityId,
    telegramUserId: value.telegramUserId,
    ...(value.telegramUsername === undefined
      ? {}
      : { telegramUsername: value.telegramUsername }),
    ...(value.firstName === undefined ? {} : { firstName: value.firstName }),
    circle,
    source:
      value.source === undefined
        ? { kind: "none" }
        : label === undefined
          ? { kind: "unknown" }
          : { kind: "channel", label },
    createdAtMs,
  };
}

const outcomeNames: ReadonlyMap<ApplicationOutcome, Outcome> = new Map([
  [ApplicationOutcome.ADMITTED, "admitted"],
  [ApplicationOutcome.DECLINED, "declined"],
  [ApplicationOutcome.BLOCKED, "blocked"],
  [ApplicationOutcome.CLOSED_BY_GRANT, "closed-by-grant"],
  [ApplicationOutcome.CLOSED_BY_BLOCK, "closed-by-block"],
]);

function decisionOf(
  response: DecideApplicationResponse,
): ApplicationDecision | undefined {
  const { result } = response;
  if (result.case === undefined) return undefined;
  const outcome = outcomeNames.get(result.value.outcome);
  if (outcome === undefined) return undefined;
  const decider = result.value.decidedBy;
  return {
    already: result.case === "alreadyDecided",
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
          rights: rightsOf(response.rights),
          blocked: response.blocked,
        };
      } catch (cause) {
        return classifyFailure(cause);
      }
    },
  };
}

export function createAccessRequester(
  rpc: AccessRequestRpc,
  timeoutMs = identityRpcTimeoutMs,
): AccessRequester {
  return {
    async requestAccess(
      input: RequestAccessInput,
      meta?: RpcMetadata,
    ): Promise<RequestAccessResult> {
      try {
        const response = await rpc.requestAccess(
          {
            telegramUserId: input.telegramUserId,
            ...(input.telegramUsername === undefined
              ? {}
              : { telegramUsername: input.telegramUsername }),
            queue: wireQueue(input.queue),
            // Присутствие кода значимо: пустой код после `s_` — «неизвестный
            // источник», а не его отсутствие.
            ...(input.sourceCode === undefined
              ? {}
              : { sourceCode: input.sourceCode }),
            firstName: input.firstName,
          },
          { timeoutMs: callTimeoutMs(meta, timeoutMs), ...callHeaders(meta) },
        );
        return {
          kind: "answered",
          identityId: response.identityId,
          rights: rightsOf(response.rights),
          outcome: accessRequestOutcome(response.outcome),
        };
      } catch (cause) {
        return classifyFailure(cause);
      }
    },
  };
}

// Число, которого словарь ещё не знает, читается как `UNSPECIFIED`: по
// контракту незнакомый исход — отказ, а не допуск.
function accessRequestOutcome(
  outcome: WireAccessRequestOutcome,
): Extract<RequestAccessResult, { kind: "answered" }>["outcome"] {
  switch (outcome) {
    case WireAccessRequestOutcome.ALREADY_HELD:
      return "already-held";
    case WireAccessRequestOutcome.GRANTED_BY_ALLOWLIST:
      return "granted-by-allowlist";
    case WireAccessRequestOutcome.PENDING:
      return "pending";
    case WireAccessRequestOutcome.DECLINED:
      return "declined";
    case WireAccessRequestOutcome.BLOCKED:
      return "blocked";
    default:
      return "unspecified";
  }
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

// Право `place-bids` получателя аукционного уведомления (PER-598): Auction отдаёт
// лот только зрителю с этим правом, а канал видит получателя одним
// `identity_id`. Недоступность Identity — исключение: повтор решает рендер.
export type PlaceBidsReader = {
  holdsPlaceBids(identityId: string, meta?: RpcMetadata): Promise<boolean>;
};

export function createPlaceBidsReader(
  rpc: AccessRightRpc,
  timeoutMs = identityRpcTimeoutMs,
): PlaceBidsReader {
  return {
    async holdsPlaceBids(identityId, meta) {
      const response = await rpc.checkAccessRight(
        { identityId, right: WireRight.PLACE_BIDS },
        { timeoutMs: callTimeoutMs(meta, timeoutMs), ...callHeaders(meta) },
      );
      return response.granted;
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
            actor: { identityId: viewer.identityId },
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
// Классы отказа получателя общие у двух каналов доставки и живут в пакете.
function classifyRecipientFailure(cause: unknown): TelegramRecipientResult {
  return classifyDeliveryRecipientFailure(cause);
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

function classifyFailure(cause: unknown): IdentityFailure {
  if (cause instanceof ConnectError && permanentCodes.has(cause.code)) {
    return { kind: "rejected", code: Code[cause.code], cause };
  }
  return { kind: "unavailable", cause };
}
