import {
  type CallOptions,
  type Client,
  Code,
  ConnectError,
} from "@connectrpc/connect";
import type {
  AuctionService,
  AuctionWatch,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type { LotView, Viewer } from "../../auction-ui/index.js";
import { wireViewer } from "../identity/access.js";
import { lotViewOf } from "./snapshot.js";

// Поток аукциона `WatchAuction` (PER-335) — общий у поверхностей и у листов,
// которые его читают: карточка финала участника (PER-336), пульт ведущего
// (PER-566) и экран помощника (PER-565). Сообщение потока — состояние целиком,
// а не разница (integration.md, «Auction gRPC»): поэтому курсора у подписки
// нет, и переподключение после обрыва теряет только промежуточные шаги, а
// не состояние.

/** Состояние аукциона и его финала из одного сообщения потока. */
export type AuctionWatchState = {
  auctionId: string;
  // После сообщения с завершённым или отменённым аукционом сервер закрывает
  // поток: оба статуса конечные (ADR-047, дополнение 2026-10-12).
  finished: boolean;
  // Активный лот живого финала; нет — до финала, между лотами и после него.
  activeLot?: LotView;
  // Лоты замороженного состава в его порядке, активный включительно.
  lineup: readonly LotView[];
};

export function watchStateOf(message: AuctionWatch): AuctionWatchState {
  const { auction } = message;
  if (auction === undefined) {
    throw new Error("auction watch message without an auction");
  }
  return {
    auctionId: auction.id,
    finished:
      auction.status.case === "finished" || auction.status.case === "cancelled",
    ...(message.activeLot === undefined
      ? {}
      : { activeLot: lotViewOf(message.activeLot) }),
    lineup: message.lineup.map(lotViewOf),
  };
}

export type WatchRpc = Pick<Client<typeof AuctionService>, "watchAuction">;

/**
 * Поток одного аукциона, открытый правами смотрящего: Auction пускает в него
 * держателя `place_bids`, а содержимое у всех смотрящих одно.
 */
export type AuctionWatchSource = (
  request: { viewer: Viewer; auctionId: string },
  signal: AbortSignal,
) => AsyncIterable<AuctionWatchState>;

export function watchSourceOf(
  rpc: WatchRpc,
  options: (signal: AbortSignal) => CallOptions = (signal) => ({ signal }),
): AuctionWatchSource {
  return async function* (request, signal) {
    for await (const message of rpc.watchAuction(
      { viewer: wireViewer(request.viewer), auctionId: request.auctionId },
      options(signal),
    )) {
      yield watchStateOf(message);
    }
  };
}

export type AuctionWatches = {
  /**
   * Подписка на аукцион. Поток один на аукцион, сколько бы подписчиков у
   * него ни было; последний ушедший закрывает его. `viewer` — права, которыми
   * поток можно открыть: Auction пускает держателя `place_bids`. Подписчик,
   * пришедший к открытому потоку, сразу получает последнее состояние: иначе
   * изменение между его чтением и подпиской прошло бы мимо. `ended` — поток
   * закрылся сам: аукцион завершён или ни у одного подписчика нет прав.
   */
  subscribe(
    auctionId: string,
    viewer: Viewer,
    listener: (state: AuctionWatchState) => void,
    ended?: () => void,
  ): () => void;
  /** Число открытых потоков — по нему видно, что подписки не текут. */
  open(): number;
  close(): void;
};

// Отказ потока: `stream` — сам поток (соседу плохо или нет прав), `listener`
// — подписчик бросил на состоянии, дефект кода.
export type WatchFailure = "stream" | "listener";

// Паузы переподключения: первая — короткая, обрыв посреди финала должен
// закрыться за секунды; дальше пауза растёт, чтобы недоступный Auction не
// получал залп попыток от каждого бота.
export const WATCH_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

// Обработчик отмены снимается и тогда, когда пауза кончилась сама: сигнал у
// потока один на все переподключения, и долгий отказ соседа копил бы их.
const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    const abort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });
  });

type Subscriber = {
  viewer: Viewer;
  listener: (state: AuctionWatchState) => void;
  ended?: () => void;
};

type Feed = {
  subscribers: Map<number, Subscriber>;
  controller: AbortController;
  last?: AuctionWatchState;
};

