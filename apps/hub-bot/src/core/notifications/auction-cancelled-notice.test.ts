import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AuctionCancelledSchema } from "../../../gen/notifications/v1/notifications_pb.js";
import { money } from "../format.js";
import {
  type AuctionCancelledNotice,
  auctionCancelledNoticeOf,
  renderAuctionCancelledNotice,
} from "./auction-cancelled-notice.js";

const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const lotId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f61";
const rub = (minorUnits: number) => ({
  minorUnits: BigInt(minorUnits),
  currency: "RUB",
});

const cancelled = (
  purchases: { lotId: string; price?: ReturnType<typeof rub> }[] = [],
) => create(AuctionCancelledSchema, { auctionId, meetupId, purchases });

describe("auctionCancelledNoticeOf", () => {
  it("carries the auction and the prices of the recipient's purchases", () => {
    expect(auctionCancelledNoticeOf(cancelled())).toEqual({
      kind: "auction-cancelled",
      auctionId,
      purchases: [],
    });
    expect(
      auctionCancelledNoticeOf(cancelled([{ lotId, price: rub(150_000) }])),
    ).toEqual({
      kind: "auction-cancelled",
      auctionId,
      purchases: [{ minorUnits: 150_000, currency: "RUB" }],
    });
  });

  // Кривой идентификатор и покупка без цены — дефект издателя: строку о
  // покупке без цены не сказать честно, а кнопку без аукциона не собрать.
  it.each([
    [
      "an auction id not in canonical form",
      create(AuctionCancelledSchema, {
        auctionId: auctionId.toUpperCase(),
        meetupId,
      }),
    ],
    ["a purchase without a price", cancelled([{ lotId }])],
    [
      "a purchase of a lot not in canonical form",
      cancelled([{ lotId: "lot", price: rub(100) }]),
    ],
  ])("rejects %s", (_, value) => {
    expect(auctionCancelledNoticeOf(value)).toBeUndefined();
  });
});

describe("renderAuctionCancelledNotice", () => {
  const notice = (
    purchases: AuctionCancelledNotice["purchases"] = [],
  ): AuctionCancelledNotice => ({
    kind: "auction-cancelled",
    auctionId,
    purchases,
  });
  const lead =
    "Аукцион отменили: торги по лотам остановлены, ставки больше не действуют.";

  it("tells everyone the trading stopped and leads to the auction", () => {
    expect(renderAuctionCancelledNotice(notice())).toEqual({
      text: lead,
      button: { auctionId, text: "К аукциону" },
    });
  });

  // Строка о покупке — только покупателю: одна покупка — её цена, несколько —
  // число и сумма.
  it("adds the purchases of a buyer", () => {
    expect(
      renderAuctionCancelledNotice(
        notice([{ minorUnits: 150_000, currency: "RUB" }]),
      ).text,
    ).toBe(
      `${lead}\nТвоя покупка за ${money({ minorUnits: 150_000, currency: "RUB" })} остаётся за тобой.`,
    );
    expect(
      renderAuctionCancelledNotice(
        notice([
          { minorUnits: 150_000, currency: "RUB" },
          { minorUnits: 200_000, currency: "RUB" },
        ]),
      ).text,
    ).toBe(
      `${lead}\nТвои покупки — 2 лота на ${money({ minorUnits: 350_000, currency: "RUB" })} — остаются за тобой.`,
    );
  });
});
