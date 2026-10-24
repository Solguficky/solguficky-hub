import { describe, expect, it } from "vitest";
import { finalBidLine } from "./auction-final.js";
import type { Money } from "./auction-ui/index.js";

const money = (amount: Money) => `${amount.minorUnits / 100} ₽`;

describe("finalBidLine", () => {
  // Цена ушла, пока человек выбирал имя (PER-713): ставки не было, и строка
  // называет новую цену — ту, что уже стоит на кнопке.
  it("names the new price when it moved while the name was chosen", () => {
    expect(
      finalBidLine(
        {
          kind: "price-changed",
          next: { minorUnits: 140000, currency: "RUB" },
        },
        money,
      ),
    ).toBe("Цена изменилась: следующая ставка — 1400 ₽");
  });
});
