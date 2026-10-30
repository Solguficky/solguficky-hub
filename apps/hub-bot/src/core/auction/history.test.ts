import { describe, expect, it } from "vitest";
import type { LotHistoryEntryView } from "../../auction-ui/index.js";
import { outbidOriginOf } from "./history.js";

const recipient = "0198f2a4-7c1e-7d3a-9b21-000000000001";
const rival = "0198f2a4-7c1e-7d3a-9b21-000000000002";

const bid = (
  sequence: number,
  participantId: string,
  rubles: number,
  origin: "proxy" | "manual",
  removed = false,
): LotHistoryEntryView => ({
  kind: "bid",
  sequence,
  occurredAt: "2026-10-30T10:00:00Z",
  bidId: `bid-${sequence}`,
  participantId,
  amount: { minorUnits: rubles * 100, currency: "RUB" },
  origin:
    origin === "proxy" ? { kind: "proxy" } : { kind: "manual", source: "bot" },
  ...(removed ? { removed: true as const } : {}),
});

// PER-840: источник ставки, перебившей получателя, берётся из хронологии по
// цене вести; неоднозначность не угадывается.
describe("outbidOriginOf", () => {
  it("returns the origin of the rival bid at the price of the notice", () => {
    const entries = [
      bid(1, recipient, 900, "manual"),
      bid(2, rival, 950, "proxy"),
    ];
    expect(outbidOriginOf(entries, 95_000, recipient)).toBe("proxy");
  });

  it("returns manual for a rival manual bid", () => {
    const entries = [
      bid(1, recipient, 900, "manual"),
      bid(2, rival, 950, "manual"),
    ];
    expect(outbidOriginOf(entries, 95_000, recipient)).toBe("manual");
  });

  it("finds the bid even when newer bids followed it", () => {
    const entries = [
      bid(1, recipient, 900, "manual"),
      bid(2, rival, 950, "proxy"),
      bid(3, recipient, 1000, "manual"),
    ];
    expect(outbidOriginOf(entries, 95_000, recipient)).toBe("proxy");
  });

  it("does not guess when two rival bids share the price", () => {
    const entries = [
      bid(1, rival, 950, "proxy", true),
      bid(2, recipient, 900, "manual"),
      bid(3, rival, 950, "manual"),
    ];
    // Снятая ставка не считается, остаётся одна ручная.
    expect(outbidOriginOf(entries, 95_000, recipient)).toBe("manual");
    expect(
      outbidOriginOf(
        [...entries, bid(4, rival, 950, "proxy")],
        95_000,
        recipient,
      ),
    ).toBeUndefined();
  });

  it("returns nothing when no rival bid has that price", () => {
    expect(
      outbidOriginOf([bid(1, recipient, 950, "manual")], 95_000, recipient),
    ).toBeUndefined();
  });
});
