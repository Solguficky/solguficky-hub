import type { LiveEditOutcome } from "../../../core/auction/live-cards.js";
import type {
  AuctionWatches,
  AuctionWatchState,
} from "../../../core/auction/watch.js";
import type { EditLimiter } from "../../../core/bot/edit-limiter.js";
import type { ConsoleSort, Person } from "../application/types.js";
import { viewerOf } from "../auction/port.js";
import type { ShownScreen } from "./screens/show.js";

// Живые экраны хаба, которые перечитываются по потоку `WatchAuction` (PER-565,
// дополнение ADR-030 от 2026-10-20): пульт ведущего (PER-566) и «Ставки зала»
// помощника. Оба показывают то, чего в потоке нет, — имя лидера, последние
// ставки, имена аукциона, — поэтому состояние потока здесь только повод
// перечитать экран тем же чтением, что «Обновить», а не то, что рисуется.
// Чтение идёт в задаче лимитера: залп ставок даёт одно чтение и одну правку
// в секунду на чат. Карточки финала участников (`core/auction/live-cards.ts`)
// рисуются из самого потока и живут своим реестром. Рестарт память теряет, но
// не запись (PER-815, дополнение ADR-030 от 2026-10-29): открытый экран лежит
// ещё и в хранилище вне процесса, и новый процесс после старта читает его,
// перечитывает экран и подписывается на поток заново.

/** Экран в показанном сообщении: кто его открыл и что он показывает. */
export type LiveScreenShown<View> = {
  person: Person;
  view: View;
};

/**
 * Что нужно следующему чтению экрана, кроме самого человека: страница и
 * сортировка, которые он видит. Живёт в записи хранилища, поэтому только
 * значения без структур Telegram и Auction.
 */
export type LiveScreenParams = {
  page: number;
  sort?: ConsoleSort;
  media?: boolean;
};

/** Где экран и с чем его читать: всё, что переживает рестарт. */
export type LiveScreenTarget = {
  chatId: number;
  messageId: number;
  auctionId: string;
  // Человек, которым экран читается вне update: его права проверит Auction.
  person: Person;
  params: LiveScreenParams;
};

/** Открытый экран: цель чтения и последний показанный вид. */
export type LiveScreenEntry<View> = LiveScreenTarget & {
  // Последний показанный вид: экран для пометки, когда читать нечем.
  view: View;
};

/**
 * Запись открытых экранов вне процесса, по одной на чат. Методы не бросают:
 * недоступное хранилище — «записей нет», и экран живёт как без хранилища.
 */
export type LiveScreenStore = {
  save(target: LiveScreenTarget): Promise<void>;
  remove(chatId: number): Promise<void>;
  list(): Promise<readonly LiveScreenTarget[]>;
};

