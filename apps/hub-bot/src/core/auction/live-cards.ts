import { GrammyError } from "grammy";
import {
  type AuctionPort,
  type AuctionScreenBody,
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
  // Лот и версия, которые карточка показывает сейчас.
  lotId: string;
  version: number;
  // Смотрящий, которого шлюз пустил, когда карточку открывали: его правами
  // поверхность читает имена, им же открывается поток.
  viewer: Viewer;
  page: number;
  // Отметка избранного, с которой карточку открыли: Notifications на каждую
  // цену не спрашивается.
  following?: boolean;
  // Свой лимит смотрящего на лоте открытия: поток лимитов не несёт, а без
  // строки лимит пропадал бы с карточки на первой правке.
  proxyLimit?: { lotId: string; amount: Money };
};

/** Исход правки на стороне Telegram: `gone` — сообщения больше нет. */
export type LiveEditOutcome = EditOutcome | { kind: "gone" };

export type LiveCardEdit = (
  card: LiveCardEntry,
  body: AuctionScreenBody,
) => Promise<LiveEditOutcome>;

export type LiveCards = {
  /**
   * Сообщение в чате показало экран. Карточка финала — запоминается, прочее
   * в том же сообщении — вытесняет карточку: экран сменили, и правка по
   * потоку вернула бы карточку поверх него.
   */
  shown(
    chatId: number,
    messageId: number,
    card: LiveCardShown | undefined,
  ): void;
  size(): number;
  close(): void;
};

export type LiveCardShown = Omit<LiveCardEntry, "chatId" | "messageId">;

// Предел держит память процесса: на финал приходят десятки участников, а
// одна карточка на чат — новая вытесняет прежнюю.
export const LIVE_CARDS_LIMIT = 2_000;
// Имена участников: лидер меняется на каждой ставке, а имя — нет.
const NAMES_LIMIT = 1_000;

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
    options.limiter.drop(keyOf(card));
    unsubscribe.get(chatId)?.();
    unsubscribe.delete(chatId);
  };

  const onState = (chatId: number, state: AuctionWatchState) => {
    const card = cards.get(chatId);
    if (card === undefined) return;
    const lot =
      state.activeLot ?? state.lineup.find((each) => each.lotId === card.lotId);
    // Лота нет ни в торгах, ни в составе — показать нечего, карточка ждёт.
    if (lot === undefined) return;
    if (lot.lotId === card.lotId && lot.version === card.version) return;
    card.lotId = lot.lotId;
    card.version = lot.version;
    const shownLot = withProxyLimit(lot, card.proxyLimit);
    options.limiter.submit(card.chatId, keyOf(card), async () => {
      // Карточку сменили, пока правка ждала: править уже нечего.
      if (cards.get(chatId) !== card) return { kind: "done" };
      const body = await liveLot({
        auction: names,
        viewer: card.viewer,
        lot: shownLot,
        page: card.page,
        ...(card.following === undefined ? {} : { following: card.following }),
      });
      const outcome = await options.edit(card, body);
      if (outcome.kind === "gone") {
        if (cards.get(chatId) === card) forget(chatId);
        return { kind: "done" };
      }
      return outcome;
    });
  };

  return {
    shown(chatId, messageId, shown) {
      const prior = cards.get(chatId);
      if (shown === undefined) {
        if (prior?.messageId === messageId) forget(chatId);
        return;
      }
      forget(chatId);
      const card: LiveCardEntry = { chatId, messageId, ...shown };
      cards.set(chatId, card);
      unsubscribe.set(
        chatId,
        options.watches.subscribe(card.auctionId, card.viewer, (state) =>
          onState(chatId, state),
        ),
      );
      while (cards.size > limit) {
        const oldest = cards.keys().next().value;
        if (oldest === undefined) break;
        forget(oldest);
      }
    },
    size: () => cards.size,
    close() {
      for (const chatId of [...cards.keys()]) forget(chatId);
    },
  };
}

/**
 * Карточка финала в теле показанного экрана: блок лота с пометкой `live`.
 * Нет смотрящего — экран показан без личности, и править его нечьими
 * правами нельзя.
 */
export function liveCardOf(
  body: AuctionScreenBody,
  viewer: Viewer | undefined,
): LiveCardShown | undefined {
  if (viewer === undefined) return undefined;
  for (const block of body.blocks) {
    if (block.kind !== "lot" || block.live === undefined) continue;
    return {
      auctionId: block.auctionId,
      lotId: block.lotId,
      version: block.version,
      viewer,
      page: block.live.page,
      ...(block.following === undefined ? {} : { following: block.following }),
      ...(block.viewerProxyLimit === undefined
        ? {}
        : {
            proxyLimit: { lotId: block.lotId, amount: block.viewerProxyLimit },
          }),
    };
  }
  return undefined;
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
// один. Отказ не кэшируется: следующая правка спросит снова.
function cachedNames(
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
              (names) => names[id],
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

// Отказ правки живого экрана: `429` — пауза всему боту, «сообщения нет», «не
// редактируется», закрытый чат и заблокированный бот — экран ушёл, и нового
// сообщения правка не шлёт, иначе живой экран стал бы рассылкой. Прочее —
// эта цена не дошла, следующая правка придёт с новой.
export function liveEditFailure(
  cause: unknown,
  warn: (error: string) => void,
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
  warn(cause instanceof Error ? cause.message : String(cause));
  return { kind: "done" };
}
