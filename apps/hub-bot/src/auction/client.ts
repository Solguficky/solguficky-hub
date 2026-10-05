import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import type { Money, Viewer } from "@solguficky/auction-bot-ui";
import { AuctionService } from "../../gen/auction/v1/auction_service_pb.js";
import { GlobalRole } from "../../gen/identity/v1/roles_pb.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
  type RpcMetadata,
} from "../rpc-metadata.js";
import { type RpcClientOptions, traceRpc } from "../tracing.js";
import { createUuidV7 } from "../uuid-v7.js";
import {
  bidOutcomeOf,
  displayNameOutcomeOf,
  limitOutcomeOf,
  unansweredOn,
} from "./commands.js";
import { historyPageOf } from "./history.js";
import {
  type AddLotResult,
  type AuctionFailure,
  type AuctionScreenPorts,
  type AuctionScreens,
  type EnableAuctionResult,
  type LotAdministration,
  type LotCardResult,
  type MeetupAuctions,
  type ScheduleLotResult,
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
  | "createLotCard"
  | "editLotCard"
  | "addLot"
  | "scheduleLot"
  | "getLot"
  | "listAuctionLots"
  | "listLotHistory"
  | "getDisplayNames"
  | "placeBid"
  | "setProxyLimit"
  | "chooseDisplayName"
  | "getLotImage"
>;

export type AuctionClient = MeetupAuctions &
  AuctionScreens &
  LotAdministration & { close(): void };

export type AuctionAdapterOptions = {
  timeoutMs?: number;
  // Отказ `GetDisplayNames` пакет гасит: карточка лота остаётся без имени.
  // Чтобы деградация не была молчаливой, порт сообщает о ней до того, как
  // бросить (бриф ботов, «Лента и карточка лота»).
  onNamesRefused?: (cause: unknown, meta: RpcMetadata | undefined) => void;
  // Источник `op_id` команд участника; тесты подменяют его.
  newOperationId?: () => string;
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
  {
    timeoutMs = 3_000,
    onNamesRefused,
    newOperationId = createUuidV7,
  }: AuctionAdapterOptions = {},
): MeetupAuctions & AuctionScreens & LotAdministration {
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
    async createLotCard(person, card, meta) {
      try {
        const response = await rpc.createLotCard(
          { viewer: wireViewer(viewerOf(person)), ...card },
          options(meta),
        );
        return cardResult(response.outcome, false);
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async editLotCard(person, card, meta) {
      const { image, ...text } = card;
      try {
        const response = await rpc.editLotCard(
          {
            viewer: wireViewer(viewerOf(person)),
            ...text,
            ...(image === undefined
              ? {}
              : {
                  imageChange: {
                    case: "replaceImage",
                    value: { content: image },
                  },
                }),
          },
          options(meta),
        );
        return cardResult(response.outcome, image !== undefined);
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async addLot(person, lot, meta) {
      try {
        const response = await rpc.addLot(
          { viewer: wireViewer(viewerOf(person)), ...lot },
          options(meta),
        );
        return addLotResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async scheduleLot(person, terms, meta) {
      try {
        const response = await rpc.scheduleLot(
          {
            viewer: wireViewer(viewerOf(person)),
            auctionId: terms.auctionId,
            lotId: terms.lotId,
            opId: terms.opId,
            startingPrice: wireMoney(terms.startingPrice),
            stepPolicy: {
              policy: { case: "fixed", value: wireMoney(terms.step) },
            },
          },
          options(meta),
        );
        return scheduleLotResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async getLot(person, lotId, meta) {
      try {
        const snapshot = await rpc.getLot(
          { viewer: wireViewer(viewerOf(person)), lotId },
          options(meta),
        );
        return { kind: "ok", lot: lotViewOf(snapshot) };
      } catch (cause) {
        // Лот, которого read model не знает или который смотрящему не виден.
        if (cause instanceof ConnectError && cause.code === Code.NotFound) {
          return { kind: "not-found" };
        }
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
          async listLotHistory(request) {
            const page = await rpc.listLotHistory(
              {
                viewer: wireViewer(request.viewer),
                lotId: request.lotId,
                pageToken: request.pageToken,
              },
              options(meta),
            );
            return historyPageOf(page);
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
          // Команды участника (PER-317). Повтор тем же `op_id` решает пакет;
          // порт лишь отличает «ответа не было» от прочих отказов транспорта.
          placeBid(request) {
            return unansweredOn(async () =>
              bidOutcomeOf(
                await rpc.placeBid(
                  {
                    viewer: wireViewer(request.viewer),
                    lotId: request.lotId,
                    amount: wireMoney(request.amount),
                    opId: request.opId,
                  },
                  options(meta),
                ),
              ),
            );
          },
          setProxyLimit(request) {
            return unansweredOn(async () =>
              limitOutcomeOf(
                await rpc.setProxyLimit(
                  {
                    viewer: wireViewer(request.viewer),
                    lotId: request.lotId,
                    max: wireMoney(request.max),
                    opId: request.opId,
                  },
                  options(meta),
                ),
              ),
            );
          },
          async chooseDisplayName(request) {
            const { choice } = request;
            return displayNameOutcomeOf(
              await rpc.chooseDisplayName(
                {
                  viewer: wireViewer(request.viewer),
                  auctionId: request.auctionId,
                  choice:
                    choice.kind === "username"
                      ? { case: "telegramUsername", value: choice.username }
                      : { case: "alias", value: choice.alias },
                },
                options(meta),
              ),
            );
          },
        },
        operations: { newOperationId },
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

// Пустой `oneof` и отказ, которого у команды без изображения быть не может, —
// дефект соседа, а не решение: экран отвечает как на сбой, а причина уходит в
// запись границы.
function defect(what: string): AuctionFailure {
  return { kind: "invalid", cause: new Error(what) };
}

type CardOutcome =
  | Awaited<ReturnType<AuctionRpc["createLotCard"]>>["outcome"]
  | Awaited<ReturnType<AuctionRpc["editLotCard"]>>["outcome"];

// Отказ изображения — ответ на команду, которая его прислала. У команды без
// изображения такого отказа быть не может, и он — дефект соседа.
function cardResult(outcome: CardOutcome, sentImage: boolean): LotCardResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notAdmin":
          return { kind: "not-admin" };
        case "emptyTitle":
          return { kind: "empty-title" };
        case "cardConflict":
          return { kind: "card-conflict" };
        case "cardNotFound":
          return { kind: "card-not-found" };
        case "imageTooLarge":
          return sentImage
            ? {
                kind: "image-too-large",
                maxBytes: Number(outcome.value.reason.value.maxBytes),
              }
            : defect("lot card refused an image that was not sent");
        case "unsupportedImage":
          return sentImage
            ? { kind: "unsupported-image" }
            : defect("lot card refused an image that was not sent");
        case undefined:
          return defect("lot card refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("lot card response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function addLotResult(
  outcome: Awaited<ReturnType<AuctionRpc["addLot"]>>["outcome"],
): AddLotResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "lotsFrozen":
          return { kind: "lots-frozen" };
        case undefined:
          return defect("add lot refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("add lot response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function scheduleLotResult(
  outcome: Awaited<ReturnType<AuctionRpc["scheduleLot"]>>["outcome"],
): ScheduleLotResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "lotsFrozen":
          return { kind: "lots-frozen" };
        case "lotNotInAuction":
          return { kind: "lot-not-in-auction" };
        case "schedulingClosed":
          return { kind: "scheduling-closed" };
        case "stepPolicyInvalid":
          return { kind: "step-policy-invalid" };
        case "currencyMismatch":
          return { kind: "currency-mismatch" };
        case undefined:
          return defect("schedule lot refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("schedule lot response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// У команд реестра и условий `NOT_FOUND` — аукцион без журнала: кнопка
// устарела или подделана, и повтор его не найдёт.
function auctionMissing(
  cause: unknown,
): { kind: "auction-not-found" } | undefined {
  return cause instanceof ConnectError && cause.code === Code.NotFound
    ? { kind: "auction-not-found" }
    : undefined;
}

function wireMoney(amount: Money) {
  return { minorUnits: BigInt(amount.minorUnits), currency: amount.currency };
}

// Статусы gRPC остаются для того, что не решение аукциона (integration.md,
// «Auction gRPC»): форма запроса, роль, недоступный Meetups за спиной Auction.
// `ALREADY_EXISTS` — `op_id` занят другой командой: ключ рождается на каждый
// вызов, поэтому это дефект, а не сбой, который лечит повтор.
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
      cause.code === Code.FailedPrecondition ||
      cause.code === Code.AlreadyExists)
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
