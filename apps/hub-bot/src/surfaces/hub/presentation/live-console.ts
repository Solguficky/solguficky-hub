import type { LiveEditOutcome } from "../../../core/auction/live-cards.js";
import type {
  AuctionWatches,
  AuctionWatchState,
} from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import type { Person } from "../application/types.js";
import { viewerOf } from "../auction/port.js";
import {
  type ConsoleScreenView,
  consoleScreen,
  liveConsole,
} from "./screens/auction-console.js";
import type { ShownScreen } from "./screens/show.js";

// Открытые пульты ведущего (PER-566) — память процесса, то же исключение из
// «хранилища нет» ADR-030, что карточки финала (дополнение 2026-10-19). Пульт
// показывает имя лидера, последние ставки и состав, а поток несёт только
// снимки лотов, поэтому состояние потока здесь — повод перечитать пульт тем
// же чтением, что «Обновить», а не то, что рисуется. Чтение идёт в задаче
// лимитера: залп ставок даёт одно чтение и одну правку в секунду на чат.
// Рестарт память теряет: пульт замирает, а «Обновить» его оживляет.

/** Пульт в показанном сообщении: кто его открыл и что он показывает. */
export type LiveConsoleShown = {
  person: Person;
  view: ConsoleScreenView;
};

/** Открытый пульт: где он и с чем его открыли. */
export type LiveConsoleEntry = {
  chatId: number;
  messageId: number;
  auctionId: string;
  // Ведущий, которым пульт читается вне update: его права проверит Auction.
  person: Person;
  // Последний показанный вид: страница и сортировка следующего чтения и
  // экран для пометки, когда читать нечем.
  view: ConsoleScreenView;
};

/**
 * Чтение пульта вне update. `refused` — пульт больше не открыть: права сняли
 * или аукциона нет; `failed` — Auction не ответил, и экран получает пометку.
 */
export type LiveConsoleRead =
  | { kind: "console"; view: ConsoleScreenView }
  | { kind: "refused" }
  | { kind: "failed" };

export type LiveConsoles = {
  /**
   * Сообщение в чате показало экран. Пульт финала запоминается, прочий экран
   * в том же сообщении вытесняет пульт. Ответ — живо ли сообщение после показа.
   */
  shown(
    chatId: number,
    messageId: number,
    shown: LiveConsoleShown | undefined,
  ): boolean;
  size(): number;
  close(): void;
};

// Пульт открывает ведущий, их на аукцион один-два; предел держит память,
// если пульты открывают чаще, чем закрывают.
export const LIVE_CONSOLES_LIMIT = 200;

type Entry = LiveConsoleEntry & {
  // Версии лотов и активный лот последнего показа: состояние потока, которое
  // их не обгоняет, повода перечитывать не даёт.
  versions: Map<string, number>;
  active: string | undefined;
  // Правка не дошла по незнакомой причине: следующее состояние перечитывает.
  dirty: boolean;
  // На экране пометка обрыва.
  stale: boolean;
  // Поток закрылся сам: после последней правки пульт забывается.
  ended: boolean;
  // Счётчики обрывов потока и показов нажатием: чтение, за время которого
  // поток оборвался, рисует пульт с пометкой, а чтение, которое обогнало
  // нажатие, не правит вовсе — нажатие уже показало свежее.
  breaks: number;
  shows: number;
};

