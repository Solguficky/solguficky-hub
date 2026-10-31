import { GrammyError, HttpError } from "grammy";
import {
  type AuctionPort,
  type AuctionScreenBody,
  encodeAuctionCallback,
  type FinalBidOutcome,
  type LotView,
  liveLot,
  type Money,
  parseAuctionCallback,
  type Viewer,
} from "../../auction-ui/index.js";
import type { EditLimiter, EditOutcome } from "../bot/edit-limiter.js";
import type { AuctionWatches, AuctionWatchState } from "./watch.js";

// Открытые карточки финала участников (PER-336) — память процесса, четвёртое
// исключение из «хранилища нет» ADR-030 (дополнение 2026-10-12). Карточка
// привязана к аукциону, а не к лоту: она идёт за активным лотом финала, а
// между лотами показывает итог своего лота из состава. Рестарт память теряет:
// карточки замирают, но их кнопка работает — нажатие ставит или отказывает с
// новой ценой и снова оживляет карточку.
//
// Карточка в слежении (PER-837, дополнение ADR-030 от 2026-10-30) — та же
// карточка, которую участник включил кнопкой «Следить за торгами»: запись о
// ней лежит ещё и в хранилище вне процесса, новый процесс читает её,
// подписывается на поток заново и правит то же сообщение, а в конце финала
// карточка пишет «Аукцион завершён». Правки слежения идут фоновой полосой
// лимитера: десятки следящих не задерживают пульт и ставки.

/** Открытая карточка: где она и с чем её открыли. */
export type LiveCardEntry = {
  chatId: number;
  messageId: number;
  auctionId: string;
  // Лот и версия, которые карточка показывает или вот-вот покажет.
  lotId: string;
  version: number;
  // Смотрящий, которого шлюз пустил, когда карточку открывали: его правами
  // поверхность читает имена, им же открывается поток.
  viewer: Viewer;
  page: number;
  // Отметка избранного лота, на котором карточку показали: Notifications на
  // каждую цену не спрашивается, а на другом лоте отметка не та.
  following?: { lotId: string; value: boolean };
  // Свой лимит смотрящего на том же лоте: поток лимитов не несёт, а без
  // строки лимит пропадал бы с карточки на первой правке.
  proxyLimit?: { lotId: string; amount: Money };
  // Исход ставки на нажатие участника (PER-835, PER-837): правка по потоку
  // иначе стирала бы «принята» и «цена ушла» с карточки. Живёт до следующего
  // показа карточки этому чату.
  priceMoved?: { lotId: string; outcome: FinalBidOutcome };
  // Поколение правки: показ ответа сбрасывает in-flight правку потока, чтобы
  // она не шла наперегонки с deliver и не затирала исход ставки.
  revision?: number;
  // Карточка в слежении: запись о ней лежит в хранилище, а на карточке стоит
  // «Не следить».
  watching?: true;
  // Финал кончился, и последняя правка карточки в пути: поток закрылся, а
  // правку это не отменяет.
  ending?: true;
};

/** Карточка в слежении так, как она переживает рестарт процесса. */
export type WatchTarget = {
  chatId: number;
  messageId: number;
  auctionId: string;
  lotId: string;
  page: number;
  viewer: Viewer;
};

/** Запись слежений по одной на чат. Методы не бросают. */
export type WatchStore = {
  save(target: WatchTarget): Promise<void>;
  remove(chatId: number): Promise<void>;
  list(): Promise<readonly WatchTarget[]>;
};

/**
 * Исход правки на стороне Telegram: `gone` — сообщения больше нет; `failed` —
 * эта правка не дошла по незнакомой причине, и следующее состояние потока
 * правит карточку заново, даже если оно то же.
 */
export type LiveEditOutcome =
  | EditOutcome
  | { kind: "gone" }
  | { kind: "failed" };

export type LiveCardEdit = (
  card: LiveCardEntry,
  body: AuctionScreenBody,
) => Promise<LiveEditOutcome>;

/**
 * Карточка лота в показанном экране. `live` — лот торгуется в живом финале:
 * такая карточка заводится в реестре. Карточка лота того же аукциона без
 * пометки — проданный лот между лотами, «Обновить», отметка избранного — в
 * сообщении, которое уже живое, его не гасит: финал идёт дальше.
 */
