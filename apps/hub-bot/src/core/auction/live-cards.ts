import { GrammyError, HttpError } from "grammy";
import {
  type AuctionPort,
  type AuctionScreenBody,
  type FinalBidOutcome,
  type LotView,
  liveLot,
  type Money,
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
  // Ответ «цена ушла» на нажатие участника (PER-835): правка по потоку на
  // чужую ставку иначе стирала бы его с карточки, и проигравший гонку видел
  // лишь мелькание. Живёт до следующего показа карточки этому чату.
  priceMoved?: { lotId: string; outcome: FinalBidOutcome };
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
  limit?: number;
}): LiveCards {
  const limit = options.limit ?? LIVE_CARDS_LIMIT;
  // Чат → карточка; порядок вставки — порядок свежести для вытеснения.
  const cards = new Map<number, LiveCardEntry>();
  const unsubscribe = new Map<number, () => void>();
  const names = cachedNames(options.names);
  const keyOf = (card: { chatId: number; messageId: number }) =>
    `${card.chatId}:${card.messageId}`;

  const forget = (chatId: number) => {
    const card = cards.get(chatId);
    if (card === undefined) return;
    cards.delete(chatId);
    latest.delete(chatId);
    options.limiter.drop(keyOf(card));
    unsubscribe.get(chatId)?.();
    unsubscribe.delete(chatId);
  };

  // Правка ещё нужна: карточку не сменили и не показали новее, пока правка
  // ждала очереди или имени.
  const current = (
    card: LiveCardEntry,
    target: { lotId: string; version: number },
  ) =>
    cards.get(card.chatId) === card &&
    card.lotId === target.lotId &&
    card.version === target.version;

  // Последнее состояние потока у карточки: им карточка возвращается к
  // правде, если ответ на нажатие отрисовал лот старее того, что поток уже
  // показал.
  const latest = new Map<number, AuctionWatchState>();

  const lotOf = (card: LiveCardEntry, state: AuctionWatchState) =>
    state.activeLot ?? state.lineup.find((each) => each.lotId === card.lotId);

  const schedule = (card: LiveCardEntry, lot: LotView) => {
    const { chatId } = card;
    card.lotId = lot.lotId;
    card.version = lot.version;
    const target = { lotId: lot.lotId, version: lot.version };
    const shownLot = withProxyLimit(lot, card.proxyLimit);
    options.limiter.submit(chatId, keyOf(card), async () => {
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
      });
      if (!current(card, target)) return { kind: "done" };
      const outcome = await options.edit(card, body);
      switch (outcome.kind) {
        case "gone":
          if (cards.get(chatId) === card) forget(chatId);
          return { kind: "done" };
        case "failed":
          // Цена не дошла: следующее состояние потока правит заново.
          if (current(card, target)) card.version = 0;
          return { kind: "done" };
        default:
          return outcome;
      }
    });
  };

  const onState = (chatId: number, state: AuctionWatchState) => {
    const card = cards.get(chatId);
    if (card === undefined) return;
    latest.set(chatId, state);
    const lot = lotOf(card, state);
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
    const state = latest.get(card.chatId);
    const lot = state === undefined ? undefined : lotOf(card, state);
    if (
      lot !== undefined &&
      (lot.lotId !== shown.lotId || lot.version > shown.version)
    ) {
      schedule(card, lot);
    }
  };

  return {
    shown(chatId, messageId, shown) {
      const prior = cards.get(chatId);
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
      const leave = options.watches.subscribe(
        card.auctionId,
        card.viewer,
        (state) => onState(chatId, state),
        () => {
          if (cards.get(chatId) === card) forget(chatId);
        },
      );
      forget(chatId);
      cards.set(chatId, card);
      unsubscribe.set(chatId, leave);
      while (cards.size > limit) {
        const oldest = cards.keys().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
      return true;
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
      ...(block.live === undefined ? {} : { page: block.live.page }),
      ...(block.following === undefined ? {} : { following: block.following }),
      ...(block.viewerProxyLimit === undefined
        ? {}
        : { proxyLimit: block.viewerProxyLimit }),
      ...(isPriceMoved(block.finalBid) ? { priceMoved: block.finalBid } : {}),
    };
  }
  return undefined;
}

// Только отказ «не по цене»: остальные исходы читаются по снимку или не нужны
// после первой правки, а этот человек иначе не увидел бы вовсе.
function isPriceMoved(
  outcome: FinalBidOutcome | undefined,
): outcome is FinalBidOutcome {
  return (
    outcome !== undefined &&
    (outcome.kind === "price-changed" ||
      (outcome.kind === "refused" &&
        outcome.refusal.kind === "bid-not-at-next-price"))
  );
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
