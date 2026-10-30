import {
  broadcastFinishedText,
  broadcastLeaderOf,
  broadcastText,
  watchStoppedLine,
} from "../../auction-broadcast.js";
import type { AuctionPort, LotView, Viewer } from "../../auction-ui/index.js";
import type { EditLimiter } from "../bot/edit-limiter.js";
import { cachedNames, type LiveEditOutcome } from "./live-cards.js";
import type { AuctionWatches, AuctionWatchState } from "./watch.js";

// Трансляция хода торгов живого финала (PER-826, дополнение ADR-040 от
// 2026-10-29): одно сообщение подписавшегося участника, которое бот правит на
// каждую ставку. Подписка — кнопка «Следить за торгами» на карточке лота
// финала; без неё бот молчит. Сообщение рисуется из самого потока
// `WatchAuction`, как карточка финала, а правка идёт фоновой полосой лимитера:
// десятки подписчиков не задерживают карточки и пульт. Запись открытой
// трансляции лежит ещё и в хранилище вне процесса (PER-815): новый процесс
// читает её, подписывается на поток заново и правит то же сообщение.

/** Где трансляция и чьими правами её читать: всё, что переживает рестарт. */
export type BroadcastTarget = {
  chatId: number;
  messageId: number;
  auctionId: string;
  viewer: Viewer;
};

/** Запись открытых трансляций по одной на чат. Методы не бросают. */
export type BroadcastStore = {
  save(target: BroadcastTarget): Promise<void>;
  remove(chatId: number): Promise<void>;
  list(): Promise<readonly BroadcastTarget[]>;
};

/** Telegram-сторона трансляции: сообщение отправляет и правит поверхность. */
export type BroadcastApi = {
  /** Первое сообщение, со звуком один раз; ответ — его номер или отказ. */
  send(input: { chatId: number; text: string }): Promise<number | undefined>;
  /** Правка без звука; `final` — кнопку «Не следить» снять. */
  edit(
    target: BroadcastTarget,
    input: { text: string; final: boolean },
  ): Promise<LiveEditOutcome>;
};

export type LiveBroadcasts = {
  /**
   * Подписка: поток аукциона и первое сообщение по его первому состоянию.
   * Повторное нажатие на ту же трансляцию второго сообщения не шлёт.
   */
  start(input: {
    chatId: number;
    auctionId: string;
    viewer: Viewer;
  }): Promise<void>;
  /** «Не следить»: трансляция снимается, сообщение получает последнюю правку. */
  stop(chatId: number): Promise<void>;
  /** Читает записи хранилища после старта и продолжает правкой тех же сообщений. */
  restore(): Promise<number>;
  size(): number;
  close(): void;
};

// Предел держит память процесса: на финал приходят десятки участников.
export const LIVE_BROADCASTS_LIMIT = 2_000;

type Entry = {
  chatId: number;
  auctionId: string;
  viewer: Viewer;
  // Нет, пока первое сообщение не ушло.
  messageId: number | undefined;
  // Лот, за которым идёт сообщение: между лотами оно показывает его итог.
  lotId: string | undefined;
  latest: AuctionWatchState | undefined;
  // Текст последней доставленной правки: тот же текст повторно не правится.
  lastText: string | undefined;
  leave: () => void;
};