export type LiveCardShown = {
  auctionId: string;
  lotId: string;
  version: number;
  viewer: Viewer;
  live: boolean;
  // Страница ленты кнопок карточки; есть только у карточки финала.
  page?: number;
  following?: boolean;
  proxyLimit?: Money;
  priceMoved?: FinalBidOutcome;
  // Нажатие «Следить за торгами» или «Не следить» (PER-837).
  watch?: "start" | "stop";
  // Показанная карточка стоит в слежении: на ней «Не следить».
  watching?: boolean;
};

export type LiveCards = {
  /**
   * Сообщение в чате показало экран. Карточка финала запоминается, прочий
   * экран в том же сообщении вытесняет карточку: экран сменили, и правка по
   * потоку вернула бы карточку поверх него. Ответ — живо ли сообщение после
   * показа.
   */
  shown(
    chatId: number,
    messageId: number,
    card: LiveCardShown | undefined,
  ): boolean;
  /**
   * Читает записи слежений после старта и продолжает правкой тех же карточек.
   * Ответ — сколько записей прочитано.
   */
  restore(): Promise<number>;
  /** Чат уже в слежении: ответ ставки и «Обновить» должны оставить «Не следить». */
  watching(chatId: number): boolean;
  /**
   * WatchAuction не несёт принятого лимита: кэширует его у открытой карточки
   * и перерисовывает её из последнего состояния потока.
   */
  proxyLimitSet(input: { chatId: number; lotId: string; amount: Money }): void;
  size(): number;
  close(): void;
};

// Предел держит память процесса: на финал приходят десятки участников, а
// одна карточка на чат — новая вытесняет прежнюю.
export const LIVE_CARDS_LIMIT = 2_000;
// Имена участников: лидер меняется на каждой ставке, а имя — нет.
const NAMES_LIMIT = 1_000;
// Обрыв соединения с Telegram: та же правка повторяется после паузы.
const NETWORK_RETRY_MS = 1_000;

