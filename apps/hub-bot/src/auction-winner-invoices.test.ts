import { describe, expect, it } from "vitest";
import { invoiceParagraphs } from "./auction-winner-invoices.js";

describe("invoice before the auction ends", () => {
  it("shows the pending payment term and when the organizer will add instructions", () => {
    const text = invoiceParagraphs(
      {
        kind: "invoice",
        auctionId: "auction",
        invoice: {
          invoiceId: "invoice",
          lotId: "lot",
          amount: { minorUnits: 100, currency: "RUB" },
          status: "awaiting-payment",
          paymentDueAt: undefined,
        },
      },
      {
        moment: () => {
          throw new Error("a pending invoice has no date");
        },
      },
    ).join("\n");
    expect(text).toContain("срок оплаты начнётся после завершения аукциона");
    expect(text).toContain("не позже завершения аукциона");
  });
});
