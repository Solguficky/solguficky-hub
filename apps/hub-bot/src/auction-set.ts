import type { FeedItem, LotSetView } from "./auction-ui/index.js";

// Тексты сета лотов (ADR-073, п. 7), общие у обеих поверхностей: название
// сета, отметка принадлежности в ленте и строка собравшего. Навигацию,
// экранирование названия и подписи кнопок задаёт оболочка.

/**
 * Кнопка карточки лота сета и заголовок его экрана: «Лоты сета». Экран —
 * раздел карточки лота, как «Ставки» (дизайн-код, «Карточка лота»).
 */
export const setLabel = "Лоты сета";

/** Поле карточки лота: сет, в который лот входит. */
export function setField(name: string): string {
  return `Сет: «${name}»`;
}

/**
 * Итог сета: кто его собрал. До итога сета этой строки нет — Auction
 * записывает собравшего один раз, когда последний лот сета пришёл к
 * терминальному исходу (ADR-073, п. 4).
 */
export function collectedLine(name: string, collector: string): string {
  return `Сет «${name}» собрал ${collector}`;
}

/**
 * Группа карточки лота сета: название сета и, после итога, собравший. Текст
 * организатора и участника — экранирует оболочка, как и остальные группы
 * карточки.
 */
export function setGroupLines(set: LotSetView): string[] {
  return [
    setField(set.name),
    ...(set.collectorName === undefined
      ? []
      : [collectedLine(set.name, set.collectorName)]),
  ];
}

// Название и цена лота сета — как у строки ленты: оболочка задаёт их своими
// правилами (дизайн-код, «Списки аукционов и лента лотов»).
export type SetLotOptions = {
  /** Название лота одной строкой, уже экранированное. */
  title: (item: FeedItem) => string;
  /** Название лота для подписи кнопки — короче, как у кнопки ленты. */
  buttonTitle: (item: FeedItem) => string;
  /** Цена или итог лота, как у строки ленты. */
  price: (item: FeedItem) => string;
};

/** Строка лота сета в теле экрана: «Кружка — 1 200 ₽». */
export function setLotLine(item: FeedItem, options: SetLotOptions): string {
  return `${options.title(item)} — ${options.price(item)}`;
}

/** Подпись кнопки лота сета: «Кружка · 1 200 ₽». */
export function setLotLabel(item: FeedItem, options: SetLotOptions): string {
  return `${options.buttonTitle(item)} · ${options.price(item)}`;
}

/** Строка о лотах сета, которых экран не показал. */
export function setMoreLine(count: number): string {
  return `И ещё ${count}.`;
}
