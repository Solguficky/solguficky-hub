import type { LiveEditOutcome } from "../../../core/auction/live-cards.js";
import type {
  AuctionWatches,
  AuctionWatchState,
} from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import type { Person } from "../application/types.js";
import { viewerOf } from "../auction/port.js";
import type { ShownScreen } from "./screens/show.js";

// Живые экраны хаба, которые перечитываются по потоку `WatchAuction` (PER-565,
// дополнение ADR-030 от 2026-10-20): пульт ведущего (PER-566) и «Ставки зала»
// помощника. Оба показывают то, чего в потоке нет, — имя лидера, последние
// ставки, имена аукциона, — поэтому состояние потока здесь только повод
// перечитать экран тем же чтением, что «Обновить», а не то, что рисуется.
// Чтение идёт в задаче лимитера: залп ставок даёт одно чтение и одну правку
// в секунду на чат. Карточки финала участников (`core/auction/live-cards.ts`)
// рисуются из самого потока и живут своим реестром. Рестарт память теряет:
// экран замирает, а «Обновить» или любая его кнопка его оживляет.

/** Экран в показанном сообщении: кто его открыл и что он показывает. */
export type LiveScreenShown<View> = {
  person: Person;
  view: View;
};

/** Открытый экран: где он и с чем его открыли. */
export type LiveScreenEntry<View> = {
  chatId: number;
  messageId: number;
  auctionId: string;
  // Человек, которым экран читается вне update: его права проверит Auction.
  person: Person;
  // Последний показанный вид: параметры следующего чтения и экран для
  // пометки, когда читать нечем.
  view: View;
};

/**
 * Чтение экрана вне update. `refused` — экран больше не открыть: права сняли
 * или аукциона нет; `failed` — Auction не ответил, и экран получает пометку.
 */
export type LiveScreenRead<View> =
  | { kind: "view"; view: View }
  | { kind: "refused" }
  | { kind: "failed" };

export type LiveScreens<View> = {
  /**
   * Сообщение в чате показало экран. Живой экран запоминается, прочий экран
   * в том же сообщении его вытесняет. Ответ — живо ли сообщение после показа.
   */
  shown(
    chatId: number,
    messageId: number,
    shown: LiveScreenShown<View> | undefined,
  ): boolean;
  size(): number;
  close(): void;
};

/**
 * Что механизм знает о виде экрана: живой ли он, какого он аукциона и что
 * показал — версии лотов и активный лот, с которыми сравнивается состояние
 * потока, — и как нарисовать его, в том числе с пометкой обрыва.
 */
export type LiveScreenKind<View> = {
  // Префикс ключа лимитера: у экранов одного сообщения ключи не совпадают.
  key: string;
  live: (view: View) => boolean;
  auctionOf: (view: View) => string;
  versions: (view: View) => ReadonlyMap<string, number>;
  active: (view: View) => string | undefined;
  render: (view: View, stale: boolean) => ShownScreen;
};

type Entry<View> = LiveScreenEntry<View> & {
  // Версии лотов и активный лот последнего показа: состояние потока, которое
  // их не обгоняет, повода перечитывать не даёт.
  versions: ReadonlyMap<string, number>;
  active: string | undefined;
  // Правка не дошла по незнакомой причине: следующее состояние перечитывает.
  dirty: boolean;
  // На экране пометка обрыва.
  stale: boolean;
  // Поток закрылся сам: после последней правки экран забывается.
  ended: boolean;
  // Счётчики обрывов потока и показов нажатием: чтение, за время которого
  // поток оборвался, рисует экран с пометкой, а чтение, которое обогнало
  // нажатие, не правит вовсе — нажатие уже показало свежее.
  breaks: number;
  shows: number;
};

