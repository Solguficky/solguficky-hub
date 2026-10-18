import type { LotStatusView, LotView, Viewer } from "../../ports.js";
import type { FeedItem, LotStanding } from "../../screen.js";

// Положение смотрящего на лоте (PER-595): лидер торгов или покупатель
// проданного лота. «Перебили» здесь нет намеренно: снимок не говорит, ставил
// ли смотрящий на лот, а отметка избранного бывает и без ставки (решение
// владельца 13 октября 2026 года).
export function standingOf(
  status: LotStatusView,
  viewer: Viewer,
): LotStanding | undefined {
  switch (status.kind) {
    case "trading":
    case "held":
      return status.leaderId === viewer.identityId ? "leader" : undefined;
    case "sold":
      return status.winnerId === viewer.identityId ? "won" : undefined;
    default:
      return undefined;
  }
}

// Строка списка по снимку лота: название, итог или цена и положение
// смотрящего.
export function feedItemOf(lot: LotView, viewer: Viewer): FeedItem {
  const standing = standingOf(lot.status, viewer);
  return {
    lotId: lot.lotId,
    ...(lot.card === undefined ? {} : { title: lot.card.title }),
    status: lot.status,
    ...(lot.activeWindow === undefined
      ? {}
      : { activeWindow: lot.activeWindow }),
    ...(standing === undefined ? {} : { standing }),
  };
}

// Поле сводки блока: своих лотов нет — нет и поля.
export function withMine(mine: readonly FeedItem[]): {
  mine?: readonly FeedItem[];
} {
  return mine.length === 0 ? {} : { mine };
}

// Свои лоты всего списка, а не страницы: сводка над кнопками говорит обо
// всём аукционе или обо всём избранном.
export function mineOf(
  lots: readonly LotView[],
  viewer: Viewer,
): readonly FeedItem[] {
  return lots
    .map((lot) => feedItemOf(lot, viewer))
    .filter((item) => item.standing !== undefined);
}
