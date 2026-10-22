import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { MoneySchema } from "../../../gen/auction/v1/auction_pb.js";
import {
  InvoiceDueReminderSchema,
  InvoiceReminderSchema,
} from "../../../gen/notifications/v1/notifications_pb.js";
import {
  createInvoiceNoticeRender,
  type InvoiceNotice,
  invoiceNoticeOf,
  renderInvoiceNotice,
} from "./invoice-notice.js";

const invoiceId = "5b1f3c2e-8d4a-5e6f-9a0b-1c2d3e4f5a6b";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
const amount = create(MoneySchema, { minorUnits: 150_000n, currency: "RUB" });
const paymentDueAt = "2026-10-31T18:00:00Z";
const nbsp = " ";

const notice: InvoiceNotice = {
  kind: "invoice-reminder",
  invoiceId,
  lotId,
  amount: { minorUnits: 150_000, currency: "RUB" },
  paymentDueAt,
};

describe("invoiceNoticeOf", () => {
  it("carries the invoice, the lot, the amount and the due moment", () => {
    expect(
      invoiceNoticeOf(
        "invoice-reminder",
        create(InvoiceReminderSchema, {
          invoiceId,
          lotId,
          amount,
          paymentDueAt,
        }),
      ),
    ).toEqual(notice);
    expect(
      invoiceNoticeOf(
        "invoice-due-reminder",
        create(InvoiceDueReminderSchema, {
          invoiceId,
          lotId,
          amount,
          paymentDueAt,
        }),
      ),
    ).toEqual({ ...notice, kind: "invoice-due-reminder" });
  });

  // Факт без суммы, со сломанным сроком или идентификатором — дефект издателя.
  it("refuses a reminder without an amount, a due moment or a canonical id", () => {
    const of = (fields: Record<string, unknown>) =>
      invoiceNoticeOf(
        "invoice-reminder",
        create(InvoiceReminderSchema, {
          invoiceId,
          lotId,
          amount,
          paymentDueAt,
          ...fields,
        }),
      );
    expect(of({ amount: undefined })).toBeUndefined();
    expect(of({ paymentDueAt: "soon" })).toBeUndefined();
    expect(of({ invoiceId: "nope" })).toBeUndefined();
    expect(of({ lotId: "nope" })).toBeUndefined();
  });
});

describe("renderInvoiceNotice", () => {
  it("names the lot, the sum and the due moment and leads to the invoice", () => {
    const view = renderInvoiceNotice(notice, {
      title: "Кружка",
      timeZone: "Europe/Moscow",
    });
    expect(view.text).toBe(
      `Счёт за <b>Кружка</b> — 1${nbsp}500${nbsp}₽ — ждёт оплаты до 31 октября в 21:00. Как оплатить и получить — в счёте.`,
    );
    expect(view.button).toEqual({ lotId, invoiceId, text: "К счёту" });
  });

  it("warns a day before the due moment and names a lot without a title", () => {
    expect(
      renderInvoiceNotice(
        { ...notice, kind: "invoice-due-reminder" },
        { timeZone: "Europe/Moscow" },
      ).text,
    ).toBe(
      `Срок оплаты счёта за лот — 1${nbsp}500${nbsp}₽ — истекает 31 октября в 21:00. Как оплатить и получить — в счёте.`,
    );
  });
});

describe("createInvoiceNoticeRender", () => {
  // Название — подсказка: отказ его чтения весть не снимает и права не
  // спрашивается вовсе.
  it("sends the reminder without the title when the lot read fails", async () => {
    const missing: unknown[] = [];
    const render = createInvoiceNoticeRender({
      reads: {
        holdsPlaceBids: async () => {
          throw new Error("the right is not asked");
        },
        lotInfo: async () => {
          throw new Error("auction unavailable");
        },
      },
      onTitleMissing: (cause) => missing.push(cause),
      timeZone: "UTC",
    });
    const rendered = await render(notice, { recipientId: "r-1" });
    expect(rendered.kind).toBe("ready");
    expect(rendered.kind === "ready" && rendered.message.text).toContain(
      "Счёт за лот",
    );
    expect(missing).toHaveLength(1);
  });
});
