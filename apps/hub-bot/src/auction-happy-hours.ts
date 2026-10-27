import type { Money, StepWindowView } from "./auction-ui/index.js";

// Условия окна «Счастливых часов» на карточке лота — общие у двух оболочек
// (PER-787; ADR-047, дополнение 2026-10-27): стартовая окна парой с обычной
// стартовой — «от 800 ₽ вместо 1 600 ₽», — шаг окна — «шаг 50 ₽» — или оба
// через запятую, как в вести о начале окна. Обычная стартовая — текущая цена
// лота без ставок; нет её — у лота есть ставки, и стартовая окна ему уже не
// действует: карточка её не обещает. Нечего показать — `undefined`.
export function happyHourTerms(
  window: Pick<StepWindowView, "step" | "start">,
  regularStart: Money | undefined,
  money: (amount: Money) => string,
): string | undefined {
  const terms = [
    ...(window.start === undefined || regularStart === undefined
      ? []
      : [`от ${money(window.start)} вместо ${money(regularStart)}`]),
    ...(window.step === undefined ? [] : [`шаг ${money(window.step)}`]),
  ];
  return terms.length === 0 ? undefined : terms.join(", ");
}

// Строка действующего окна: «Счастливые часы до 22:00: от 800 ₽ вместо
// 1 600 ₽». Знака 🔥 в начале нет: словарь знаков строки закрыт (дизайн-код,
// «Формат»), а в строке состояния аукциона знак стоит внутри строки. Момент
// конца пишет оболочка своим форматом.
export function activeHappyHourLine(until: string, terms: string): string {
  return `Счастливые часы до ${until}: ${terms}`;
}
