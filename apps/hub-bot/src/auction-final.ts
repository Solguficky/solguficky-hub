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
 * Строки цены лота в торгах финала: ровно следующая цена, без «от», и цена,
 * которую объявил ведущий, пока она выше текущей.
 */
export function finalPriceLines(
  block: LotBlock,
  money: (m: Money) => string,
): string[] {
  if (block.status.kind !== "trading" || block.status.phase !== "live") {
    return [];
  }
  return [
    ...(block.status.ask === undefined
      ? []
      : [`Ведущий объявил: ${money(block.status.ask)}`]),
    ...(block.nextPrice === undefined
      ? []
      : [`Следующая ставка: ${money(block.nextPrice)}`]),
  ];
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
    case "unknown":
      return "Аукцион не ответил: ставка могла пройти, смотри лидера";
    case "refused": {
      const { refusal } = outcome;
      switch (refusal.kind) {
        case "bid-not-at-next-price":
          return `Цену уже подняли: следующая ставка — ${money(refusal.expected)}`;
        case "bidder-is-leader":
          return `Ты уже лидируешь: цена ${money(refusal.currentPrice)} — твоя`;
        case "bid-below-minimum":
          return `Цену уже подняли: следующая ставка — ${money(refusal.minRequired)}`;
        case "lot-on-hold":
          return "Лот ждёт финала: ставки сейчас не принимаются";
        case "lot-not-open":
          return "Торги по лоту не идут";
        case "currency-mismatch":
          return "Лот торгуется в другой валюте";
        // Выбор имени — свой экран: сюда отказ не доходит.
        case "display-name-not-chosen":
          return "Выбери имя в аукционе";
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
