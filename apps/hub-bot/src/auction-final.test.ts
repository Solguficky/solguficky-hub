import { describe, expect, it } from "vitest";
import { finalBidHeadline, finalBidLine } from "./auction-final.js";
import type { AuctionBlock, Money } from "./auction-ui/index.js";

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

describe("finalBidHeadline", () => {
  const amount = { minorUnits: 130000, currency: "RUB" };
  const card: Extract<AuctionBlock, { kind: "lot" }> = {
    kind: "lot",
    lotId: "lot",
    auctionId: "auction",
    version: 5,
    status: { kind: "trading", phase: "live", currentPrice: amount },
    finalBid: { kind: "accepted", amount },
  };

  it("confirms leadership from the current snapshot", () => {
    expect(finalBidHeadline({ ...card, standing: "leader" }, money)).toBe(
      "Ты лидер: ставка 1300 ₽ принята",
    );
  });

  it("names an overbid even when the command was accepted", () => {
    expect(
      finalBidHeadline(
        {
          ...card,
          status: {
            kind: "trading",
            phase: "live",
            currentPrice: { ...amount, minorUnits: 140000 },
          },
        },
        money,
      ),
    ).toBe("Твою ставку перебили — цена уже 1400 ₽");
  });

  it("names the sale price for a late rejected bid", () => {
    expect(
      finalBidHeadline(
        {
          ...card,
          status: {
            kind: "sold",
            winnerId: "rival",
            price: amount,
          },
          finalBid: { kind: "refused", refusal: { kind: "lot-not-open" } },
        },
        money,
      ),
    ).toBe("Твоя ставка не прошла — цена уже 1300 ₽");
  });

  it("preserves an acceptance without claiming leadership from a stale snapshot", () => {
    expect(
      finalBidHeadline(
        { ...card, finalBid: { kind: "accepted-unread", amount } },
        money,
      ),
    ).toBe("Ставка 1300 ₽ принята: обнови карточку, чтобы узнать лидера");
  });
});
