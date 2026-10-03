import type { Client, Interceptor } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type {
  GlobalRole,
  LotImagePort,
  ResolvedIdentity,
  TelegramUser,
  Viewer,
} from "@solguficky/auction-bot-ui";
import { AuctionService } from "../gen/auction/v1/auction_service_pb.js";
import { IdentityService } from "../gen/identity/v1/identity_service_pb.js";
import { GlobalRole as WireRole } from "../gen/identity/v1/roles_pb.js";
import type { EntryPorts } from "./entry-ports.js";
import { lotViewOf } from "./snapshot.js";

export const rpcTimeoutMs = 3_000;
// Байты изображения — до нескольких мегабайт, им нужно больше времени, чем
// снимку. Отказ здесь стоит карточке фото, а не экрана.
export const imageTimeoutMs = 10_000;
export const requestIdHeader = "x-request-id";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: Pick по
// сгенерированному Client роняет typecheck на первом расхождении с contracts/proto.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  "resolveIdentity"
>;
export type AuctionRpc = Pick<
  Client<typeof AuctionService>,
  | "getLot"
  | "listAuctionLots"
  | "getDisplayNames"
  | "getLotImage"
  | "getFaqAcknowledgement"
  | "acknowledgeFaq"
>;

// Порты пакета метаданных вызова не несут, поэтому они собираются на каждый
// update: `request_id` края уезжает заголовком в каждый вызов цепочки.
//
// Порт изображения пакет не зовёт: байты нужны только Telegram-краю бота.
export type PortsFactory = (
  requestId: string,
) => EntryPorts & { image: LotImagePort };

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
  return (requestId) => {
    const headers = { [requestIdHeader]: requestId };
    const options = { timeoutMs, headers };
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
            { viewer: viewerOf(request.viewer), lotId: request.lotId },
            options,
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
            options,
          );
          return {
            lots: page.lots.map(lotViewOf),
            nextPageToken: page.nextPageToken,
          };
        },
        async getDisplayNames(request) {
          try {
            const response = await auction.getDisplayNames(
              {
                viewer: viewerOf(request.viewer),
                auctionId: request.auctionId,
                participantIds: [...request.participantIds],
              },
              options,
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
            { timeoutMs: imageTimeoutMs, headers },
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
            options,
          );
          return response.acknowledged;
        },
        async acknowledge(viewer) {
          const response = await auction.acknowledgeFaq(
            { viewer: viewerOf(viewer) },
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

function viewerOf(viewer: Viewer) {
  return {
    identityId: viewer.identityId,
    globalRoles: viewer.globalRoles.map(roleValue),
  };
}
