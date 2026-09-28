// Свой генератор с seed вместо fast-check: новой зависимости ради исследования
// не заводится, а shrinking на контуре всё равно ненадёжен — база Meetups
// переживает повторы, и сокращённая последовательность шла бы на другом
// состоянии. Воспроизведение держит записанный скрипт действий, а не seed.

export type Random = {
  /** Равномерно в [0, 1). */
  next(): number;
  /** Целое в [0, bound). */
  below(bound: number): number;
  pick<T>(items: readonly T[]): T;
};

/** mulberry32: 32-битное состояние, период 2^32 — для сотен шагов хватает. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const below = (bound: number): number => Math.floor(next() * bound);
  return {
    next,
    below,
    pick(items) {
      const item = items[below(items.length)];
      if (item === undefined) {
        throw new Error("выбор из пустого набора");
      }
      return item;
    },
  };
}

/** Независимый поток на последовательность: повтор одной не требует прогона предыдущих. */
export function forSequence(seed: number, index: number): Random {
  return seeded(Math.imul(seed ^ 0x9e3779b9, index + 1) ^ index);
}
