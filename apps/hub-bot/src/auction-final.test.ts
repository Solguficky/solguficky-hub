import { describe, expect, it } from "vitest";
import {
  finalBidHeadline,
  finalBidLine,
  liveProxyAccepted,
  liveProxyConfirmation,
} from "./auction-final.js";
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

  // PER-840: исход несёт `overtaken`, только когда хронология доказала
  // прокси; карточка тогда называет автоставку. Перебитие без доказательства
  // остаётся нейтральным.
  it("names the proxy that overbid a bid in the same command", () => {
    expect(
      finalBidHeadline(
        {
          ...card,
          finalBid: { kind: "accepted", amount, overtaken: true },
          status: {
            kind: "trading",
            phase: "live",
            currentPrice: { ...amount, minorUnits: 140000 },
          },
        },
        money,
      ),
    ).toBe(
      "Твою ставку перебила автоставка другого участника — цена уже 1400 ₽",
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

  it("names the current next price for a price-moved reply that went stale", () => {
    expect(
      finalBidHeadline(
        {
          ...card,
          nextPrice: { minorUnits: 150_000, currency: "RUB" },
          finalBid: { kind: "price-changed", next: amount },
        },
        money,
      ),
    ).toBe("Твоя ставка не прошла — следующая цена 1500 ₽");
  });

  it("does not go below the price the refusal named", () => {
    expect(
      finalBidHeadline(
        {
          ...card,
          nextPrice: { minorUnits: 120_000, currency: "RUB" },
          finalBid: { kind: "price-changed", next: amount },
        },
        money,
      ),
    ).toBe("Твоя ставка не прошла — следующая цена 1300 ₽");
  });

  it("says nothing about a price that moved once the lot closed or the viewer leads", () => {
    const moved = { kind: "price-changed" as const, next: amount };
    expect(
      finalBidHeadline(
        {
          ...card,
          status: { kind: "unsold" },
          finalBid: moved,
        },
        money,
      ),
    ).toBeUndefined();
    expect(
      finalBidHeadline({ ...card, standing: "leader", finalBid: moved }, money),
    ).toBeUndefined();
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

describe("final auction copy", () => {
  const currentPrice = { minorUnits: 100_000, currency: "RUB" };
  const nextPrice = { minorUnits: 110_000, currency: "RUB" };
  const limit = { minorUnits: 115_000, currency: "RUB" };

  it("explains immediate recalculation without promising its price or leader", () => {
    const text = liveProxyConfirmation({
      currentPrice,
      nextPrice,
      limit,
      viewerIsLeader: false,
      money,
    });
    expect(text).toContain("Auction сразу пересчитает автоставки");
    expect(text).toContain("итоговая цена и лидер зависят от других лимитов");
    expect(text).not.toContain("бот поставит");
  });

  it("does not place an auto-bid against the viewer who leads", () => {
    expect(
      liveProxyConfirmation({
        currentPrice,
        nextPrice,
        limit,
        viewerIsLeader: true,
        money,
      }),
    ).toContain("бот не ставит против тебя");
  });

  it("states that a limit below the next grid price cannot place it", () => {
    const text = liveProxyConfirmation({
      currentPrice,
      nextPrice,
      limit: { minorUnits: 105_000, currency: "RUB" },
      viewerIsLeader: false,
      money,
    });
    expect(text).toContain("Лимита не хватает на следующую цену сетки");
    expect(text).not.toContain("ждать соперника");
  });

  it("does not promise that an accepted limit has already placed its owner's bid", () => {
    expect(liveProxyAccepted).toContain("Auction сразу пересчитал автоставки");
    expect(liveProxyAccepted).toContain("цена и лидер могут измениться");
    expect(liveProxyAccepted).not.toContain("ставка уже ушла");
  });
});
