import type { MessageInitShape } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import {
  BidSource,
  type StepPolicySchema,
} from "../../../../gen/auction/v1/auction_pb.js";
import type { AuctionSnapshot } from "../../../../gen/auction/v1/auction_service_pb.js";
import {
  AuctionListing,
  AuctionService,
  type ConfigInvalid,
} from "../../../../gen/auction/v1/auction_service_pb.js";
import type {
  AuctionStageView,
  AuctionSummaryView,
  Money,
} from "../../../auction-ui/index.js";
import { auctionSummaryViewOf } from "../../../core/auction/auction.js";
import {
  bidOutcomeOf,
  displayNameOutcomeOf,
  limitOutcomeOf,
  ownDisplayNameOf,
  unansweredOn,
} from "../../../core/auction/commands.js";
import { type Pause, readLotAtLeast } from "../../../core/auction/fresh.js";
import { historyPageOf } from "../../../core/auction/history.js";
import {
  myPredictionsOf,
  predictionOutcomeOf,
  wirePredictionAnswers,
  wirePredictionRound,
} from "../../../core/auction/predictions.js";
import {
  cancellationOutcomeOf,
  raffleOf,
  registrationOutcomeOf,
} from "../../../core/auction/raffle.js";
import { lotOrMissing, lotViewOf } from "../../../core/auction/snapshot.js";
import {
  type AuctionWatchSource,
  watchSourceOf,
} from "../../../core/auction/watch.js";
import { wireViewer } from "../../../core/identity/access.js";
import {
  type LotInfo,
  lotInfoOf,
} from "../../../core/notifications/lot-notice.js";
import {
  callHeaders,
  callTimeoutMs,
  presentServiceToken,
  type RpcMetadata,
} from "../../../core/rpc-metadata.js";
import { type RpcClientOptions, traceRpc } from "../../../core/tracing.js";
import { createUuidV7 } from "../../../core/uuid-v7.js";
import type { Person } from "../application/types.js";
import { consoleOf } from "./console.js";
import {
  type AddLotResult,
  type AdvanceAskResult,
  type AuctionConsoles,
  type AuctionFailure,
  type AuctionScreenPorts,
  type AuctionScreens,
  type CloseLotResult,
  type ConsoleReadResult,
  type DaySummaryReadResult,
  type DiscardAuctionResult,
  type EnableAuctionResult,
  type FinalistRefusal,
  type FinalistResult,
  type FloorBidResult,
  type FreezeFinalLineupResult,
  type LotAdministration,
  type LotCardResult,
  type LotStatisticsReadResult,
  type LotStepPolicyInput,
  type MeetupAuctions,
  type ScheduleAuctionResult,
  type ScheduleLotResult,
  type StartFinalResult,
  type StartNextLotResult,
  type StartPrebiddingResult,
  viewerOf,
} from "./port.js";

// Тип клиента берётся из схемы, а не переписывается рядом с ней: Pick по
// сгенерированному Client роняет typecheck на первом расхождении с
// contracts/proto. Методы — ровно те, что бот хаба зовёт по колонке Caller в
// integration.md.
type AuctionRpc = Pick<
  Client<typeof AuctionService>,
  | "draftAuction"
  | "getMeetupAuction"
  | "listAuctions"
  | "createLotCard"
  | "editLotCard"
  | "addLot"
  | "scheduleLot"
  | "getLot"
  | "listAuctionLots"
  | "listLotHistory"
  | "getDisplayNames"
  | "listAuctionNames"
  | "placeBid"
  | "setProxyLimit"
  | "chooseDisplayName"
  | "getAuction"
  | "getRaffle"
  | "registerForRaffle"
  | "cancelRaffleRegistration"
  | "getMyPredictions"
  | "submitPrediction"
  | "getLotImage"
  | "getAuctionConsole"
  | "getAuctionLotStatistics"
  | "getAuctionDaySummary"
  | "scheduleAuction"
  | "startPrebidding"
  | "discardAuction"
  | "selectForFinal"
  | "deselectForFinal"
  | "freezeFinalLineup"
  | "startFinal"
  | "startNextLot"
  | "advanceAsk"
  | "closeLot"
>;

// Сколько страниц хронологии пульт ведущего читает в поисках последних ставок.
const historyPageLimit = 20;

// Активных аукционов единицы: обход страниц — предохранитель от соседа,
// который повторяет токен.
const currentAuctionPageLimit = 20;

// Ближайший по началу онлайн-торгов; без онлайн-фазы — последним.
function openingOf(opensAt: string | undefined): number {
  return opensAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(opensAt);
}

