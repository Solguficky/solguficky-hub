import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  InvoiceState_AwaitingPaymentSchema,
  InvoiceState_HandedOverSchema,
} from "../../../gen/auction/v1/auction_events_pb.js";
import { MoneySchema } from "../../../gen/auction/v1/auction_pb.js";
import {
  InvoiceSnapshotSchema,
  ListMyInvoicesResponseSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import { myInvoicesOf } from "./invoices.js";

const snapshot = (fields: Record<string, unknown> = {}) =>
  create(InvoiceSnapshotSchema, {
    id: "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6b",
    auctionId: "daef05c7-cd68-5048-b03d-cb4860e8dc73",
    lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d",
    winnerId: "01929b7e-5c1d-7a3f-8e4b-000000000001",
    amount: create(MoneySchema, { minorUnits: 300_000n, currency: "RUB" }),
    paymentDueAt: "2026-10-31T18:00:00Z",
    status: {
      case: "awaitingPayment",
      value: create(InvoiceState_AwaitingPaymentSchema),
    },
    ...fields,
  });

describe("myInvoicesOf", () => {
  it("keeps a purchased lot visible before its payment term starts", () => {
    const result = myInvoicesOf(
      create(ListMyInvoicesResponseSchema, {
        invoices: [snapshot({ paymentDueAt: "" })],
      }),
    );
    expect(result.invoices[0]?.paymentDueAt).toBeUndefined();
    expect(result.invoices[0]?.status).toBe("awaiting-payment");
  });

  it("rejects a nonempty malformed payment deadline", () => {
    expect(() =>
      myInvoicesOf(
        create(ListMyInvoicesResponseSchema, {
          invoices: [snapshot({ paymentDueAt: "tomorrow" })],
        }),
      ),
    ).toThrow();
  });
  it("translates the invoices and the organizer's text", () => {
    expect(
      myInvoicesOf(
        create(ListMyInvoicesResponseSchema, {
          invoices: [
            snapshot(),
            snapshot({
              status: {
                case: "handedOver",
                value: create(InvoiceState_HandedOverSchema),
              },
            }),
          ],
          paymentInstructions: "Карта",
        }),
      ),
    ).toEqual({
      invoices: [
        {
          invoiceId: "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6b",
          lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d",
          amount: { minorUnits: 300_000, currency: "RUB" },
          paymentDueAt: "2026-10-31T18:00:00Z",
          status: "awaiting-payment",
        },
        {
          invoiceId: "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6b",
          lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d",
          amount: { minorUnits: 300_000, currency: "RUB" },
          paymentDueAt: "2026-10-31T18:00:00Z",
          status: "handed-over",
        },
      ],
      paymentInstructions: "Карта",
    });
  });

  // Счёт без суммы или статуса — дефект соседа: чтение отказывает целиком.
  it("throws on an invoice without an amount or a status", () => {
    const response = (fields: Record<string, unknown>) =>
      create(ListMyInvoicesResponseSchema, { invoices: [snapshot(fields)] });
    expect(() => myInvoicesOf(response({ amount: undefined }))).toThrow();
    expect(() =>
      myInvoicesOf(response({ status: { case: undefined } })),
    ).toThrow();
  });
});
