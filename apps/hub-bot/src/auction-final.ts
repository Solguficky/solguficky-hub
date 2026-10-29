import type {
  AuctionBlock,
  FinalBidOutcome,
  Money,
} from "./auction-ui/index.js";

// Слова карточки финала (PER-336) общие у обеих поверхностей, как тексты
// розыгрыша: ставка финала в двух ботах не должна читаться по-разному. Строки —
// «ключ: значение» карточки без точки (дизайн-код, «Карточка лота»); формат
// суммы задаёт оболочка, экранирование — тоже.

type LotBlock = Extract<AuctionBlock, { kind: "lot" }>;

/** Подпись кнопки ставки финала: сумма — следующая цена (ADR-049). */
export function finalBidLabel(amount: Money, money: (m: Money) => string) {
  return `Поставить ${money(amount)}`;
}

/**
 * Строка цены лота в торгах финала — одна (PER-639): цена, которую объявил
 * ведущий, пока она выше текущей — тогда она и есть следующая ставка, — иначе
 * ровно следующая цена, без «от». Шага в финале карточка не показывает: цену
 * задаёт ведущий (`showsStep`).
 */
export function finalPriceLines(
  block: LotBlock,
  money: (m: Money) => string,
): string[] {
  if (!inLiveFinal(block)) return [];
  // Объявленная цена — строка карточки, только пока она и есть следующая
  // ставка: после отказа «не по цене» дерево поднимает `nextPrice` выше
  // отстающего снимка, и карточка называет ту сумму, что стоит на кнопке.
  const ask = block.status.kind === "trading" ? block.status.ask : undefined;
  if (
    ask !== undefined &&
    (block.nextPrice === undefined ||
      block.nextPrice.minorUnits === ask.minorUnits)
  ) {
    return [`Ведущий объявил: ${money(ask)}`];
  }
  return block.nextPrice === undefined
    ? []
    : [`Следующая ставка: ${money(block.nextPrice)}`];
}

/** Показывает ли карточка шаг лота: в живом финале — нет (PER-639). */
export function showsStep(block: LotBlock): boolean {
  return !inLiveFinal(block);
}

function inLiveFinal(block: LotBlock): boolean {
  return block.status.kind === "trading" && block.status.phase === "live";
}

/**
 * Строка исхода ставки финала на самой карточке. Отказ «не по цене» — гонка
 * нажатий: цена ушла, и кнопка карточки уже предлагает новую.
 */
export function finalBidLine(
  outcome: FinalBidOutcome,
  money: (m: Money) => string,
): string {
  switch (outcome.kind) {
    case "accepted":
      return `Твоя ставка ${money(outcome.amount)} принята`;
    case "accepted-unread":
      return `Ставка ${money(outcome.amount)} принята: обнови карточку, чтобы узнать лидера`;
    case "unknown":
      return "Аукцион не ответил: ставка могла пройти, смотри лидера";
    case "price-changed":
      return `Цена изменилась: следующая ставка — ${money(outcome.next)}`;
    case "refused": {
      const { refusal } = outcome;
      switch (refusal.kind) {
        case "bid-not-at-next-price":
          return `Цену уже подняли: следующая ставка — ${money(refusal.expected)}`;
        case "bidder-is-leader":
          return `Ты уже лидируешь: цена ${money(refusal.currentPrice)} — твоя`;
        case "bid-below-minimum":
          return `Цену уже подняли: следующая ставка — ${money(refusal.minRequired)}`;
        case "bid-above-maximum":
          return `Максимум сейчас — 5 × ${money(refusal.next)}`;
        case "lot-on-hold":
          return "Лот ждёт финала: ставки сейчас не принимаются";
        case "lot-not-open":
          return "Торги по лоту не идут";
        case "currency-mismatch":
          return "Лот торгуется в другой валюте";
        // Выбор имени — свой экран: сюда отказ не доходит.
        case "display-name-not-chosen":
          return "Выбери имя в аукционе";
        case "removed-from-lot":
          return "Ставки на этом лоте для тебя закрыты";
        default: {
          const _exhaustive: never = refusal;
          return _exhaustive;
        }
      }
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// Исход читает актуальный снимок: принятую ставку уже могли перебить.
export function finalBidHeadline(
  block: LotBlock,
  money: (m: Money) => string,
): string | undefined {
  const outcome = block.finalBid;
  if (outcome === undefined) return undefined;
  if (outcome.kind === "accepted") {
    if (block.standing === "leader" || block.standing === "won")
      return `Ты лидер: ставка ${money(outcome.amount)} принята`;
    if (block.status.kind === "trading")
      return `Твою ставку перебили — цена уже ${money(block.status.currentPrice)}`;
    if (block.status.kind === "sold")
      return `Твою ставку перебили — цена продажи ${money(block.status.price)}`;
  }
  if (outcome.kind === "price-changed")
    return `Твоя ставка не прошла — следующая цена ${money(outcome.next)}`;
  if (
    outcome.kind === "refused" &&
    outcome.refusal.kind === "bid-not-at-next-price"
  )
    return `Твоя ставка не прошла — следующая цена ${money(outcome.refusal.expected)}`;
  if (
    outcome.kind === "refused" &&
    ["bid-below-minimum", "lot-not-open"].includes(outcome.refusal.kind)
  ) {
    const price =
      block.status.kind === "trading"
        ? block.status.currentPrice
        : block.status.kind === "sold"
          ? block.status.price
          : undefined;
    return price === undefined
      ? `Твоя ставка не прошла: ${finalBidLine(outcome, money)}`
      : `Твоя ставка не прошла — цена уже ${money(price)}`;
  }
  return finalBidLine(outcome, money);
}

/**
 * Слова лимита автоставки лоту, который ждёт финала (PER-821, ADR-079):
 * лимит сработает в финале по сетке цен, а остаток лимита, который не доходит
 * до следующей цены сетки, не добирается (ADR-049). Общие у двух ботов.
 */
const gridRemainder = "Остаток лимита, не кратный шагу сетки, не добирается.";

export const heldProxyQuestion = `Пришли лимит в рублях. Лот ждёт финала: лимит сработает там, и бот будет ставить за тебя по сетке цен финала. ${gridRemainder} Лимит видишь только ты.`;

export function heldProxyConfirmation(
  currentPrice: Money,
  limit: Money,
  money: (m: Money) => string,
): string {
  return `Цена сейчас ${money(currentPrice)}. Лимит сработает в финале: бот будет ставить за тебя по сетке цен, но не выше ${money(limit)}. ${gridRemainder}`;
}

export const heldProxyAccepted = `Лимит сработает в финале по сетке цен. ${gridRemainder}`;
