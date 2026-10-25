// Номинации дня торгов (PER-511, PER-725): «Спорнее всех», «Тёмная лошадка» и
// «Эпичная дуэль». Выбор один у сводки дня пульта хаба и у «Хроник дня»
// участника в обоих ботах: пороги и правила живут здесь, а не в экранах.
//
// Чистая функция без портов: Auction отдаёт агрегаты окна без значимого
// порядка, и лот выбирает потребитель. Валюту лот несёт свою, и суммы между
// лотами не пересчитываются — так же, как сортировка пульта.

// «Тёмная лошадка» — лот, у которого до суток было не больше стольких ставок,
// а за сутки ему ставили; из таких — с наибольшим ростом от стартовой цены.
export const darkHorseMaxBidsBefore = 3;
// «Эпичная дуэль» — не меньше стольких смен лидера подряд между одними и теми
// же двумя людьми: A, B, A, B, A.
export const duelMinChanges = 4;

// Что нужно выбору о лоте: ставки и смены лидера окна, самая длинная дуэль
// окна, ставки до окна и рост от стартовой цены за всё время.
export type DayNominee = {
  bidCount: number;
  leaderChanges: number;
  longestDuel: number;
  bidsBefore: number;
  priceGrowth?: { minorUnits: number };
};

export type DayNominations<L> = {
  contested?: L;
  darkHorse?: L;
  duel?: L;
};

/** Номинации суток; лот без ставок в окне не номинируется ни в одной. */
export function dayNominations<L extends DayNominee>(
  lots: readonly L[],
): DayNominations<L> {
  const traded = lots.filter((lot) => lot.bidCount > 0);
  const contested = biggestBy(
    traded.filter((lot) => lot.leaderChanges > 0),
    (lot) => lot.leaderChanges,
  );
  const darkHorse = biggestBy(
    traded.filter(
      (lot) =>
        lot.bidsBefore <= darkHorseMaxBidsBefore &&
        (lot.priceGrowth?.minorUnits ?? 0) > 0,
    ),
    (lot) => lot.priceGrowth?.minorUnits ?? 0,
  );
  const duel = biggestBy(
    traded.filter((lot) => lot.longestDuel >= duelMinChanges),
    (lot) => lot.longestDuel,
  );
  return {
    ...(contested === undefined ? {} : { contested }),
    ...(darkHorse === undefined ? {} : { darkHorse }),
    ...(duel === undefined ? {} : { duel }),
  };
}

/** Лот с наибольшим значением метрики; равные не переставляются. */
export function biggestBy<L>(
  lots: readonly L[],
  metric: (lot: L) => number,
): L | undefined {
  let best: L | undefined;
  for (const lot of lots) {
    if (best === undefined || metric(lot) > metric(best)) best = lot;
  }
  return best;
}