/** Исход восстановления одной записи — для лога, а не для решения. */
export type LiveScreenRestore =
  | { kind: "restored"; chatId: number }
  | { kind: "refused"; chatId: number }
  | { kind: "unreadable"; chatId: number };

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
  /**
   * Читает записи хранилища после старта процесса: каждый экран, которого
   * процесс ещё не показал заново, перечитывается правами его человека,
   * правится и снова слушает поток. Не бросает; ждёт всех записей.
   */
  restore(): Promise<readonly LiveScreenRestore[]>;
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
  // Параметры следующего чтения: страница и сортировка показанного вида.
  params: (view: View) => LiveScreenParams;
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
    read: (target: LiveScreenTarget) => Promise<LiveScreenRead<View>>;
    edit: (
      entry: LiveScreenEntry<View>,
      screen: ShownScreen,
    ) => Promise<LiveEditOutcome>;
    limit: number;
    // Запись вне процесса (PER-815): без неё экран живёт, пока жив процесс.
    store?: LiveScreenStore;
    // Паузы между повторами чтения при восстановлении; тест подменяет.
    restorePauses?: readonly number[];
  },
): LiveScreens<View> {
  // Чат → экран; порядок вставки — порядок свежести для вытеснения.
  const screens = new Map<number, Entry<View>>();
  const unsubscribe = new Map<number, () => void>();
  const keyOf = (entry: { chatId: number; messageId: number }) =>
    `${kind.key}:${entry.chatId}:${entry.messageId}`;

  // Запись лежит по ключу чата: новая запись затирает прежнюю, поэтому
  // вытесняемый новым показом экран из хранилища не снимается, а снимается тот,
  // что кончился. Остановка процесса не снимает ничего — ради этого запись и
  // нужна.
  const forget = (chatId: number, keepRecord = false) => {
    const entry = screens.get(chatId);
    if (entry === undefined) return;
    screens.delete(chatId);
    options.limiter.drop(keyOf(entry));
    unsubscribe.get(chatId)?.();
    unsubscribe.delete(chatId);
    if (!keepRecord) drop(chatId);
  };

  // Записи одного чата идут друг за другом: «снять» старого экрана не должно
  // обогнать «записать» нового, а хранилище и соединение этого не обещают.
  const writes = new Map<number, Promise<void>>();
  const enqueue = (chatId: number, write: () => Promise<void>) => {
    const next = (writes.get(chatId) ?? Promise.resolve())
      .then(write)
      .catch(() => {});
    writes.set(chatId, next);
    void next.then(() => {
      if (writes.get(chatId) === next) writes.delete(chatId);
    });
  };

  const drop = (chatId: number) => {
    const { store } = options;
    if (store !== undefined) enqueue(chatId, () => store.remove(chatId));
  };

  const save = (entry: Entry<View>) => {
    const { store } = options;
    if (store === undefined) return;
    const target: LiveScreenTarget = {
      chatId: entry.chatId,
      messageId: entry.messageId,
      auctionId: entry.auctionId,
      person: entry.person,
      params: entry.params,
    };
    enqueue(entry.chatId, () => store.save(target));
  };

  // Восстановление идёт, пока процесс уже отвечает людям: экран, с которого
  // человек ушёл за это время, возвращать нельзя. Сообщение, в котором нажатие
  // показало не живой экран, помнится до конца восстановления.
  let restoring = false;
  let closed = false;
  const dismissed = new Set<string>();
  const dismissalOf = (chatId: number, messageId: number) =>
    `${chatId}:${messageId}`;

  const remember = (entry: Entry<View>, view: View) => {
    entry.view = view;
    entry.params = kind.params(view);
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

  // Экран встаёт в реестр: подписка на поток, запись в хранилище, предел числа.
  const attach = (
    chatId: number,
    messageId: number,
    person: Person,
    view: View,
  ): Entry<View> => {
    const auctionId = kind.auctionOf(view);
    const entry: Entry<View> = {
      chatId,
      messageId,
      auctionId,
      person,
      params: kind.params(view),
      view,
      versions: new Map(),
      active: undefined,
      dirty: false,
      stale: false,
      ended: false,
      breaks: 0,
      shows: 0,
    };
    remember(entry, view);
    // Новая подписка — до снятия прежней: у аукциона с одним подписчиком
    // поток иначе закрылся бы и открылся заново.
    const leave = options.watches.subscribe(
      auctionId,
      viewerOf(person),
      (state) => onState(entry, state),
      () => ended(entry),
      () => interrupted(entry),
    );
    forget(chatId, true);
    screens.set(chatId, entry);
    unsubscribe.set(chatId, leave);
    save(entry);
    while (screens.size > options.limit) {
      const oldest = screens.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
    return entry;
  };

  const pauses = options.restorePauses ?? [
    2_000, 5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000,
  ];
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    });

  // Запись прошлого процесса: экран читается правами его человека, и
  // прочитанное встаёт в реестр так, будто его только что показали, но уже
  // «грязным» — первая же правка догоняет то, что произошло, пока бота не было.
  // Чтение, которое не удалось, повторяется несколько раз: Auction в этот
  // момент мог стартовать вместе с ботом. Запись остаётся, если экран прочесть
  // так и не вышло, — следующий старт попробует снова, а срок её жизни
  // ограничен хранилищем.
  const restoreOne = async (
    target: LiveScreenTarget,
  ): Promise<LiveScreenRestore> => {
    const { chatId } = target;
    for (let attempt = 0; ; attempt += 1) {
      // Нажатие нового процесса показало экран раньше — оно свежее записи.
      const left = () => {
        if (!dismissed.has(dismissalOf(chatId, target.messageId))) return false;
        drop(chatId);
        return true;
      };
      if (closed) return { kind: "unreadable", chatId };
      if (screens.has(chatId) || left()) return { kind: "restored", chatId };
      const read = await options
        .read(target)
        .catch((): LiveScreenRead<View> => ({ kind: "failed" }));
      if (closed) return { kind: "unreadable", chatId };
      if (screens.has(chatId) || left()) return { kind: "restored", chatId };
      if (read.kind === "refused") {
        drop(chatId);
        return { kind: "refused", chatId };
      }
      if (read.kind === "view") {
        // Финал кончился, пока бота не было: сообщение всё ещё показывает
        // прошлое, поэтому и не живой вид правится, а уже потом забывается —
        // его забывает само перечитывание.
        const entry = attach(
          chatId,
          target.messageId,
          target.person,
          read.view,
        );
        // Сообщение показывает прошлое, а чтение выше уже свежее: правка.
        entry.dirty = true;
        reread(entry);
        return { kind: "restored", chatId };
      }
      const wait = pauses[attempt];
      if (wait === undefined) return { kind: "unreadable", chatId };
      await pause(wait);
    }
  };

  return {
    shown(chatId, messageId, shown) {
      const prior = screens.get(chatId);
      if (shown === undefined || !kind.live(shown.view)) {
        if (prior?.messageId === messageId) forget(chatId);
        if (restoring) dismissed.add(dismissalOf(chatId, messageId));
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
        save(prior);
        return true;
      }
      attach(chatId, messageId, shown.person, shown.view);
      return true;
    },
    async restore() {
      restoring = true;
      try {
        const targets = await (options.store?.list() ?? Promise.resolve([]));
        return await Promise.all(targets.map(restoreOne));
      } finally {
        restoring = false;
        dismissed.clear();
      }
    },
    size: () => screens.size,
    close() {
      closed = true;
      for (const chatId of [...screens.keys()]) forget(chatId, true);
    },
  };
}
