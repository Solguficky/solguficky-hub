import type { Client, Interceptor } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type {
  GlobalRole,
  LotImagePort,
  ResolvedIdentity,
  RoleRequest,
  RoleRequestAnswer,
  RoleRequestOutcome,
  SurfaceCircle,
  TelegramUser,
  Viewer,
} from "@solguficky/auction-bot-ui";
import {
  classifyRecipientFailure,
  type TelegramRecipientResolver,
} from "@solguficky/telegram-delivery";
import { AuctionService } from "../gen/auction/v1/auction_service_pb.js";
import {
  IdentityService,
  RoleRequestOutcome as WireOutcome,
} from "../gen/identity/v1/identity_service_pb.js";
import { GlobalRole as WireRole } from "../gen/identity/v1/roles_pb.js";
import type { NotificationReads } from "./delivery/message.js";
import type { EntryPorts } from "./entry-ports.js";
import { historyPageOf } from "./history.js";
import { lotViewOf } from "./snapshot.js";

export const rpcTimeoutMs = 3_000;
// Байты изображения — до нескольких мегабайт, им нужно больше времени, чем
// снимку. Отказ здесь стоит карточке фото, а не экрана. Бюджет действия
// режет и его: `GetLotImage` делит 5 секунд с личностью и чтением лота
// (дизайн-код, «Показ фото лота»).
export const imageTimeoutMs = 10_000;
export const requestIdHeader = "x-request-id";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: Pick по
// сгенерированному Client роняет typecheck на первом расхождении с contracts/proto.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  | "resolveIdentity"
  | "requestRole"
  | "resolveTelegramUserId"
  | "checkGlobalRole"
>;
export type AuctionRpc = Pick<
  Client<typeof AuctionService>,
  | "getLot"
  | "listAuctionLots"
  | "listLotHistory"
  | "getDisplayNames"
  | "getLotImage"
  | "getFaqAcknowledgement"
  | "acknowledgeFaq"
>;

// Порты пакета метаданных вызова не несут, поэтому они собираются на каждый
// update: `request_id` края уезжает заголовком в каждый вызов цепочки, а
// `deadlineAt` — общий бюджет действия — режет дедлайн каждого вызова.
//
// Порт изображения пакет не зовёт: байты нужны только Telegram-краю бота.
export type PortsFactory = (
  requestId: string,
  deadlineAt?: number,
) => EntryPorts & { image: LotImagePort };

/**
 * Дедлайн одного вызова: меньшее из его собственного и остатка бюджета
 * действия. Бюджет исчерпан — вызов не делается вовсе, а отказ тот же, что даёт
 * истёкший дедлайн транспорта: маршрут разбирает его уже существующей ветвью.
 */
export function callTimeoutMs(
  deadlineAt: number | undefined,
  ownMs: number,
  now: number = Date.now(),
): number {
  if (deadlineAt === undefined) return ownMs;
  const left = deadlineAt - now;
  if (left <= 0) {
    throw new ConnectError(
      "the action budget is exhausted",
      Code.DeadlineExceeded,
    );
  }
  return Math.min(ownMs, left);
}

export type PortsOptions = {
  timeoutMs?: number;
  // Отказ `GetDisplayNames` пакет гасит: карточка остаётся без имени. Чтобы
  // деградация не была молчаливой, порт сообщает о ней до того, как бросить.
  onNamesRefused?: (cause: unknown, requestId: string) => void;
};

