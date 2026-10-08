import type { Client } from "@connectrpc/connect";
import { createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  AuctionService,
  AuctionListing as WireListing,
} from "../../../gen/auction/v1/auction_service_pb.js";
import {
  IdentityService,
  RoleRequestOutcome as WireOutcome,
} from "../../../gen/identity/v1/identity_service_pb.js";
import { AccessRight as WireRight } from "../../../gen/identity/v1/roles_pb.js";
import type {
  LotImagePort,
  Money,
  ResolvedIdentity,
  RoleRequest,
  RoleRequestAnswer,
  RoleRequestOutcome,
  TelegramUser,
  Viewer,
} from "../../auction-ui/index.js";
import {
  bidOutcomeOf,
  displayNameOutcomeOf,
  limitOutcomeOf,
  unansweredOn,
} from "../../core/auction/commands.js";
import { historyPageOf } from "../../core/auction/history.js";
import { lotViewOf } from "../../core/auction/snapshot.js";
import {
  classifyRecipientFailure,
  type TelegramRecipientResolver,
} from "../../core/delivery/index.js";
import { rightsOf, wireQueue, wireViewer } from "../../core/identity/access.js";
import {
  callTimeoutMs,
  presentServiceToken,
  requestIdHeader,
} from "../../core/rpc-metadata.js";
import { type Tracing, traceRpc } from "../../core/tracing.js";
import { createUuidV7 } from "../../core/uuid-v7.js";
import type { NotificationReads } from "./delivery/message.js";
import type { EntryPorts } from "./entry-ports.js";
import { auctionSummaryOf } from "./snapshot.js";

export const rpcTimeoutMs = 3_000;
// Байты изображения — до нескольких мегабайт, им нужно больше времени, чем
// снимку. Отказ здесь стоит карточке фото, а не экрана. Бюджет действия
// режет и его: `GetLotImage` делит 5 секунд с личностью и чтением лота
// (дизайн-код, «Показ фото лота»).
export const imageTimeoutMs = 10_000;

// Тип клиента берётся из схемы, а не переписывается рядом с ней: Pick по
// сгенерированному Client роняет typecheck на первом расхождении с contracts/proto.
export type IdentityRpc = Pick<
  Client<typeof IdentityService>,
  | "resolveIdentity"
  | "requestRole"
  | "resolveTelegramUserId"
  | "checkAccessRight"
>;
export type AuctionRpc = Pick<
  Client<typeof AuctionService>,
  | "getLot"
  | "listAuctionLots"
  | "listLotHistory"
  | "getDisplayNames"
  | "placeBid"
  | "setProxyLimit"
  | "chooseDisplayName"
  | "getLotImage"
  | "listAuctions"
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

export type PortsOptions = {
  timeoutMs?: number;
  // Источник `op_id`; тесты подменяют его, чтобы ключ команды был виден.
  newOperationId?: () => string;
  // Отказ `GetDisplayNames` пакет гасит: карточка остаётся без имени. Чтобы
  // деградация не была молчаливой, порт сообщает о ней до того, как бросить.
  onNamesRefused?: (cause: unknown, requestId: string) => void;
};