export function createLiveCards(options: {
  watches: AuctionWatches;
  limiter: EditLimiter;
  // Имена участников правами карточки; отказ гасит `liveLot`, как у карточки.
  names: Pick<AuctionPort, "getDisplayNames">;
  edit: LiveCardEdit;
  // Хранилище слежений; без него слежение живёт, пока жив процесс.
  store?: WatchStore;
  limit?: number;
}): LiveCards {
  const limit = options.limit ?? LIVE_CARDS_LIMIT;
  // Чат → карточка; порядок вставки — порядок свежести для вытеснения.
  const cards = new Map<number, LiveCardEntry>();
  const unsubscribe = new Map<number, () => void>();
  const names = cachedNames(options.names);
  const keyOf = (card: { chatId: number; messageId: number }) =>
    `${card.chatId}:${card.messageId}`;

  // Сообщения, слежение за которыми снято раньше, чем их прочитало
  // восстановление: запись, прочитанная до снятия, их не оживляет.
  const released = new Set<string>();
  // Лот, под которым лежит запись карточки: запись правится, когда карточка
  // перешла на другой.
  const saved = new Map<number, string>();

  const targetOf = (card: LiveCardEntry): WatchTarget => ({
    chatId: card.chatId,
    messageId: card.messageId,
    auctionId: card.auctionId,
    lotId: card.lotId,
    page: card.page,
    viewer: card.viewer,
  });

  const writeGen = new Map<number, number>();
  const bumpWrite = (chatId: number) => {
    const next = (writeGen.get(chatId) ?? 0) + 1;
    writeGen.set(chatId, next);
    return next;
  };

  const persist = (card: LiveCardEntry) => {
    if (card.watching !== true || options.store === undefined) return;
    if (saved.get(card.chatId) === card.lotId) return;
    saved.set(card.chatId, card.lotId);
    const gen = bumpWrite(card.chatId);
    const target = targetOf(card);
    void options.store.save(target).then(() => {
      if (writeGen.get(card.chatId) === gen) return;
      const now = cards.get(card.chatId);
      if (now?.watching !== true) void options.store?.remove(card.chatId);
      else if (now.lotId !== target.lotId) {
        saved.delete(now.chatId);
        persist(now);
      }
    });
  };

  // `keepRecord` — на месте карточки встаёт другая: её запись перепишет
  // ключ чата, а снятие шло бы с ней наперегонки.
  const forget = (chatId: number, keepRecord = false) => {
    const card = cards.get(chatId);
    if (card === undefined) return;
    cards.delete(chatId);
    latest.delete(chatId);
    options.limiter.drop(keyOf(card));
    unsubscribe.get(chatId)?.();
    unsubscribe.delete(chatId);
    saved.delete(chatId);
    const gen = bumpWrite(chatId);
    if (card.watching === true && !keepRecord) {
      released.add(keyOf(card));
      void options.store?.remove(chatId).then(() => {
        if (writeGen.get(chatId) === gen) return;
        const now = cards.get(chatId);
        if (now?.watching === true) {
          saved.delete(chatId);
          persist(now);
        }
      });
    }
  };

  // Правка ещё нужна: карточку не сменили и не показали новее, пока правка
  // ждала очереди или имени, и показ ответа её не сбросил.
  const current = (
    card: LiveCardEntry,
    target: { lotId: string; version: number; revision: number },
  ) =>
    cards.get(card.chatId) === card &&
    card.lotId === target.lotId &&
    card.version === target.version &&
    card.revision === target.revision;

  // Последнее состояние потока у карточки: им карточка возвращается к
  // правде, если ответ на нажатие отрисовал лот старее того, что поток уже
  // показал.
  const latest = new Map<number, AuctionWatchState>();

  const lotOf = (card: LiveCardEntry, state: AuctionWatchState) =>
    state.activeLot ?? state.lineup.find((each) => each.lotId === card.lotId);

  const schedule = (card: LiveCardEntry, lot: LotView) => {
    const { chatId } = card;
    // Ответ принадлежит лоту, на котором дан: уйдя с него, карточка его теряет.
    if (card.priceMoved?.lotId !== lot.lotId) delete card.priceMoved;
    card.lotId = lot.lotId;
    card.version = lot.version;
    card.revision = (card.revision ?? 0) + 1;
    persist(card);
    const target = {
      lotId: lot.lotId,
      version: lot.version,
      revision: card.revision,
    };
    const shownLot = withProxyLimit(lot, card.proxyLimit);
    const edit = async (): Promise<EditOutcome> => {
      if (!current(card, target)) return { kind: "done" };
      const following =
        card.following?.lotId === lot.lotId ? card.following.value : undefined;
      const body = await liveLot({
        auction: names,
        viewer: card.viewer,
        lot: shownLot,
        page: card.page,
        ...(following === undefined ? {} : { following }),
        ...(card.priceMoved?.lotId === lot.lotId
          ? { finalBid: card.priceMoved.outcome }
          : {}),
        ...(card.watching === true ? { watching: true } : {}),
        ...(card.ending === true ? { ended: true } : {}),
      });
      if (!current(card, target)) return { kind: "done" };
      const outcome = await options.edit(card, body);
      switch (outcome.kind) {
        case "gone":
          if (cards.get(chatId) === card) forget(chatId);
          return { kind: "done" };
        case "failed":
          // Цена не дошла: следующее состояние потока правит заново, а после
          // конца финала следующего не будет.
          if (current(card, target)) card.version = 0;
          if (card.ending === true && cards.get(chatId) === card) {
            forget(chatId);
          }
          return { kind: "done" };
        case "retry-after":
          return outcome;
        default:
          // Последняя правка слежения ушла: карточку больше никто не ведёт.
          if (card.ending === true && cards.get(chatId) === card) {
            forget(chatId);
          }
          return outcome;
      }
    };
    if (card.watching === true) {
      options.limiter.submit(chatId, keyOf(card), edit, "background");
    } else {
      options.limiter.submit(chatId, keyOf(card), edit);
    }
  };

  const onState = (chatId: number, state: AuctionWatchState) => {
    const card = cards.get(chatId);
    if (card === undefined) return;
    latest.set(chatId, state);
    const lot = lotOf(card, state);
    // Конец финала у слежения: последняя правка пишет «Аукцион завершён», а
    // потом карточку никто не ведёт. Показать нечего — запись просто снимается.
    if (state.finished && card.watching === true) {
      if (lot === undefined) {
        forget(chatId);
        return;
      }
      card.ending = true;
      schedule(card, lot);
      return;
    }
    // Лота нет ни в торгах, ни в составе — показать нечего, карточка ждёт.
    if (lot === undefined) return;
    // Версия лота растёт с каждым его фактом: поток, отставший от чтения по
    // нажатию, карточку назад не откатывает.
    if (lot.lotId === card.lotId && lot.version <= card.version) return;
    schedule(card, lot);
  };

  // Нажатие показало лот того же аукциона в живом сообщении: запись берёт
  // то, что человек видит сейчас, а поток не переоткрывается. Ответ на
  // нажатие мог отрисовать лот старее того, что поток уже показал, — тогда
  // карточка снова получает последнее состояние потока.
  const refresh = (card: LiveCardEntry, shown: LiveCardShown) => {
    card.lotId = shown.lotId;
    card.version = shown.version;
    card.viewer = shown.viewer;
    if (shown.page !== undefined) card.page = shown.page;
    if (shown.following !== undefined) {
      card.following = { lotId: shown.lotId, value: shown.following };
    }
    if (shown.proxyLimit !== undefined) {
      card.proxyLimit = { lotId: shown.lotId, amount: shown.proxyLimit };
    }
    // Каждый показ заменяет прежний ответ: ставка, «Обновить» или другой лот.
    if (shown.priceMoved === undefined) delete card.priceMoved;
    else card.priceMoved = { lotId: shown.lotId, outcome: shown.priceMoved };
    applyWatch(card, shown);
    // Показ ответа уже правит сообщение: ждущая и in-flight правка потока
    // того же message_id иначе идёт с ним наперегонки (`429`).
    card.revision = (card.revision ?? 0) + 1;
    options.limiter.drop(keyOf(card));
    const state = latest.get(card.chatId);
    const lot = state === undefined ? undefined : lotOf(card, state);
    // Карточка в слежении, а показ принёс её без «Не следить» — ответ на
    // ставку или «Обновить» рисует дерево, которое о слежении не знает:
    // правка возвращает кнопку, даже если цена та же. Исход ставки
    // (`priceMoved`) уходит в `liveLot`, чтобы «принята» не стёрлась.
    const unmarked = card.watching === true && shown.watching !== true;
    if (
      lot !== undefined &&
      (lot.lotId !== shown.lotId ||
        lot.version > shown.version ||
        (unmarked && lot.version === shown.version))
    ) {
      schedule(card, lot);
    }
  };

  // Нажатие включило слежение: запись следует за карточкой.
  const applyWatch = (card: LiveCardEntry, shown: LiveCardShown) => {
    if (shown.watch === "start" && card.watching !== true) {
      card.watching = true;
      released.delete(keyOf(card));
      persist(card);
    }
  };

  // Новая подписка — до снятия прежней: у аукциона с одним подписчиком поток
  // иначе закрылся бы и открылся заново. `keepRecord` — запись прежней карточки
  // перепишет запись новой, и снятие шло бы с ней наперегонки.
  const open = (card: LiveCardEntry, keepRecord = false) => {
    const { chatId } = card;
    const leave = options.watches.subscribe(
      card.auctionId,
      card.viewer,
      (state) => onState(chatId, state),
      () => {
        // Поток кончился с последним состоянием финала: правка слежения уже
        // в очереди и сама снимет карточку.
        if (card.ending === true) return;
        if (cards.get(chatId) === card) forget(chatId);
      },
    );
    forget(chatId, keepRecord);
    cards.set(chatId, card);
    unsubscribe.set(chatId, leave);
    while (cards.size > limit) {
      const oldest = cards.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
  };

  return {
    shown(chatId, messageId, shown) {
      const prior = cards.get(chatId);
      // «Не следить»: карточка перестаёт правиться вовсе — замирает, как после
      // рестарта, а следующее нажатие под ней оживляет её без слежения.
      if (shown?.watch === "stop") {
        if (prior !== undefined) forget(chatId);
        else {
          released.add(`${chatId}:${messageId}`);
          void options.store?.remove(chatId);
        }
        return false;
      }
      const same =
        prior !== undefined &&
        prior.messageId === messageId &&
        shown !== undefined &&
        shown.auctionId === prior.auctionId;
      if (same && prior !== undefined && shown !== undefined) {
        refresh(prior, shown);
        return true;
      }
      if (shown === undefined || !shown.live || shown.page === undefined) {
        if (prior?.messageId === messageId) forget(chatId);
        return false;
      }
      const card: LiveCardEntry = {
        chatId,
        messageId,
        auctionId: shown.auctionId,
        lotId: shown.lotId,
        version: shown.version,
        viewer: shown.viewer,
        page: shown.page,
        ...(shown.following === undefined
          ? {}
          : { following: { lotId: shown.lotId, value: shown.following } }),
        ...(shown.proxyLimit === undefined
          ? {}
          : { proxyLimit: { lotId: shown.lotId, amount: shown.proxyLimit } }),
        ...(shown.priceMoved === undefined
          ? {}
          : { priceMoved: { lotId: shown.lotId, outcome: shown.priceMoved } }),
      };
      // Новая подписка — до снятия прежней: у аукциона с одним подписчиком
      // поток иначе закрылся бы и открылся заново.
      open(card, shown.watch === "start");
      applyWatch(card, shown);
      return true;
    },
    async restore() {
      const targets = (await options.store?.list()) ?? [];
      for (const target of targets) {
        // Нажатие нового процесса, успевшее раньше, свежее записи, а снятое
        // слежение не оживает.
        if (cards.has(target.chatId)) continue;
        if (released.has(`${target.chatId}:${target.messageId}`)) {
          void options.store?.remove(target.chatId);
          continue;
        }
        // Версия 0: первое состояние потока перерисует карточку.
        open({ ...target, version: 0, watching: true });
        saved.set(target.chatId, target.lotId);
      }
      return targets.length;
    },
    watching: (chatId) => cards.get(chatId)?.watching === true,
    proxyLimitSet({ chatId, lotId, amount }) {
      const card = cards.get(chatId);
      if (card === undefined) return;
      card.proxyLimit = { lotId, amount };
      const state = latest.get(chatId);
      if (state !== undefined && card.lotId === lotId) {
        const lot = lotOf(card, state);
        if (lot !== undefined) {
          schedule(card, lot);
          return;
        }
      }
      if (card.lotId === lotId) card.version = 0;
    },
    size: () => cards.size,
    close() {
      for (const chatId of [...cards.keys()]) forget(chatId);
    },
  };
}

/**
 * Карточка лота в теле показанного экрана. Нет смотрящего — экран показан
 * без личности, и править его нечьими правами нельзя.
 */
export function liveCardOf(
  body: AuctionScreenBody,
  viewer: Viewer | undefined,
): LiveCardShown | undefined {
  if (viewer === undefined) return undefined;
  for (const block of body.blocks) {
    if (block.kind !== "lot") continue;
    return {
      auctionId: block.auctionId,
      lotId: block.lotId,
      version: block.version,
      viewer,
      live: block.live !== undefined,
      ...(block.watch === true
        ? { watch: "start" as const }
        : block.unwatch === true
          ? { watch: "stop" as const }
          : {}),
      ...(block.watching === true ? { watching: true } : {}),
      ...(block.live === undefined ? {} : { page: block.live.page }),
      ...(block.following === undefined ? {} : { following: block.following }),
      ...(block.viewerProxyLimit === undefined
        ? {}
        : { proxyLimit: block.viewerProxyLimit }),
      ...(block.finalBid !== undefined ? { priceMoved: block.finalBid } : {}),
    };
  }
  return undefined;
}

/**
 * Карточка в слежении, а дерево нарисовало её без «Не следить» — ставка,
 * «Обновить», избранное. Тело до deliver получает кнопку слежения, чтобы
 * ответ не шёл вторым `edit` вслед за собой.
 */
export function keepWatching(body: AuctionScreenBody): AuctionScreenBody {
  if (
    body.blocks.some((block) => block.kind === "lot" && block.unwatch === true)
  ) {
    return body;
  }
  let changed = false;
  const blocks = body.blocks.map((block) => {
    if (block.kind !== "lot" || block.watching === true) return block;
    if (block.live === undefined) return block;
    changed = true;
    return { ...block, watching: true as const };
  });
  if (!changed) return body;
  return {
    blocks,
    keyboard: body.keyboard.map((row) =>
      row.map((button) => {
        if (button.action !== "lot.watch") return button;
        const parsed = parseAuctionCallback(button.callbackData);
        if (!parsed.ok || parsed.intent.kind !== "watch-final") return button;
        return {
          action: "lot.unwatch" as const,
          callbackData: encodeAuctionCallback({
            kind: "unwatch-final",
            lotId: parsed.intent.lotId,
            page: parsed.intent.page,
          }),
        };
      }),
    ),
  };
}

function withProxyLimit(
  lot: LotView,
  proxyLimit: LiveCardEntry["proxyLimit"],
): LotView {
  return proxyLimit !== undefined && proxyLimit.lotId === lot.lotId
    ? { ...lot, viewerProxyLimit: proxyLimit.amount }
    : lot;
}

// Имя участника видно всем участникам аукциона (ADR-059), поэтому кэш один на
// процесс, а не на смотрящего. Кэш держит и вызов в полёте: на залпе все
// карточки аукциона спрашивают одного нового лидера разом, и вызов уходит
// один. Отказ и ответ без имени не кэшируются: следующая правка спросит снова.
export function cachedNames(
  port: Pick<AuctionPort, "getDisplayNames">,
): Pick<AuctionPort, "getDisplayNames"> {
  const known = new Map<string, Promise<string | undefined>>();
  const keyOf = (auctionId: string, participantId: string) =>
    `${auctionId}:${participantId}`;
  return {
    async getDisplayNames(request) {
      const missing = request.participantIds.filter(
        (id) => !known.has(keyOf(request.auctionId, id)),
      );
      if (missing.length > 0) {
        const fetched = port.getDisplayNames({
          ...request,
          participantIds: missing,
        });
        for (const id of missing) {
          const key = keyOf(request.auctionId, id);
          known.set(
            key,
            fetched.then(
              (names) => {
                const name = names[id];
                if (name === undefined) known.delete(key);
                return name;
              },
              () => {
                known.delete(key);
                return undefined;
              },
            ),
          );
        }
        while (known.size > NAMES_LIMIT) {
          const oldest = known.keys().next().value;
          if (oldest === undefined) break;
          known.delete(oldest);
        }
      }
      const names: Record<string, string> = {};
      for (const id of request.participantIds) {
        const name = await known.get(keyOf(request.auctionId, id));
        if (name !== undefined) names[id] = name;
      }
      return names;
    },
  };
}

// Отказ правки живого экрана: `429` — пауза всему боту; «сообщения нет», «не
// редактируется», закрытый чат и заблокированный бот — экран ушёл, и нового
// сообщения правка не шлёт, иначе живой экран стал бы рассылкой; обрыв
// соединения — та же правка ещё раз. Прочее — `failed`: правку пишет
// поверхность, а следующее состояние потока правит карточку заново.
export function liveEditFailure(
  cause: unknown,
  report: (error: string) => void,
): LiveEditOutcome {
  if (cause instanceof GrammyError) {
    if (cause.error_code === 429) {
      return {
        kind: "retry-after",
        ms: (cause.parameters.retry_after ?? 1) * 1_000,
      };
    }
    if (cause.description.includes("message is not modified")) {
      return { kind: "done" };
    }
    if (
      cause.error_code === 403 ||
      cause.description.includes("message can't be edited") ||
      cause.description.includes("message to edit not found") ||
      cause.description.includes("chat not found")
    ) {
      return { kind: "gone" };
    }
  }
  report(cause instanceof Error ? cause.message : String(cause));
  if (cause instanceof HttpError) {
    return { kind: "retry-after", ms: NETWORK_RETRY_MS };
  }
  return { kind: "failed" };
}