export function createLiveConsoles(options: {
  watches: AuctionWatches;
  limiter: EditLimiter;
  read: (entry: LiveConsoleEntry) => Promise<LiveConsoleRead>;
  edit: (
    entry: LiveConsoleEntry,
    screen: ShownScreen,
  ) => Promise<LiveEditOutcome>;
  limit?: number;
}): LiveConsoles {
  const limit = options.limit ?? LIVE_CONSOLES_LIMIT;
  // Чат → пульт; порядок вставки — порядок свежести для вытеснения.
  const consoles = new Map<number, Entry>();
  const unsubscribe = new Map<number, () => void>();
  const keyOf = (entry: { chatId: number; messageId: number }) =>
    `console:${entry.chatId}:${entry.messageId}`;

  const forget = (chatId: number) => {
    const entry = consoles.get(chatId);
    if (entry === undefined) return;
    consoles.delete(chatId);
    options.limiter.drop(keyOf(entry));
    unsubscribe.get(chatId)?.();
    unsubscribe.delete(chatId);
  };

  const remember = (entry: Entry, view: ConsoleScreenView) => {
    entry.view = view;
    entry.versions = new Map(
      view.console.lots.map((each) => [each.lot.lotId, each.lot.version]),
    );
    entry.active = view.console.lineup?.activeLotId;
    entry.dirty = false;
  };

  // Состояние потока обгоняет показанное: другой активный лот, лот состава
  // новее показанного или аукцион завершён.
  const newer = (entry: Entry, state: AuctionWatchState) =>
    entry.dirty ||
    state.finished ||
    state.activeLot?.lotId !== entry.active ||
    state.lineup.some(
      (lot) => lot.version > (entry.versions.get(lot.lotId) ?? -1),
    );

  // Правка пульта; ответ лимитеру — его исход без «сообщения нет» и
  // незнакомого отказа, которые разбирает реестр.
  const apply = async (entry: Entry, screen: ShownScreen) => {
    const outcome = await options.edit(entry, screen);
    switch (outcome.kind) {
      case "gone":
        if (consoles.get(entry.chatId) === entry) forget(entry.chatId);
        return { kind: "done" as const };
      case "failed":
        entry.dirty = true;
        return { kind: "done" as const };
      default:
        return outcome;
    }
  };

  const reread = (entry: Entry) => {
    options.limiter.submit(entry.chatId, keyOf(entry), async () => {
      if (consoles.get(entry.chatId) !== entry) return { kind: "done" };
      const { breaks, shows } = entry;
      const read = await options
        .read(entry)
        .catch((): LiveConsoleRead => ({ kind: "failed" }));
      if (consoles.get(entry.chatId) !== entry || entry.shows !== shows) {
        return { kind: "done" };
      }
      switch (read.kind) {
        case "refused":
          forget(entry.chatId);
          return { kind: "done" };
        case "failed": {
          entry.stale = true;
          const outcome = await apply(
            entry,
            consoleScreen({ ...entry.view, stale: true }),
          );
          // Поток уже закрылся: нового состояния, которое сняло бы
          // пометку, не будет, и пульт дальше правит только нажатие.
          if (consoles.get(entry.chatId) === entry && entry.ended) {
            forget(entry.chatId);
          }
          return outcome;
        }
        default: {
          entry.stale = entry.breaks !== breaks;
          remember(entry, read.view);
          const outcome = await apply(
            entry,
            consoleScreen(
              entry.stale ? { ...read.view, stale: true } : read.view,
            ),
          );
          // Финал кончился или пульт сменился исходом: дальше пульт правит
          // только нажатие.
          if (
            consoles.get(entry.chatId) === entry &&
            (entry.ended || !liveConsole(read.view))
          ) {
            forget(entry.chatId);
          }
          return outcome;
        }
      }
    });
  };

  // Поток оборвался: пульт говорит, что цена могла устареть, без чтения —
  // Auction, скорее всего, недоступен. Первое состояние после
  // переподключения перечитывает пульт и пометку снимает.
  const interrupted = (entry: Entry) => {
    if (consoles.get(entry.chatId) !== entry) return;
    entry.breaks += 1;
    if (entry.stale) return;
    entry.stale = true;
    options.limiter.submit(entry.chatId, keyOf(entry), async () => {
      if (consoles.get(entry.chatId) !== entry || !entry.stale) {
        return { kind: "done" };
      }
      return apply(entry, consoleScreen({ ...entry.view, stale: true }));
    });
  };

  const onState = (entry: Entry, state: AuctionWatchState) => {
    if (consoles.get(entry.chatId) !== entry) return;
    if (entry.stale || newer(entry, state)) reread(entry);
  };

  // Поток закрылся сам — аукцион завершён или права у всех сняты: пульт
  // перечитывается последний раз и забывается.
  const ended = (entry: Entry) => {
    if (consoles.get(entry.chatId) !== entry) return;
    entry.ended = true;
    unsubscribe.get(entry.chatId)?.();
    unsubscribe.delete(entry.chatId);
    reread(entry);
  };

  return {
    shown(chatId, messageId, shown) {
      const prior = consoles.get(chatId);
      if (shown === undefined || !liveConsole(shown.view)) {
        if (prior?.messageId === messageId) forget(chatId);
        return false;
      }
      const auctionId = shown.view.console.auctionId;
      if (
        prior !== undefined &&
        prior.messageId === messageId &&
        prior.auctionId === auctionId &&
        !prior.ended
      ) {
        // Нажатие показало пульт в живом сообщении: запись берёт то, что
        // ведущий видит сейчас, а поток не переоткрывается.
        prior.person = shown.person;
        prior.stale = false;
        prior.shows += 1;
        remember(prior, shown.view);
        return true;
      }
      const entry: Entry = {
        chatId,
        messageId,
        auctionId,
        person: shown.person,
        view: shown.view,
        versions: new Map(),
        active: undefined,
        dirty: false,
        stale: false,
        ended: false,
        breaks: 0,
        shows: 0,
      };
      remember(entry, shown.view);
      // Новая подписка — до снятия прежней: у аукциона с одним подписчиком
      // поток иначе закрылся бы и открылся заново.
      const leave = options.watches.subscribe(
        auctionId,
        viewerOf(shown.person),
        (state) => onState(entry, state),
        () => ended(entry),
        () => interrupted(entry),
      );
      forget(chatId);
      consoles.set(chatId, entry);
      unsubscribe.set(chatId, leave);
      while (consoles.size > limit) {
        const oldest = consoles.keys().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
      return true;
    },
    size: () => consoles.size,
    close() {
      for (const chatId of [...consoles.keys()]) forget(chatId);
    },
  };
}
