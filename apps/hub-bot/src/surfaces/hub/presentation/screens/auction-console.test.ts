import { describe, expect, it } from "vitest";
import { finalAskText } from "./auction-console.js";

// L0: текст вопроса о новой цене финала как данные. Сценарий вопроса целиком —
// в presentation/auction-console.test.ts.

const rub = (rubles: number) => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});

function spaced(text: string): string {
  return text.replace(/[  ]/g, " ");
}

describe("finalAskText", () => {
  it("names the next price as the threshold with the next hundred as the sample", () => {
    expect(spaced(finalAskText({ title: "Ваза", nextPrice: rub(1_250) }))).toBe(
      "Лот: Ваза\nСейчас следующая цена: 1 250 ₽\nНовая следующая цена в целых рублях, выше 1 250 ₽. Например: 1300",
    );
  });

  it("gives no sample above the largest amount an answer may name", () => {
    expect(
      spaced(finalAskText({ title: "Ваза", nextPrice: rub(9_999_900) })),
    ).toBe(
      "Лот: Ваза\nСейчас следующая цена: 9 999 900 ₽\nНовая следующая цена в целых рублях, выше 9 999 900 ₽.",
    );
  });

  it("keeps the current price as the threshold when the read has no next price", () => {
    expect(finalAskText({ title: "Ваза" })).toBe(
      "Лот: Ваза\nНовая следующая цена в целых рублях, выше текущей. Например: 5000",
    );
  });
});