export function createPorts(
  identity: IdentityRpc,
  auction: AuctionRpc,
  {
    timeoutMs = rpcTimeoutMs,
    newOperationId = createUuidV7,
    onNamesRefused,
  }: PortsOptions = {},
): PortsFactory {
  return (requestId, deadlineAt) => {
    const headers = { [requestIdHeader]: requestId };
    // Остаток бюджета считается в момент вызова, а не при сборке портов.
    const callOptions = (ownMs: number) => ({
      timeoutMs: callTimeoutMs(
        deadlineAt === undefined ? undefined : { deadlineAt },
        ownMs,
      ),
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
            viewer: viewerFrom(response),
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
              queue: wireQueue(request.queue),
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
            viewer: viewerFrom(response),
            outcome: outcomeName(response.outcome),
          };
        },
      },
      auction: {
        async getLot(request: { viewer: Viewer; lotId: string }) {
          const snapshot = await auction.getLot(
            { viewer: wireViewer(request.viewer), lotId: request.lotId },
            callOptions(timeoutMs),
          );
          return lotViewOf(snapshot);
        },
        async listAuctionLots(request) {
          const page = await auction.listAuctionLots(
            {
              viewer: wireViewer(request.viewer),
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
              viewer: wireViewer(request.viewer),
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
                viewer: wireViewer(request.viewer),
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
        // Команды участника (PER-317). Повтор тем же `op_id` решает пакет;
        // порт лишь отличает «ответа не было» от прочих отказов транспорта.
        placeBid(request) {
          return unansweredOn(async () =>
            bidOutcomeOf(
              await auction.placeBid(
                {
                  viewer: wireViewer(request.viewer),
                  lotId: request.lotId,
                  amount: wireMoney(request.amount),
                  opId: request.opId,
                },
                callOptions(timeoutMs),
              ),
            ),
          );
        },
        setProxyLimit(request) {
          return unansweredOn(async () =>
            limitOutcomeOf(
              await auction.setProxyLimit(
                {
                  viewer: wireViewer(request.viewer),
                  lotId: request.lotId,
                  max: wireMoney(request.max),
                  opId: request.opId,
                },
                callOptions(timeoutMs),
              ),
            ),
          );
        },
        async chooseDisplayName(request) {
          const { choice } = request;
          return displayNameOutcomeOf(
            await auction.chooseDisplayName(
              {
                viewer: wireViewer(request.viewer),
                auctionId: request.auctionId,
                choice:
                  choice.kind === "username"
                    ? { case: "telegramUsername", value: choice.username }
                    : { case: "alias", value: choice.alias },
              },
              callOptions(timeoutMs),
            ),
          );
        },
      },
      operations: { newOperationId },
      catalog: {
        async listAuctions(request) {
          const page = await auction.listAuctions(
            {
              viewer: wireViewer(request.viewer),
              listing:
                request.listing === "active"
                  ? WireListing.ACTIVE
                  : WireListing.FINISHED,
              pageToken: request.pageToken,
            },
            callOptions(timeoutMs),
          );
          return {
            auctions: page.auctions.map(auctionSummaryOf),
            nextPageToken: page.nextPageToken,
          };
        },
      },
      image: {
        async getLotImage(request) {
          const image = await auction.getLotImage(
            { viewer: wireViewer(request.viewer), lotId: request.lotId },
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
            { viewer: wireViewer(viewer) },
            callOptions(timeoutMs),
          );
          return response.acknowledged;
        },
        async acknowledge(viewer) {
          const response = await auction.acknowledgeFaq(
            { viewer: wireViewer(viewer) },
            callOptions(timeoutMs),
          );
          if (!response.acknowledged)
            throw new Error("Auction did not acknowledge FAQ completion");
        },
      },
    };
  };
}

// Канал доставки (PER-328): получатель уведомления, его право `auction` и
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
      async hasAuctionRight(identityId, requestId) {
        const response = await identity.checkAccessRight(
          { identityId, right: WireRight.AUCTION },
          options(requestId),
        );
        return response.granted;
      },
      async lotTitle(identityId, lotId, requestId) {
        // Право `auction` у получателя Identity подтвердил шагом раньше, и
        // смотрящий несёт только его: Auction без него лот не отдаёт, а
        // выдумывать получателю права канал не вправе.
        const snapshot = await auction.getLot(
          {
            viewer: wireViewer({ identityId, rights: ["auction"] }),
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

export function createClients(options: {
  identityUrl: string;
  auctionUrl: string;
  serviceToken: string;
  tracing: Tracing;
  onNamesRefused?: (cause: unknown, requestId: string) => void;
}): Clients {
  const identitySession = new Http2SessionManager(options.identityUrl);
  const auctionSession = new Http2SessionManager(options.auctionUrl);
  const interceptors = [
    presentServiceToken(options.serviceToken),
    traceRpc(options.tracing),
  ];
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

// Смотрящий несёт права, которые вывел Identity: по ним шлюз решает допуск, и
// они же уходят в `auction.v1.Viewer`.
function viewerFrom(response: {
  identityId: string;
  rights: readonly WireRight[];
}): Viewer {
  return {
    identityId: response.identityId,
    rights: rightsOf(response.rights),
  };
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

function wireMoney(money: Money) {
  return { minorUnits: BigInt(money.minorUnits), currency: money.currency };
}
