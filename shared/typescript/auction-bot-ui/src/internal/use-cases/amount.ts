import { MAX_COMMAND_AMOUNT } from "../../callback-data.js";
import type { AnswerRefusal } from "../../screen.js";

export type ParsedAmount =
  | { ok: true; minorUnits: number }
  | {
      ok: false;
      refusal: Extract<
        AnswerRefusal,
        | "not-a-number"
        | "other-currency"
        | "not-positive"
        | "too-precise"
        | "too-large"
      >;
    };

// Знаки валюты, которые человек может дописать к сумме. Сумма без знака — в
// валюте лота: другой валюты лот не принимает (И-04).
const MARKERS: Readonly<Record<string, readonly string[]>> = {
  RUB: ["₽", "р", "р.", "руб", "руб.", "рубль", "рубля", "рублей", "rub"],
};

// Похоже на сумму в другой валюте: такой ответ получает свой отказ, а не «не
// число».
const FOREIGN = /[$€£¥₽]|\b(usd|eur|gbp|cny|rub)\b|доллар|бакс|евро|юан|руб/i;

// Разряды через пробел, в том числе неразрывный, и до двух знаков дробной
// части через точку или запятую: «1 250», «1250,50».
const NUMBER = /^(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,](\d+))?$/;

// Сумма ответа на вопрос о ставке или лимите. Чистая функция: ввод — строка
// человека, отказ — значение, исключения нет (критерий приёмки PER-317).
export function parseAmount(text: string, currency: string): ParsedAmount {
  const trimmed = text.trim().toLowerCase();
  const markers = MARKERS[currency] ?? [currency.toLowerCase()];
  const marker = markers.find(
    (each) => trimmed.endsWith(each) || trimmed.startsWith(each),
  );
  const bare = (
    marker === undefined
      ? trimmed
      : trimmed.endsWith(marker)
        ? trimmed.slice(0, -marker.length)
        : trimmed.slice(marker.length)
  ).trim();
  if (/^-\s*\d/.test(bare)) return { ok: false, refusal: "not-positive" };
  const match = NUMBER.exec(bare);
  if (match === null) {
    return {
      ok: false,
      refusal: FOREIGN.test(trimmed) ? "other-currency" : "not-a-number",
    };
  }
  const whole = (match[1] ?? "").replace(/[ \u00a0\u202f]/g, "");
  const fraction = match[2] ?? "";
  if (fraction.length > 2) return { ok: false, refusal: "too-precise" };
  // Длинная строка цифр не доходит до потери точности: сравнение идёт по
  // числу знаков раньше, чем по значению.
  if (whole.replace(/^0+/, "").length > 12) {
    return { ok: false, refusal: "too-large" };
  }
  const minorUnits = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (minorUnits <= 0) return { ok: false, refusal: "not-positive" };
  if (minorUnits > MAX_COMMAND_AMOUNT) {
    return { ok: false, refusal: "too-large" };
  }
  return { ok: true, minorUnits };
}
