import type { Client, Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type {
  GlobalRole,
  ResolvedIdentity,
  TelegramUser,
  Viewer,
} from "@solguficky/auction-bot-ui";
import { AuctionService } from "../gen/auction/v1/auction_service_pb.js";
import { IdentityService } from "../gen/identity/v1/identity_service_pb.js";
import { GlobalRole as WireRole } from "../gen/identity/v1/roles_pb.js";
import type { EntryPorts } from "./entry-ports.js";

export const rpcTimeoutMs = 3_000;
export const requestIdHeader = "x-request-id";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: Pick по
// сгенерированному Client роняет typecheck на первом расхождении с contracts/proto.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  "resolveIdentity"
>;
export type AuctionRpc = Pick<
  Client<typeof AuctionService>,
  "getLot" | "getFaqAcknowledgement" | "acknowledgeFaq"
>;

// Порты пакета метаданных вызова не несут, поэтому они собираются на каждый
// update: `request_id` края уезжает заголовком в каждый вызов цепочки.
export type PortsFactory = (requestId: string) => EntryPorts;

export function createPorts(
  identity: IdentityRpc,
  auction: AuctionRpc,
  timeoutMs = rpcTimeoutMs,
): PortsFactory {
  return (requestId) => {
    const options = { timeoutMs, headers: { [requestIdHeader]: requestId } };
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
            options,
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
      auction: {
        async getLot(request: { viewer: Viewer; lotId: string }) {
          const snapshot = await auction.getLot(
            {
              viewer: {
                identityId: request.viewer.identityId,
                globalRoles: request.viewer.globalRoles.map(roleValue),
              },
              lotId: request.lotId,
            },
            options,
          );
          return {
            lotId: snapshot.id,
            auctionId: snapshot.auctionId,
            version: Number(snapshot.version),
          };
        },
      },
      faq: {
        async acknowledged(viewer) {
          const response = await auction.getFaqAcknowledgement(
            {
              viewer: {
                identityId: viewer.identityId,
                globalRoles: viewer.globalRoles.map(roleValue),
              },
            },
            options,
          );
          return response.acknowledged;
        },
        async acknowledge(viewer) {
          const response = await auction.acknowledgeFaq(
            {
              viewer: {
                identityId: viewer.identityId,
                globalRoles: viewer.globalRoles.map(roleValue),
              },
            },
            options,
          );
          if (!response.acknowledged)
            throw new Error("Auction did not acknowledge FAQ completion");
        },
      },
    };
  };
}

export type Clients = {
  ports: PortsFactory;
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
    ports: createPorts(identity, auction),
    close() {
      identitySession.abort();
      auctionSession.abort();
    },
  };
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