export function createPorts(
  identity: IdentityRpc,
  auction: AuctionRpc,
  { timeoutMs = rpcTimeoutMs, onNamesRefused }: PortsOptions = {},
): PortsFactory {
  return (requestId, deadlineAt) => {
    const headers = { [requestIdHeader]: requestId };
    // Остаток бюджета считается в момент вызова, а не при сборке портов.
    const callOptions = (ownMs: number) => ({
      timeoutMs: callTimeoutMs(deadlineAt, ownMs),
      headers,
    });
    return {
      identity: {
        async resolveIdentity(user: TelegramUser): Promise<ResolvedIdentity> {
          const response = await identity.resolveIdentity(
            {
              telegramUserId: BigInt(user.telegramUserId),
              ...(user.telegramUsername === undefined
                ? {}
                : { telegramUsername: user.telegramUsername }),
            },
            callOptions(timeoutMs),
          );
          return {
            identityId: response.identityId,
            globalRoles: response.globalRoles.flatMap(
              (role) => roleName(role) ?? [],
            ),
            blocked: response.blocked,
          };
        },
      },
      entry: {
        async requestRole(request: RoleRequest): Promise<RoleRequestAnswer> {
          const response = await identity.requestRole(
            {
              telegramUserId: BigInt(request.user.telegramUserId),
              ...(request.user.telegramUsername === undefined
                ? {}
                : { telegramUsername: request.user.telegramUsername }),
              requestedRole: wireCircle(request.requestedRole),
              // Присутствие кода значимо: пустой код после `s_` — «неизвестный
              // источник», а не его отсутствие.
              ...(request.sourceCode === undefined
                ? {}
                : { sourceCode: request.sourceCode }),
              firstName: request.firstName,
            },
            callOptions(timeoutMs),
          );
          return {
            identityId: response.identityId,
            globalRoles: response.globalRoles.flatMap(
              (role) => roleName(role) ?? [],
            ),
            outcome: outcomeName(response.outcome),
          };
        },
      },
      auction: {
        async getLot(request: { viewer: Viewer; lotId: string }) {
          const snapshot = await auction.getLot(
            { viewer: viewerOf(request.viewer), lotId: request.lotId },
            callOptions(timeoutMs),
          );
          return lotViewOf(snapshot);
        },
        async listAuctionLots(request) {
          const page = await auction.listAuctionLots(
            {
              viewer: viewerOf(request.viewer),
              auctionId: request.auctionId,
              pageToken: request.pageToken,
            },
            callOptions(timeoutMs),
          );
          return {
            lots: page.lots.map(lotViewOf),
            nextPageToken: page.nextPageToken,
          };
        },
        async listLotHistory(request) {
          const page = await auction.listLotHistory(
            {
              viewer: viewerOf(request.viewer),
              lotId: request.lotId,
              pageToken: request.pageToken,
            },
            callOptions(timeoutMs),
          );
          return historyPageOf(page);
        },
        async getDisplayNames(request) {
          try {
            const response = await auction.getDisplayNames(
              {
                viewer: viewerOf(request.viewer),
                auctionId: request.auctionId,
                participantIds: [...request.participantIds],
              },
              callOptions(timeoutMs),
            );
            return Object.fromEntries(
              Object.entries(response.names).map(([id, name]) => [
                id,
                name.text,
              ]),
            );
          } catch (cause) {
            onNamesRefused?.(cause, requestId);
            throw cause;
          }
        },
      },
      image: {
        async getLotImage(request) {
          const image = await auction.getLotImage(
            { viewer: viewerOf(request.viewer), lotId: request.lotId },
            callOptions(imageTimeoutMs),
          );
          return {
            content: image.content,
            mediaType: image.mediaType,
            version: image.version,
          };
        },
      },
      faq: {
        async acknowledged(viewer) {
          const response = await auction.getFaqAcknowledgement(
            { viewer: viewerOf(viewer) },
            callOptions(timeoutMs),
          );
          return response.acknowledged;
        },
        async acknowledge(viewer) {
          const response = await auction.acknowledgeFaq(
            { viewer: viewerOf(viewer) },
            callOptions(timeoutMs),
          );
          if (!response.acknowledged)
            throw new Error("Auction did not acknowledge FAQ completion");
        },
      },
    };
  };
}

// Канал доставки (PER-328): получатель уведомления, его роль `public` и
// название лота для текста. Личности из update здесь нет — только
// `identity_id` из факта, и `request_id` цепочки приходит из него же.
export type DeliveryPorts = {
  recipients: TelegramRecipientResolver;
  reads: NotificationReads;
};