export function createLiveBroadcasts(options: {
  watches: AuctionWatches;
  limiter: EditLimiter;
  names: Pick<AuctionPort, "getDisplayNames">;
  api: BroadcastApi;
  store?: BroadcastStore;
  // Время сообщества для «Обновлено в ЧЧ:ММ:СС».
  timeZone: string;
  now?: () => Date;
  limit?: number;
  // Отказ первого сообщения или чтения имён, которых поверхность не ждёт.
  onError?: (cause: unknown) => void;
}): LiveBroadcasts {
  const limit = options.limit ?? LIVE_BROADCASTS_LIMIT;
  const names = cachedNames(options.names);
  const now = options.now ?? (() => new Date());
  const entries = new Map<number, Entry>();
  const sending = new Set<Entry>();
  const keyOf = (entry: Entry) => `bc:${entry.chatId}:${entry.messageId}`;
  const clock = () =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: options.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(now());

  const forget = (entry: Entry) => {
    if (entries.get(entry.chatId) !== entry) return;
    entries.delete(entry.chatId);
    options.limiter.drop(keyOf(entry));
    entry.leave();
    void options.store?.remove(entry.chatId);
  };

  const lotOf = (entry: Entry): LotView | undefined => {
    const state = entry.latest;
    if (state === undefined) return undefined;
    const lot =
      state.activeLot ??
      state.lineup.find((each) => each.lotId === entry.lotId);
    if (lot !== undefined) entry.lotId = lot.lotId;
    return lot;
  };

  // Имя лидера или победителя читается правами подписчика; сбой чтения имён
  // не роняет трансляцию, а называет участника без имени.
  const textOf = async (entry: Entry): Promise<string> => {
    const state = entry.latest;
    if (state?.finished === true) return broadcastFinishedText(clock());
    const lot = lotOf(entry);
    const status = lot?.status;
    const personId =
      status?.kind === "trading" || status?.kind === "held"
        ? status.leaderId
        : status?.kind === "sold"
          ? status.winnerId
          : undefined;
    let name: string | undefined;
    if (personId !== undefined && personId !== entry.viewer.identityId) {
      try {
        name = (
          await names.getDisplayNames({
            viewer: entry.viewer,
            auctionId: entry.auctionId,
            participantIds: [personId],
          })
        )[personId];
      } catch (cause) {
        options.onError?.(cause);
      }
    }
    const person = broadcastLeaderOf({
      leaderId: personId,
      viewerId: entry.viewer.identityId,
      name,
    });
    return broadcastText({
      lot,
      leader: status?.kind === "sold" ? { kind: "none" } : person,
      winner: status?.kind === "sold" ? person : { kind: "none" },
      updatedAt: clock(),
    });
  };

  const schedule = (entry: Entry) => {
    if (entry.messageId === undefined) return;
    const target: BroadcastTarget = {
      chatId: entry.chatId,
      messageId: entry.messageId,
      auctionId: entry.auctionId,
      viewer: entry.viewer,
    };
    options.limiter.submit(
      entry.chatId,
      keyOf(entry),
      async () => {
        if (entries.get(entry.chatId) !== entry) return { kind: "done" };
        const finished = entry.latest?.finished === true;
        const text = await textOf(entry);
        if (entries.get(entry.chatId) !== entry) return { kind: "done" };
        // «Обновлено в» меняется каждую секунду: сравнивается текст без неё.
        if (!finished && sameBody(text, entry.lastText)) {
          return { kind: "done" };
        }
        const outcome = await options.api.edit(target, {
          text,
          final: finished,
        });
        switch (outcome.kind) {
          case "gone":
            forget(entry);
            return { kind: "done" };
          case "failed":
            // Правка не дошла: следующее состояние потока правит заново.
            entry.lastText = undefined;
            return { kind: "done" };
          case "retry-after":
            return outcome;
          default:
            entry.lastText = text;
            if (finished) forget(entry);
            return { kind: "done" };
        }
      },
      "background",
    );
  };

  // Первое сообщение уходит по первому состоянию потока: пустую трансляцию
  // человек не получает. Пока оно в пути, состояния только запоминаются.
  const onState = async (entry: Entry, state: AuctionWatchState) => {
    if (entries.get(entry.chatId) !== entry) return;
    entry.latest = state;
    if (entry.messageId !== undefined) {
      schedule(entry);
      return;
    }
    if (sending.has(entry)) return;
    sending.add(entry);
    try {
      const text = await textOf(entry);
      const messageId = await options.api.send({
        chatId: entry.chatId,
        text,
      });
      if (entries.get(entry.chatId) !== entry) return;
      if (messageId === undefined) {
        forget(entry);
        return;
      }
      entry.messageId = messageId;
      entry.lastText = text;
      await options.store?.save({
        chatId: entry.chatId,
        messageId,
        auctionId: entry.auctionId,
        viewer: entry.viewer,
      });
      // Состояние, пришедшее за время отправки, правит сообщение.
      if (entry.latest !== state || state.finished) schedule(entry);
    } catch (cause) {
      options.onError?.(cause);
      forget(entry);
    } finally {
      sending.delete(entry);
    }
  };

  const open = (input: {
    chatId: number;
    auctionId: string;
    viewer: Viewer;
    messageId?: number;
  }) => {
    const entry: Entry = {
      chatId: input.chatId,
      auctionId: input.auctionId,
      viewer: input.viewer,
      messageId: input.messageId,
      lotId: undefined,
      latest: undefined,
      lastText: undefined,
      leave: () => {},
    };
    // Подписка до снятия прежней: у аукциона с одним подписчиком поток иначе
    // закрылся бы и открылся заново.
    entry.leave = options.watches.subscribe(
      input.auctionId,
      input.viewer,
      (state) => {
        void onState(entry, state);
      },
      () => forget(entry),
    );
    const prior = entries.get(input.chatId);
    entries.set(input.chatId, entry);
    if (prior !== undefined) {
      options.limiter.drop(keyOf(prior));
      prior.leave();
    }
    while (entries.size > limit) {
      const oldest = entries.values().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
  };

  const stop = async (chatId: number) => {
    const entry = entries.get(chatId);
    if (entry === undefined) return;
    const { messageId } = entry;
    forget(entry);
    if (messageId === undefined) return;
    await options.api
      .edit(
        {
          chatId,
          messageId,
          auctionId: entry.auctionId,
          viewer: entry.viewer,
        },
        { text: watchStoppedLine, final: true },
      )
      .catch(() => undefined);
  };

  return {
    async start(input) {
      const prior = entries.get(input.chatId);
      // Та же трансляция уже идёт: второго сообщения нет.
      if (prior !== undefined && prior.auctionId === input.auctionId) return;
      await stop(input.chatId);
      open(input);
    },
    stop,
    async restore() {
      const targets = (await options.store?.list()) ?? [];
      for (const target of targets) {
        // Нажатие нового процесса, успевшее раньше, свежее записи.
        if (entries.has(target.chatId)) continue;
        open(target);
      }
      return targets.length;
    },
    size: () => entries.size,
    close() {
      for (const entry of [...entries.values()]) {
        entries.delete(entry.chatId);
        options.limiter.drop(keyOf(entry));
        entry.leave();
      }
    },
  };
}

// Тело текста без последней строки «Обновлено в …».
function sameBody(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const body = (text: string) => text.split("\n").slice(0, -1).join("\n");
  return body(a) === body(b);
}