// Отказ по правам смотрящего: другой подписчик может их иметь, а этот — уже
// нет. Остальные отказы — сосед недоступен.
function deniedRights(cause: unknown): boolean {
  return (
    cause instanceof ConnectError &&
    (cause.code === Code.PermissionDenied ||
      cause.code === Code.Unauthenticated)
  );
}

export function createAuctionWatches(options: {
  source: AuctionWatchSource;
  retryDelaysMs?: readonly number[];
  sleep?: Sleep;
  // Отказ потока и отказ подписчика: пишет поверхность, дерево логгера не держит.
  onError?: (auctionId: string, cause: unknown, failure: WatchFailure) => void;
}): AuctionWatches {
  const delays = options.retryDelaysMs ?? WATCH_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? realSleep;
  const feeds = new Map<string, Feed>();
  let nextId = 0;
  let closed = false;

  const notify = (
    auctionId: string,
    subscriber: Subscriber,
    state: AuctionWatchState,
  ) => {
    try {
      subscriber.listener(state);
    } catch (cause) {
      options.onError?.(auctionId, cause, "listener");
    }
  };

  // Поток закрылся сам: подписчики узнают, что состояний больше не будет.
  const end = (auctionId: string, feed: Feed) => {
    if (feeds.get(auctionId) === feed) feeds.delete(auctionId);
    feed.controller.abort();
    for (const subscriber of [...feed.subscribers.values()]) {
      subscriber.ended?.();
    }
  };

  const run = async (auctionId: string, feed: Feed) => {
    const { signal } = feed.controller;
    let attempt = 0;
    // Отказ потока может быть отказом прав смотрящего — у него отозвали
    // `place_bids`. Следующая попытка идёт правами другого подписчика, а
    // когда отказали права всех подряд, поток закрывается: повторять нечем.
    let turn = 0;
    let denied = 0;
    while (!signal.aborted) {
      const viewers = [...feed.subscribers.values()].map((s) => s.viewer);
      const viewer = viewers[turn % viewers.length];
      if (viewer === undefined) return;
      try {
        for await (const state of options.source(
          { viewer, auctionId },
          signal,
        )) {
          attempt = 0;
          denied = 0;
          feed.last = state;
          for (const subscriber of [...feed.subscribers.values()]) {
            notify(auctionId, subscriber, state);
          }
          if (state.finished) {
            // Завершённый аукцион больше не меняется: сервер закрывает
            // поток, и подписка заканчивается вместе с ним.
            end(auctionId, feed);
            return;
          }
        }
      } catch (cause) {
        if (signal.aborted) return;
        options.onError?.(auctionId, cause, "stream");
        turn += 1;
        if (deniedRights(cause)) {
          denied += 1;
          // Подписчики могли прийти, пока поток был открыт: считаются те,
          // кто есть в момент отказа.
          if (denied >= feed.subscribers.size) {
            end(auctionId, feed);
            return;
          }
        } else {
          denied = 0;
        }
      }
      if (signal.aborted) return;
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      attempt += 1;
      await sleep(delay, signal);
    }
  };

  return {
    subscribe(auctionId, viewer, listener, ended) {
      if (closed) return () => {};
      let feed = feeds.get(auctionId);
      const id = nextId++;
      const subscriber: Subscriber = {
        viewer,
        listener,
        ...(ended === undefined ? {} : { ended }),
      };
      if (feed === undefined) {
        const created: Feed = {
          subscribers: new Map([[id, subscriber]]),
          controller: new AbortController(),
        };
        feeds.set(auctionId, created);
        feed = created;
        void run(auctionId, created).catch((cause: unknown) =>
          options.onError?.(auctionId, cause, "stream"),
        );
      } else {
        feed.subscribers.set(id, subscriber);
        const { last } = feed;
        const own = feed;
        if (last !== undefined) {
          queueMicrotask(() => {
            if (own.subscribers.get(id) === subscriber) {
              notify(auctionId, subscriber, last);
            }
          });
        }
      }
      const own = feed;
      return () => {
        own.subscribers.delete(id);
        if (own.subscribers.size === 0) {
          own.controller.abort();
          if (feeds.get(auctionId) === own) feeds.delete(auctionId);
        }
      };
    },
    open: () => feeds.size,
    close() {
      closed = true;
      for (const feed of feeds.values()) feed.controller.abort();
      feeds.clear();
    },
  };
}