export function createDeliveryPorts(
  identity: IdentityRpc,
  auction: AuctionRpc,
  timeoutMs = rpcTimeoutMs,
): DeliveryPorts {
  const options = (requestId: string | undefined) => ({
    timeoutMs,
    ...(requestId === undefined
      ? {}
      : { headers: { [requestIdHeader]: requestId } }),
  });
  return {
    recipients: {
      async resolveTelegramUserId(identityId, requestId) {
        try {
          const response = await identity.resolveTelegramUserId(
            { identityId },
            options(requestId),
          );
          return { kind: "resolved", telegramUserId: response.telegramUserId };
        } catch (cause) {
          return classifyRecipientFailure(cause);
        }
      },
    },
    reads: {
      async hasPublicRole(identityId, requestId) {
        const response = await identity.checkGlobalRole(
          { identityId, acceptedRoles: [WireRole.PUBLIC] },
          options(requestId),
        );
        return response.granted;
      },
      async lotTitle(identityId, lotId, requestId) {
        // Роль `public` у зрителя проверена шагом раньше: Auction без неё лот
        // не отдаёт, а выдумывать её зрителю канал не вправе.
        const snapshot = await auction.getLot(
          {
            viewer: { identityId, globalRoles: [WireRole.PUBLIC] },
            lotId,
          },
          options(requestId),
        );
        // Карточки у лота может не быть: тогда текст обходится без названия.
        return snapshot.card?.title ?? "";
      },
    },
  };
}

export type Clients = {
  ports: PortsFactory;
  delivery: DeliveryPorts;
  close(): void;
};

// Токен вызывающего (ADR-056) — свойство процесса, а не запроса, поэтому его
// ставит транспорт на каждый вызов: клиент без него не собирается.
function presentServiceToken(token: string): Interceptor {
  const value = `Bearer ${token}`;
  return (next) => (request) => {
    request.header.set("authorization", value);
    return next(request);
  };
}

export function createClients(options: {
  identityUrl: string;
  auctionUrl: string;
  serviceToken: string;
  onNamesRefused?: (cause: unknown, requestId: string) => void;
}): Clients {
  const identitySession = new Http2SessionManager(options.identityUrl);
  const auctionSession = new Http2SessionManager(options.auctionUrl);
  const interceptors = [presentServiceToken(options.serviceToken)];
  const identity = createClient(
    IdentityService,
    createGrpcTransport({
      baseUrl: options.identityUrl,
      sessionManager: identitySession,
      interceptors,
    }),
  );
  const auction = createClient(
    AuctionService,
    createGrpcTransport({
      baseUrl: options.auctionUrl,
      sessionManager: auctionSession,
      interceptors,
    }),
  );
  return {
    ports: createPorts(
      identity,
      auction,
      options.onNamesRefused === undefined
        ? {}
        : { onNamesRefused: options.onNamesRefused },
    ),
    delivery: createDeliveryPorts(identity, auction),
    close() {
      identitySession.abort();
      auctionSession.abort();
    },
  };
}

function wireCircle(circle: SurfaceCircle): WireRole {
  switch (circle) {
    case "member":
      return WireRole.MEMBER;
    case "public":
      return WireRole.PUBLIC;
    default: {
      const _exhaustive: never = circle;
      return _exhaustive;
    }
  }
}

// Число, которого словарь ещё не знает, читается как `UNSPECIFIED`: по
// контракту незнакомый исход — отказ, а не допуск.
function outcomeName(outcome: WireOutcome): RoleRequestOutcome {
  switch (outcome) {
    case WireOutcome.ALREADY_HELD:
      return "already-held";
    case WireOutcome.GRANTED_BY_ALLOWLIST:
      return "granted-by-allowlist";
    case WireOutcome.PENDING:
      return "pending";
    case WireOutcome.DECLINED:
      return "declined";
    case WireOutcome.BLOCKED:
      return "blocked";
    default:
      return "unspecified";
  }
}

function roleName(role: WireRole): GlobalRole | undefined {
  switch (role) {
    case WireRole.MAINTAINER:
      return "maintainer";
    case WireRole.ADMIN:
      return "admin";
    case WireRole.MEMBER:
      return "member";
    case WireRole.PUBLIC:
      return "public";
    case WireRole.UNSPECIFIED:
      return undefined;
    default:
      // Новое значение словаря обязано получить имя: параметр типа never не
      // соберётся. Число, которого словарь ещё не знает, игнорируется.
      return ignoreUnknownRole(role);
  }
}

function ignoreUnknownRole(_role: never): undefined {
  return undefined;
}

function roleValue(role: GlobalRole): WireRole {
  switch (role) {
    case "admin":
      return WireRole.ADMIN;
    case "maintainer":
      return WireRole.MAINTAINER;
    case "member":
      return WireRole.MEMBER;
    case "public":
      return WireRole.PUBLIC;
  }
}

function viewerOf(viewer: Viewer) {
  return {
    identityId: viewer.identityId,
    globalRoles: viewer.globalRoles.map(roleValue),
  };
}