export function createLiveScreens<View>(
  kind: LiveScreenKind<View>,
  options: {
    watches: AuctionWatches;
    limiter: EditLimiter;
    read: (entry: LiveScreenEntry<View>) => Promise<LiveScreenRead<View>>;
    edit: (
      entry: LiveScreenEntry<View>,
      screen: ShownScreen,
    ) => Promise<LiveEditOutcome>;
    limit: number;
  },
): LiveScreens<View> {
  // Чат → экран; порядок вставки — порядок свежести для вытеснения.
  const screens = new Map<number, Entry<View>>();
  const unsubscribe = new Map<number, () => void>();
  const keyOf = (entry: { chatId: number; messageId: number }) =>
    `${kind.key}:${entry.chatId}:${entry.messageId}`;

  const forget = (chatId: number) => {
    const entry = screens.get(chatId);
    if (entry === undefined) return;
    screens.delete(chatId);
    options.limiter.drop(keyOf(entry));
    unsubscribe.get(chatId)?.();
    unsubscribe.delete(chatId);
  };

  const remember = (entry: Entry<View>, view: View) => {
    entry.view = view;
    entry.versions = kind.versions(view);
    entry.active = kind.active(view);
    entry.dirty = false;
  };

  // Состояние потока обгоняет показанное: другой активный лот, лот состава
  // новее показанного или аукцион завершён.
  const newer = (entry: Entry<View>, state: AuctionWatchState) =>
    entry.dirty ||
    state.finished ||
    state.activeLot?.lotId !== entry.active ||
    state.lineup.some(
      (lot) => lot.version > (entry.versions.get(lot.lotId) ?? -1),
    );

  // Правка экрана; ответ лимитеру — её исход без «сообщения нет» и
  // незнакомого отказа, которые разбирает реестр.
  const apply = async (entry: Entry<View>, screen: ShownScreen) => {
    const outcome = await options.edit(entry, screen);
    switch (outcome.kind) {
      case "gone":
        if (screens.get(entry.chatId) === entry) forget(entry.chatId);
        return { kind: "done" as const };
      case "failed":
        entry.dirty = true;
        return { kind: "done" as const };
      default:
        return outcome;
    }
  };

  const reread = (entry: Entry<View>) => {
    options.limiter.submit(entry.chatId, keyOf(entry), async () => {
      if (screens.get(entry.chatId) !== entry) return { kind: "done" };
      const { breaks, shows } = entry;
      const read = await options
        .read(entry)
        .catch((): LiveScreenRead<View> => ({ kind: "failed" }));
      if (screens.get(entry.chatId) !== entry || entry.shows !== shows) {
        return { kind: "done" };
      }
      switch (read.kind) {
        case "refused":
          forget(entry.chatId);
          return { kind: "done" };
        case "failed": {
          entry.stale = true;
          const outcome = await apply(entry, kind.render(entry.view, true));
          // Поток уже закрылся: нового состояния, которое сняло бы
          // пометку, не будет, и экран дальше правит только нажатие.
          if (screens.get(entry.chatId) === entry && entry.ended) {
            forget(entry.chatId);
          }
          return outcome;
        }
        default: {
          entry.stale = entry.breaks !== breaks;
          remember(entry, read.view);
          const outcome = await apply(
            entry,
            kind.render(read.view, entry.stale),
          );
          // Финал кончился или экран сменился исходом: дальше экран правит
          // только нажатие.
          if (
            screens.get(entry.chatId) === entry &&
            (entry.ended || !kind.live(read.view))
          ) {
            forget(entry.chatId);
          }
          return outcome;
        }
      }
    });
  };

  // Поток оборвался: экран говорит, что цена могла устареть, без чтения —
  // Auction, скорее всего, недоступен. Первое состояние после
  // переподключения перечитывает экран и пометку снимает.
  const interrupted = (entry: Entry<View>) => {
    if (screens.get(entry.chatId) !== entry) return;
    entry.breaks += 1;
    if (entry.stale) return;
    entry.stale = true;
    options.limiter.submit(entry.chatId, keyOf(entry), async () => {
      if (screens.get(entry.chatId) !== entry || !entry.stale) {
        return { kind: "done" };
      }
      return apply(entry, kind.render(entry.view, true));
    });
  };

  const onState = (entry: Entry<View>, state: AuctionWatchState) => {
    if (screens.get(entry.chatId) !== entry) return;
    if (entry.stale || newer(entry, state)) reread(entry);
  };

  // Поток закрылся сам — аукцион завершён или права у всех сняты: экран
  // перечитывается последний раз и забывается.
  const ended = (entry: Entry<View>) => {
    if (screens.get(entry.chatId) !== entry) return;
    entry.ended = true;
    unsubscribe.get(entry.chatId)?.();
    unsubscribe.delete(entry.chatId);
    reread(entry);
  };

  return {
    shown(chatId, messageId, shown) {
      const prior = screens.get(chatId);
      if (shown === undefined || !kind.live(shown.view)) {
        if (prior?.messageId === messageId) forget(chatId);
        return false;
      }
      const auctionId = kind.auctionOf(shown.view);
      if (
        prior !== undefined &&
        prior.messageId === messageId &&
        prior.auctionId === auctionId &&
        !prior.ended
      ) {
        // Нажатие показало экран в живом сообщении: запись берёт то, что
        // человек видит сейчас, а поток не переоткрывается.
        prior.person = shown.person;
        prior.stale = false;
        prior.shows += 1;
        remember(prior, shown.view);
        return true;
      }
      const entry: Entry<View> = {
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
      screens.set(chatId, entry);
      unsubscribe.set(chatId, leave);
      while (screens.size > options.limit) {
        const oldest = screens.keys().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
      return true;
    },
    size: () => screens.size,
    close() {
      for (const chatId of [...screens.keys()]) forget(chatId);
    },
  };
}