// Запланированный аукцион ещё не идёт: среди активных он — после открытых.
function pendingOf(stage: AuctionStageView): number {
  return stage === "scheduled" || stage === "draft" ? 1 : 0;
}

export type AuctionClient = MeetupAuctions &
  AuctionScreens &
  LotAdministration &
  AuctionConsoles & {
    // Поток аукциона для карточек финала (PER-336).
    watch: AuctionWatchSource;
    close(): void;
  };

export type AuctionAdapterOptions = {
  timeoutMs?: number;
  // Отказ `GetDisplayNames` пакет гасит: карточка лота остаётся без имени.
  // Чтобы деградация не была молчаливой, порт сообщает о ней до того, как
  // бросить (бриф ботов, «Лента и карточка лота»).
  onNamesRefused?: (cause: unknown, meta: RpcMetadata | undefined) => void;
  // Источник `op_id` команд участника; тесты подменяют его.
  newOperationId?: () => string;
  // Пауза дочитывания лота до версии команды (PER-470); тесты подменяют её.
  pause?: Pause;
  // Отказ `GetRaffle` лента гасит: кнопка «Розыгрыш» пропадает (PER-500).
  onRaffleRefused?: (cause: unknown, meta: RpcMetadata | undefined) => void;
};

export function createAuctionClient(
  baseUrl: string,
  {
    tracing,
    serviceToken,
    timeoutMs = 3_000,
    onNamesRefused,
    onRaffleRefused,
  }: RpcClientOptions &
    Pick<AuctionAdapterOptions, "onNamesRefused" | "onRaffleRefused">,
): AuctionClient & LotInfoReader {
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
    ...(onRaffleRefused === undefined ? {} : { onRaffleRefused }),
  });
  return {
    ...client,
    ...createLotInfoReader(rpc, timeoutMs),
    // Поток живёт, пока его не отпустит подписка: дедлайн транспорта по
    // умолчанию оборвал бы его через три секунды.
    watch: watchSourceOf(rpc, (signal) => ({ signal, timeoutMs: 0 })),
    close: () => sessionManager.abort(),
  };
}

// Название лота для текста уведомления (PER-598). Личности из update у
// доставки нет — только `identity_id` получателя, и право `place-bids` у него
// Identity подтвердил шагом раньше: смотрящий несёт только его, а выдумывать
// получателю права канал не вправе. Любой отказ — исключение со своим кодом:
// какой из них лечится повтором, решает общий рендер уведомлений.
export type LotInfoReader = {
  lotInfo(
    identityId: string,
    lotId: string,
    meta?: RpcMetadata,
  ): Promise<LotInfo>;
};

export function createLotInfoReader(
  rpc: Pick<AuctionRpc, "getLot">,
  timeoutMs = 3_000,
): LotInfoReader {
  return {
    async lotInfo(identityId, lotId, meta) {
      const snapshot = await rpc.getLot(
        {
          viewer: wireViewer({ identityId, rights: ["place-bids"] }),
          lotId,
        },
        { timeoutMs: callTimeoutMs(meta, timeoutMs), ...callHeaders(meta) },
      );
      return lotInfoOf(snapshot);
    },
  };
}

