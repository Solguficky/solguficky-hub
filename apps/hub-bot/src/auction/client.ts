import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type { Viewer } from "@solguficky/auction-bot-ui";
import { AuctionService } from "../../gen/auction/v1/auction_service_pb.js";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
  type RpcMetadata,
} from "../rpc-metadata.js";
import { type RpcClientOptions, traceRpc } from "../tracing.js";
import {
  type AuctionFailure,
  type AuctionScreenPorts,
  type AuctionScreens,
  type EnableAuctionResult,
  type MeetupAuctions,
  viewerOf,
} from "./port.js";
import { lotViewOf } from "./snapshot.js";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: Pick по
// сгенерированному Client роняет typecheck на первом расхождении с
// contracts/proto. Методы — ровно те, что бот хаба зовёт по колонке Caller в
// integration.md.
type AuctionRpc = Pick<
  Client<typeof AuctionService>,
  | "draftAuction"
  | "getMeetupAuction"
  | "getLot"
  | "listAuctionLots"
  | "getDisplayNames"
  | "getLotImage"
>;

export type AuctionClient = MeetupAuctions & AuctionScreens & { close(): void };

export type AuctionAdapterOptions = {
  timeoutMs?: number;
  // Отказ `GetDisplayNames` пакет гасит: карточка лота остаётся без имени.
  // Чтобы деградация не была молчаливой, порт сообщает о ней до того, как
  // бросить (бриф ботов, «Лента и карточка лота»).
  onNamesRefused?: (cause: unknown, meta: RpcMetadata | undefined) => void;
};

export function createAuctionClient(
  baseUrl: string,
  {
    tracing,
    serviceToken,
    timeoutMs = 3_000,
    onNamesRefused,
  }: RpcClientOptions & Pick<AuctionAdapterOptions, "onNamesRefused">,
): AuctionClient {
  const sessionManager = new Http2SessionManager(baseUrl);
  const rpc = createClient(
    AuctionService,
    createGrpcTransport({
      baseUrl,
      defaultTimeoutMs: timeoutMs,
      sessionManager,
      interceptors: [presentServiceToken(serviceToken), traceRpc(tracing)],
    }),
  );
  const client = createAuctionAdapter(rpc, {
    timeoutMs,
    ...(onNamesRefused === undefined ? {} : { onNamesRefused }),
  });
  return { ...client, close: () => sessionManager.abort() };
}

export function createAuctionAdapter(
  rpc: AuctionRpc,
  { timeoutMs = 3_000, onNamesRefused }: AuctionAdapterOptions = {},
): MeetupAuctions & AuctionScreens {
  // Дедлайн вызова — меньшее из своего и остатка бюджета действия: бюджет
  // один на Identity, чтение лота и изображение (дизайн-код, «Ожидание»).
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  return {
    async getMeetupAuction(person, meetupId, meta) {
      try {
        const response = await rpc.getMeetupAuction(
          { viewer: wireViewer(viewerOf(person)), meetupId },
          options(meta),
        );
        return response.auction === undefined
          ? { kind: "ok" }
          : { kind: "ok", auctionId: response.auction.id };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async enableAuction(person, meetupId, opId, meta) {
      try {
        const response = await rpc.draftAuction(
          { viewer: wireViewer(viewerOf(person)), meetupId, opId },
          options(meta),
        );
        return enableResult(response.outcome);
      } catch (cause) {
        return toFailure(cause);
      }
    },
    screenPorts(meta): AuctionScreenPorts {
      return {
        auction: {
          async getLot(request) {
            const snapshot = await rpc.getLot(
              { viewer: wireViewer(request.viewer), lotId: request.lotId },
              options(meta),
            );
            return lotViewOf(snapshot);
          },
          async listAuctionLots(request) {
            const page = await rpc.listAuctionLots(
              {
                viewer: wireViewer(request.viewer),
                auctionId: request.auctionId,
                pageToken: request.pageToken,
              },
              options(meta),
            );
            return {
              lots: page.lots.map(lotViewOf),
              nextPageToken: page.nextPageToken,
            };
          },
          async getDisplayNames(request) {
            try {
              const response = await rpc.getDisplayNames(
                {
                  viewer: wireViewer(request.viewer),
                  auctionId: request.auctionId,
                  participantIds: [...request.participantIds],
                },
                options(meta),
              );
              return Object.fromEntries(
                Object.entries(response.names).map(([id, name]) => [
                  id,
                  name.text,
                ]),
              );
            } catch (cause) {
              onNamesRefused?.(cause, meta);
              throw cause;
            }
          },
        },
        image: {
          async getLotImage(request) {
            const image = await rpc.getLotImage(
              { viewer: wireViewer(request.viewer), lotId: request.lotId },
              options(meta),
            );
            return {
              content: image.content,
              mediaType: image.mediaType,
              version: image.version,
            };
          },
        },
      };
    },
  };
}

function enableResult(
  outcome: Awaited<ReturnType<AuctionRpc["draftAuction"]>>["outcome"],
): EnableAuctionResult {
  switch (outcome.case) {
    case "accepted":
      return {
        kind: "enabled",
        auctionId: outcome.value.auctionId,
        alreadyExisted: outcome.value.alreadyExisted,
      };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case undefined:
          // Пустой `oneof` — дефект соседа, а не решение: экран отвечает как
          // на сбой, а причина уходит в запись границы.
          return {
            kind: "invalid",
            cause: new Error("draft auction refusal without a reason"),
          };
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return {
        kind: "invalid",
        cause: new Error("draft auction response without an outcome"),
      };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Статусы gRPC остаются для того, что не решение аукциона (integration.md,
// «Auction gRPC»): форма запроса, роль, недоступный Meetups за спиной Auction.
function toFailure(cause: unknown): AuctionFailure {
  if (cause instanceof ConnectError && cause.code === Code.DeadlineExceeded) {
    return { kind: "timeout", cause };
  }
  if (cause instanceof ConnectError && cause.code === Code.PermissionDenied) {
    return { kind: "forbidden" };
  }
  if (
    cause instanceof ConnectError &&
    (cause.code === Code.InvalidArgument ||
      cause.code === Code.FailedPrecondition)
  ) {
    return { kind: "invalid", cause };
  }
  return { kind: "unavailable", cause };
}

function wireViewer(viewer: Viewer) {
  return {
    identityId: viewer.identityId,
    globalRoles: viewer.globalRoles.map(wireRole),
  };
}

function wireRole(role: Viewer["globalRoles"][number]): GlobalRole {
  switch (role) {
    case "admin":
      return GlobalRole.ADMIN;
    case "maintainer":
      return GlobalRole.MAINTAINER;
    case "member":
      return GlobalRole.MEMBER;
    case "public":
      return GlobalRole.PUBLIC;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}