export function createAuctionAdapter(
  rpc: AuctionRpc,
  {
    timeoutMs = 3_000,
    onNamesRefused,
    newOperationId = createUuidV7,
    pause,
    onRaffleRefused,
  }: AuctionAdapterOptions = {},
): MeetupAuctions & AuctionScreens & LotAdministration & AuctionConsoles {
  // Дедлайн вызова — меньшее из своего и остатка бюджета действия: бюджет
  // один на Identity, чтение лота и изображение (дизайн-код, «Ожидание»).
  const options = (meta?: RpcMetadata) => ({
    timeoutMs: callTimeoutMs(meta, timeoutMs),
    ...callHeaders(meta),
  });
  // Активные аукционы сообщества целиком: их единицы, а обход страниц —
  // предохранитель от соседа, который повторяет токен.
  async function listActive(person: Person, meta?: RpcMetadata) {
    const auctions = [];
    let pageToken = "";
    for (let pages = 0; pages < currentAuctionPageLimit; pages += 1) {
      const page = await rpc.listAuctions(
        {
          viewer: wireViewer(viewerOf(person)),
          listing: AuctionListing.ACTIVE,
          pageToken,
        },
        options(meta),
      );
      auctions.push(...page.auctions.map(auctionSummaryViewOf));
      if (page.nextPageToken === "" || page.nextPageToken === pageToken) {
        break;
      }
      pageToken = page.nextPageToken;
    }
    return auctions;
  }
  return {
    async getMeetupAuction(person, meetupId, meta) {
      try {
        const response = await rpc.getMeetupAuction(
          { viewer: wireViewer(viewerOf(person)), meetupId },
          options(meta),
        );
        if (response.auction === undefined) return { kind: "ok" };
        return {
          kind: "ok",
          auctionId: response.auction.id,
          ...summaryOrNothing(response.auction),
        };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async currentAuction(person, meta) {
      try {
        const auctions = await listActive(person, meta);
        // Открытый аукцион идёт раньше запланированного (PER-669): аукцион,
        // которому слот торгов не дал открыться, не заслоняет идущий финал.
        const [current] = auctions.sort(
          (a, b) =>
            pendingOf(a.stage) - pendingOf(b.stage) ||
            openingOf(a.opensAt) - openingOf(b.opensAt),
        );
        // Снимок едет вместе с идентификатором: по стадии меню решает, идёт
        // ли аукцион как событие (PER-669).
        return current === undefined
          ? { kind: "ok" }
          : { kind: "ok", auctionId: current.auctionId, auction: current };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async activeAuctions(person, meta) {
      try {
        return { kind: "ok", auctions: await listActive(person, meta) };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async consoleRaffle(person, auctionId, meta) {
      try {
        const { raffle } = await rpc.getRaffle(
          { viewer: wireViewer(viewerOf(person)), auctionId },
          options(meta),
        );
        return raffle === undefined
          ? { kind: "ok" }
          : { kind: "ok", raffle: raffleOf(raffle) };
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
            stepPolicy: stepPolicyWire(terms.stepPolicy),
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
    // Пульт аукциона (PER-320). `NOT_FOUND` у всех пяти — аукциона нет.
    async getAuctionConsole(person, auctionId, meta) {
      try {
        const response = await rpc.getAuctionConsole(
          { viewer: wireViewer(viewerOf(person)), auctionId },
          options(meta),
        );
        return consoleResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async getAuctionLotStatistics(person, auctionId, meta) {
      try {
        const response = await rpc.getAuctionLotStatistics(
          { viewer: wireViewer(viewerOf(person)), auctionId },
          options(meta),
        );
        return lotStatisticsResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async getAuctionDaySummary(person, day, meta) {
      try {
        const response = await rpc.getAuctionDaySummary(
          {
            viewer: wireViewer(viewerOf(person)),
            auctionId: day.auctionId,
            from: day.from,
            until: day.until,
          },
          options(meta),
        );
        return daySummaryResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async scheduleAuction(person, week, meta) {
      try {
        const response = await rpc.scheduleAuction(
          {
            viewer: wireViewer(viewerOf(person)),
            auctionId: week.auctionId,
            opId: week.opId,
            // Неделя закрывает лоты общим дедлайном; финал — один блок либо
            // ни одного. `lot_defaults` не шлются: их подставляет Auction.
            // Окна «Счастливых часов» и момент розыгрыша едут всегда:
            // конфигурацию Auction заменяет целиком. Неделя без розыгрыша —
            // поле не выставлено.
            config: {
              onlinePhase: {
                opensAt: week.opensAt,
                closesAt: week.closesAt,
                closesLots: true,
                ...(week.raffleClosesAt === undefined
                  ? {}
                  : { raffleClosesAt: week.raffleClosesAt }),
                // Приз едет рядом с моментом розыгрыша и по той же причине
                // (PER-649): конфигурацию Auction заменяет целиком.
                ...(week.rafflePrize === undefined
                  ? {}
                  : { rafflePrize: week.rafflePrize }),
              },
              finalBlocks: week.final ? 1 : 0,
              closingPolicy: {
                policy: week.final
                  ? { case: "mixed", value: { onlineByDeadline: true } }
                  : { case: "byDeadline", value: {} },
              },
              stepWindows: week.windows.map((window) => ({
                from: window.from,
                until: window.until,
                step: wireMoney(window.step),
                lotIds: [...window.lotIds],
              })),
            },
          },
          options(meta),
        );
        return scheduleAuctionResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async startPrebidding(person, start, meta) {
      try {
        const response = await rpc.startPrebidding(
          { viewer: wireViewer(viewerOf(person)), ...start },
          options(meta),
        );
        return startPrebiddingResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async discardAuction(person, discard, meta) {
      try {
        const response = await rpc.discardAuction(
          { viewer: wireViewer(viewerOf(person)), ...discard },
          options(meta),
        );
        return discardAuctionResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async selectForFinal(person, mark, meta) {
      try {
        const response = await rpc.selectForFinal(
          { viewer: wireViewer(viewerOf(person)), ...mark },
          options(meta),
        );
        return finalistResult(response.outcome, "select");
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async deselectForFinal(person, mark, meta) {
      try {
        const response = await rpc.deselectForFinal(
          { viewer: wireViewer(viewerOf(person)), ...mark },
          options(meta),
        );
        return finalistResult(response.outcome, "deselect");
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    // Состав финала (PER-619). `NOT_FOUND` — аукциона нет, как у пульта;
    // `UNAVAILABLE` — в том числе аукцион после рестарта ещё не знает
    // удержанных лотов, и повтор пройдёт.
    async freezeFinalLineup(person, freeze, meta) {
      try {
        const response = await rpc.freezeFinalLineup(
          {
            viewer: wireViewer(viewerOf(person)),
            auctionId: freeze.auctionId,
            opId: freeze.opId,
            lotIds: [...freeze.lotIds],
          },
          options(meta),
        );
        return freezeFinalLineupResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    // Финал ведущего (PER-337). `NOT_FOUND` — аукциона нет, как у пульта.
    async startFinal(person, start, meta) {
      try {
        const response = await rpc.startFinal(
          { viewer: wireViewer(viewerOf(person)), ...start },
          options(meta),
        );
        return startFinalResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async startNextLot(person, start, meta) {
      try {
        const response = await rpc.startNextLot(
          { viewer: wireViewer(viewerOf(person)), ...start },
          options(meta),
        );
        return startNextLotResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async advanceAsk(person, ask, meta) {
      try {
        const response = await rpc.advanceAsk(
          {
            viewer: wireViewer(viewerOf(person)),
            auctionId: ask.auctionId,
            lotId: ask.lotId,
            opId: ask.opId,
            newAsk: wireMoney(ask.newAsk),
          },
          options(meta),
        );
        return advanceAskResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async closeLot(person, close, meta) {
      try {
        const response = await rpc.closeLot(
          { viewer: wireViewer(viewerOf(person)), ...close },
          options(meta),
        );
        return closeLotResult(response.outcome);
      } catch (cause) {
        return auctionMissing(cause) ?? toFailure(cause);
      }
    },
    async displayNames(person, read, meta) {
      try {
        const response = await rpc.getDisplayNames(
          {
            viewer: wireViewer(viewerOf(person)),
            auctionId: read.auctionId,
            participantIds: [...read.participantIds],
          },
          options(meta),
        );
        return {
          kind: "ok",
          names: Object.fromEntries(
            Object.entries(response.names).map(([id, name]) => [id, name.text]),
          ),
        };
      } catch (cause) {
        onNamesRefused?.(cause, meta);
        return toFailure(cause);
      }
    },
    // Хронология идёт по возрастанию, поэтому последние ставки — хвост
    // последней страницы. Страниц не больше `historyPageLimit`: пульт
    // ведущего ждать конца длинной хронологии не вправе, и недочитанная
    // ставок не даёт вовсе. Отказ имён пульт не роняет: ставки остаются без
    // имён.
    async recentBids(person, read, meta) {
      const viewer = wireViewer(viewerOf(person));
      let bids: { amount: Money; participantId: string }[] = [];
      try {
        let pageToken = "";
        for (let page = 0; page < historyPageLimit; page += 1) {
          const history = historyPageOf(
            await rpc.listLotHistory(
              { viewer, lotId: read.lotId, pageToken },
              options(meta),
            ),
          );
          bids = [
            ...bids,
            ...history.entries.map((entry) => ({
              amount: entry.amount,
              participantId: entry.participantId,
            })),
          ].slice(-read.limit);
          pageToken = history.nextPageToken;
          if (pageToken === "") break;
        }
        // Хвост не дочитан: прочитанное — не последние ставки, и выдавать
        // его за последние нельзя.
        if (pageToken !== "") bids = [];
      } catch (cause) {
        return toFailure(cause);
      }
      const latest = bids.reverse();
      const ids = [
        ...new Set([
          ...latest.map((bid) => bid.participantId),
          ...read.extraIds,
        ]),
      ];
      if (ids.length === 0) return { kind: "ok", bids: latest, names: {} };
      try {
        const response = await rpc.getDisplayNames(
          { viewer, auctionId: read.auctionId, participantIds: ids },
          options(meta),
        );
        return {
          kind: "ok",
          bids: latest,
          names: Object.fromEntries(
            Object.entries(response.names).map(([id, name]) => [id, name.text]),
          ),
        };
      } catch (cause) {
        onNamesRefused?.(cause, meta);
        return { kind: "ok", bids: latest, names: {} };
      }
    },
    async listAuctionNames(person, auctionId, meta) {
      try {
        const response = await rpc.listAuctionNames(
          { viewer: wireViewer(viewerOf(person)), auctionId },
          options(meta),
        );
        return {
          kind: "ok",
          names: response.names.map((each) => ({
            participantId: each.participantId,
            name: each.name?.text ?? "",
          })),
        };
      } catch (cause) {
        return toFailure(cause);
      }
    },
    // Ставка зала (PER-565): смотрящий — помощник, ставящий — человек зала.
    // Повтора нет ни на каком исходе: ставка, ответ на которую потерялся,
    // могла пройти, и решает её человек по экрану.
    async placeFloorBid(person, bid, meta) {
      try {
        const response = await rpc.placeBid(
          {
            viewer: wireViewer(viewerOf(person)),
            lotId: bid.lotId,
            amount: wireMoney(bid.amount),
            opId: bid.opId,
            source: BidSource.FLOOR,
            participantId: bid.participantId,
          },
          options(meta),
        );
        return floorBidResult(response.outcome);
      } catch (cause) {
        return toFailure(cause);
      }
    },
    async floorLot(person, read, meta) {
      try {
        const lot = await readLotAtLeast(
          async () =>
            lotViewOf(
              await rpc.getLot(
                { viewer: wireViewer(viewerOf(person)), lotId: read.lotId },
                options(meta),
              ),
            ),
          read.atLeastVersion,
          pause,
        );
        return { kind: "ok", lot };
      } catch (cause) {
        if (cause instanceof ConnectError && cause.code === Code.NotFound) {
          return { kind: "not-found" };
        }
        return toFailure(cause);
      }
    },
    screenPorts(meta): AuctionScreenPorts {
      return {
        auction: {
          getLot(request) {
            return readLotAtLeast(
              async () =>
                lotViewOf(
                  await rpc.getLot(
                    {
                      viewer: wireViewer(request.viewer),
                      lotId: request.lotId,
                    },
                    options(meta),
                  ),
                ),
              request.atLeastVersion,
              pause,
            );
          },
          findLot(request) {
            return lotOrMissing(() =>
              rpc.getLot(
                { viewer: wireViewer(request.viewer), lotId: request.lotId },
                options(meta),
              ),
            );
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
          async getOwnDisplayName(request) {
            const response = await rpc.getDisplayNames(
              {
                viewer: wireViewer(request.viewer),
                auctionId: request.auctionId,
                participantIds: [request.viewer.identityId],
              },
              options(meta),
            );
            return ownDisplayNameOf(response, request.viewer.identityId);
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
          // Корень аукциона (PER-605): черновик бот хаба видит, как в
          // `GetMeetupAuction`.
          async getAuction(request) {
            const { auction } = await rpc.getAuction(
              {
                viewer: wireViewer(request.viewer),
                auctionId: request.auctionId,
              },
              options(meta),
            );
            return auction === undefined
              ? undefined
              : auctionSummaryViewOf(auction);
          },
          // Розыгрыш среди участников (ADR-066): команды — как у ставки.
          async getRaffle(request) {
            try {
              const { raffle } = await rpc.getRaffle(
                {
                  viewer: wireViewer(request.viewer),
                  auctionId: request.auctionId,
                },
                options(meta),
              );
              return raffle === undefined ? undefined : raffleOf(raffle);
            } catch (cause) {
              onRaffleRefused?.(cause, meta);
              throw cause;
            }
          },
          registerForRaffle(request) {
            return unansweredOn(async () =>
              registrationOutcomeOf(
                await rpc.registerForRaffle(
                  {
                    viewer: wireViewer(request.viewer),
                    auctionId: request.auctionId,
                    opId: request.opId,
                  },
                  options(meta),
                ),
              ),
            );
          },
          cancelRaffleRegistration(request) {
            return unansweredOn(async () =>
              cancellationOutcomeOf(
                await rpc.cancelRaffleRegistration(
                  {
                    viewer: wireViewer(request.viewer),
                    auctionId: request.auctionId,
                    opId: request.opId,
                  },
                  options(meta),
                ),
              ),
            );
          },
          async getMyPredictions(request) {
            const response = await rpc.getMyPredictions(
              {
                viewer: wireViewer(request.viewer),
                auctionId: request.auctionId,
              },
              options(meta),
            );
            return myPredictionsOf(response);
          },
          submitPrediction(request) {
            return unansweredOn(async () =>
              predictionOutcomeOf(
                await rpc.submitPrediction(
                  {
                    viewer: wireViewer(request.viewer),
                    auctionId: request.auctionId,
                    round: wirePredictionRound(request.round),
                    answers: wirePredictionAnswers(request.answers),
                    opId: request.opId,
                  },
                  options(meta),
                ),
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
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
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
        case "cardClosed":
          return { kind: "card-closed" };
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
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
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

// Условия шага в форму сообщения: один шаг — `fixed`, пороги — `tiered`.
function stepPolicyWire(
  policy: LotStepPolicyInput,
): MessageInitShape<typeof StepPolicySchema> {
  return policy.kind === "fixed"
    ? { policy: { case: "fixed", value: wireMoney(policy.step) } }
    : {
        policy: {
          case: "tiered",
          value: {
            tiers: policy.tiers.map((tier) => ({
              lowerBound: wireMoney(tier.lowerBound),
              step: wireMoney(tier.step),
            })),
          },
        },
      };
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
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
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

function consoleResult(
  outcome: Awaited<ReturnType<AuctionRpc["getAuctionConsole"]>>["outcome"],
): ConsoleReadResult {
  switch (outcome.case) {
    case "console":
      return { kind: "ok", console: consoleOf(outcome.value) };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case undefined:
          return defect("auction console refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("auction console response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function lotStatisticsResult(
  outcome: Awaited<
    ReturnType<AuctionRpc["getAuctionLotStatistics"]>
  >["outcome"],
): LotStatisticsReadResult {
  switch (outcome.case) {
    case "statistics":
      return {
        kind: "ok",
        lots: outcome.value.lots.map((lot) => {
          const bidCount = safeCount(lot.bidCount, "statistics bid count");
          const uniqueParticipantCount = safeCount(
            lot.uniqueParticipantCount,
            "unique participant count",
          );
          return {
            lotId: lot.lotId,
            bidCount,
            uniqueParticipantCount,
            ...(lot.priceGrowth === undefined
              ? {}
              : { priceGrowth: moneyOf(lot.priceGrowth) }),
          };
        }),
      };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case undefined:
          return defect("auction lot statistics refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("auction lot statistics response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function daySummaryResult(
  outcome: Awaited<ReturnType<AuctionRpc["getAuctionDaySummary"]>>["outcome"],
): DaySummaryReadResult {
  switch (outcome.case) {
    case "summary":
      return {
        kind: "ok",
        lots: outcome.value.lots.map((lot) => {
          const bidCount = safeCount(lot.bidCount, "day summary bid count");
          return {
            lotId: lot.lotId,
            bidCount,
            ...(lot.maxPrice === undefined
              ? {}
              : { maxPrice: moneyOf(lot.maxPrice) }),
            ...(lot.growth === undefined
              ? {}
              : { growth: moneyOf(lot.growth) }),
          };
        }),
      };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case undefined:
          return defect("auction day summary refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("auction day summary response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function safeCount(value: bigint, field: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${field} out of range`);
  }
  return count;
}

function moneyOf(value: { minorUnits: bigint; currency: string }): Money {
  const minorUnits = Number(value.minorUnits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    throw new Error("price growth out of range");
  }
  return { minorUnits, currency: value.currency };
}

// Конфигурацию собирает бот: конец позже начала, окна «Счастливых часов» и
// момент розыгрыша задаёт человек, а остальные отказы — дефект сборки, а не
// ответ человеку.
// Окно без `closes_at` бот не соберёт: сроки недели он шлёт всегда.
function configRefusal(reason: ConfigInvalid["reason"]): ScheduleAuctionResult {
  switch (reason.case) {
    case "closesAtNotAfterOpensAt":
      return { kind: "closes-not-after-opens" };
    case "stepWindowOutsideOnlinePhase":
      return { kind: "window-outside-week", window: reason.value.windowIndex };
    case "stepWindowsOverlap":
      return {
        kind: "windows-overlap",
        first: reason.value.firstIndex,
        second: reason.value.secondIndex,
      };
    case "stepWindowStepInvalid":
      return { kind: "window-step-invalid", window: reason.value.windowIndex };
    case "stepWindowLotsEmpty":
      return { kind: "window-lots-empty", window: reason.value.windowIndex };
    case "raffleClosesAtNotAfterOpensAt":
      return { kind: "raffle-not-after-opens" };
    case "raffleClosesAtNotBeforeClosesAt":
      return { kind: "raffle-not-before-closes" };
    // Приз розыгрыша (PER-649): правило то же, что проверяет бот, — пустой приз,
    // приз длиннее предела и приз без розыгрыша Auction не принимает.
    case "rafflePrizeWithoutRaffle":
      return { kind: "raffle-prize-without-raffle" };
    case "rafflePrizeBlank":
      return { kind: "raffle-prize-blank" };
    case "rafflePrizeTooLong":
      return { kind: "raffle-prize-too-long" };
    default:
      return defect(
        `schedule auction refused the configuration: ${reason.case ?? "no reason"}`,
      );
  }
}

function scheduleAuctionResult(
  outcome: Awaited<ReturnType<AuctionRpc["scheduleAuction"]>>["outcome"],
): ScheduleAuctionResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "auctionAlreadyStarted":
          return { kind: "already-started" };
        case "configInvalid":
          return configRefusal(outcome.value.reason.value.reason);
        case undefined:
          return defect("schedule auction refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("schedule auction response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function startPrebiddingResult(
  outcome: Awaited<ReturnType<AuctionRpc["startPrebidding"]>>["outcome"],
): StartPrebiddingResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "meetupHidden":
          return { kind: "meetup-hidden" };
        case "auctionNotScheduled":
          return { kind: "not-scheduled" };
        case "anotherAuctionActive":
          return {
            kind: "another-auction-active",
            auctionId: outcome.value.reason.value.auctionId,
          };
        case undefined:
          return defect("start prebidding refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("start prebidding response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function discardAuctionResult(
  outcome: Awaited<ReturnType<AuctionRpc["discardAuction"]>>["outcome"],
): DiscardAuctionResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "auctionAlreadyStarted":
          return { kind: "already-started" };
        case undefined:
          return defect("discard auction refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("discard auction response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

type FinalistOutcome =
  | Awaited<ReturnType<AuctionRpc["selectForFinal"]>>["outcome"]
  | Awaited<ReturnType<AuctionRpc["deselectForFinal"]>>["outcome"];

// Отметку и её снятие Auction отвечает одним словарём отказов, кроме пары
// «уже отмечен» и «не отмечен»: каждая — у своей команды.
function finalistResult(
  outcome: FinalistOutcome,
  command: "select" | "deselect",
): FinalistResult {
  const refused = (reason: FinalistRefusal): FinalistResult => ({
    kind: "refused",
    reason,
  });
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused": {
      const reason = outcome.value.reason;
      switch (reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "notInPrebidding":
          return refused("not-in-prebidding");
        case "lotNotInAuction":
          return refused("lot-not-in-auction");
        case "lotNotOpen":
          return refused("lot-not-open");
        case "notInOnlinePhase":
          return refused("not-in-online-phase");
        case "alreadyMarkedForFinal":
          return refused("already-marked");
        case "notMarkedForFinal":
          return refused("not-marked");
        case "deadlinePassed":
          return refused("deadline-passed");
        case "selectionNotApplicable":
          return refused("selection-not-applicable");
        case undefined:
          return defect(`${command} for final refusal without a reason`);
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      return defect(`${command} for final response without an outcome`);
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function freezeFinalLineupResult(
  outcome: Awaited<ReturnType<AuctionRpc["freezeFinalLineup"]>>["outcome"],
): FreezeFinalLineupResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused": {
      const reason = outcome.value.reason;
      switch (reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "notInBreak":
          return { kind: "not-in-break" };
        case "lineupEmpty":
          return { kind: "lineup-empty" };
        case "lineupMismatch":
          return { kind: "lineup-mismatch" };
        case undefined:
          return defect("freeze final lineup refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      return defect("freeze final lineup response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function startFinalResult(
  outcome: Awaited<ReturnType<AuctionRpc["startFinal"]>>["outcome"],
): StartFinalResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused":
      switch (outcome.value.reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "lineupNotFrozen":
          return { kind: "lineup-not-frozen" };
        case undefined:
          return defect("start final refusal without a reason");
        default: {
          const _exhaustive: never = outcome.value.reason;
          return _exhaustive;
        }
      }
    case undefined:
      return defect("start final response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function startNextLotResult(
  outcome: Awaited<ReturnType<AuctionRpc["startNextLot"]>>["outcome"],
): StartNextLotResult {
  switch (outcome.case) {
    case "accepted":
      return outcome.value.lotId === ""
        ? defect("final lot activation without a lot")
        : { kind: "ok", lotId: outcome.value.lotId };
    case "refused": {
      const reason = outcome.value.reason;
      switch (reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "notInFinal":
          return { kind: "not-in-final" };
        case "anotherLotActive":
          return reason.value.lotId === ""
            ? defect("another lot active without a lot")
            : { kind: "another-lot-active", lotId: reason.value.lotId };
        case "lineupExhausted":
          return { kind: "lineup-exhausted" };
        case undefined:
          return defect("start next lot refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      return defect("start next lot response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function advanceAskResult(
  outcome: Awaited<ReturnType<AuctionRpc["advanceAsk"]>>["outcome"],
): AdvanceAskResult {
  switch (outcome.case) {
    case "accepted":
      return { kind: "ok" };
    case "refused": {
      const reason = outcome.value.reason;
      switch (reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "lotNotInAuction":
          return { kind: "lot-not-in-auction" };
        case "lotNotOpen":
          return { kind: "lot-not-open" };
        case "askBelowCurrentPrice": {
          const mustExceed = reason.value.mustExceed;
          return mustExceed === undefined
            ? defect("ask below current price without an amount")
            : {
                kind: "ask-below-current-price",
                mustExceed: moneyOf(mustExceed),
              };
        }
        case "currencyMismatch":
          return { kind: "currency-mismatch" };
        case undefined:
          return defect("advance ask refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      return defect("advance ask response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function closeLotResult(
  outcome: Awaited<ReturnType<AuctionRpc["closeLot"]>>["outcome"],
): CloseLotResult {
  switch (outcome.case) {
    case "accepted": {
      const result = outcome.value.result;
      switch (result.case) {
        case "sold": {
          const price = result.value.price;
          return price === undefined || result.value.winnerId === ""
            ? defect("lot sale without a winner or price")
            : {
                kind: "ok",
                closure: {
                  kind: "sold",
                  winnerId: result.value.winnerId,
                  price: moneyOf(price),
                },
              };
        }
        case "unsold":
          return { kind: "ok", closure: { kind: "unsold" } };
        case undefined:
          return defect("lot closure without a result");
        default: {
          const _exhaustive: never = result;
          return _exhaustive;
        }
      }
    }
    case "refused": {
      const reason = outcome.value.reason;
      switch (reason.case) {
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "meetupCancelled":
          return { kind: "meetup-cancelled" };
        case "lotNotInAuction":
          return { kind: "lot-not-in-auction" };
        case "lotNotOpen":
          return { kind: "lot-not-open" };
        case "deadlineNotReached":
          return { kind: "deadline-not-reached" };
        case undefined:
          return defect("close lot refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      return defect("close lot response without an outcome");
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Исходы ставки зала (PER-565, ADR-070 п. 5). Ниже минимума и чужая валюта в
// живом финале не случаются: сумма — следующая цена лота в его валюте, и такой
// отказ — дефект соседа.
function floorBidResult(
  outcome: Awaited<ReturnType<AuctionRpc["placeBid"]>>["outcome"],
): FloorBidResult {
  switch (outcome.case) {
    case "accepted":
      return {
        kind: "accepted",
        lotVersion: Number(outcome.value.lotVersion),
      };
    case "refused": {
      const reason = outcome.value.reason;
      switch (reason.case) {
        case "bidNotAtNextPrice": {
          const expected = reason.value.expected;
          return expected === undefined
            ? defect("next price refusal without the price")
            : { kind: "bid-not-at-next-price", expected: moneyOf(expected) };
        }
        case "bidderIsLeader":
          return { kind: "bidder-is-leader" };
        case "lotNotOpen":
        case "lotOnHold":
          return { kind: "lot-not-open" };
        case "displayNameNotChosen":
          return { kind: "display-name-not-chosen" };
        case "participantCannotBid":
          return { kind: "participant-cannot-bid" };
        case "participantRemovedFromLot":
          return { kind: "removed-from-lot" };
        case "notMeetupAdministrator":
          return { kind: "not-administrator" };
        case "meetupNotFound":
          return { kind: "meetup-not-found" };
        case "bidBelowMinimum":
        case "currencyMismatch":
          return defect(`floor bid refused as ${reason.case}`);
        case undefined:
          return defect("floor bid refusal without a reason");
        default: {
          const _exhaustive: never = reason;
          return _exhaustive;
        }
      }
    }
    case undefined:
      return defect("floor bid response without an outcome");
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
// Стадия и сроки нужны только строке аукциона на карточке сходки (PER-594).
// Снимок, который не разбирается, — дефект соседа, но меню «Расширения»
// по-прежнему открывает аукцион по одному идентификатору, а карточка остаётся
// без строки.
function summaryOrNothing(
  snapshot: AuctionSnapshot,
): { auction: AuctionSummaryView } | Record<string, never> {
  try {
    return { auction: auctionSummaryViewOf(snapshot) };
  } catch {
    return {};
  }
}

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
