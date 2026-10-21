import { describe, expect, it } from "vitest";
import type { LotView } from "../../../auction-ui/index.js";
import type {
  AuctionConsoles,
  ConsoleReadResult,
  DisplayNamesResult,
  InvoiceMarkResult,
  InvoicesReadResult,
} from "../auction/port.js";
import {
  createAuctionInvoices,
  isOverdue,
  totalsOf,
} from "./auction-invoices.js";
import type { Invoice, LotAmount, Person } from "./types.js";

// Счета аукциона (PER-321): юзкейс над портом пульта. Счета, пульт и имена
// подменены ответами; вызовы записываются, чтобы проверить, что ушло в
// Auction и чего не ушло.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const vase = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const mug = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
const lamp = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
const jay = "01926f3c-8b7a-7cde-8f00-00000000000b";
const owl = "01926f3c-8b7a-7cde-8f00-00000000000c";
const person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "place-bids", "run-auctions"],
} as Person;
// Часы бота: 25 октября 2026 года, полдень UTC.
const now = new Date("2026-10-25T12:00:00Z");

const rub = (rubles: number): LotAmount => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});

function invoice(
  lotId: string,
  status: Invoice["status"],
  amount: LotAmount,
  paymentDueAt = "2026-10-30T12:00:00Z",
): Invoice {
  return {
    invoiceId: `inv-${lotId}`,
    auctionId,
    lotId,
    winnerId: jay,
    amount,
    paymentDueAt,
    fulfillment: "unspecified",
    status,
  };
}

function lot(lotId: string, title: string): LotView {
  return {
    lotId,
    auctionId,
    version: 5,
    card: { title, description: "" },
    proxyEnabled: false,
    status: { kind: "sold", winnerId: jay, price: rub(1_000) },
  };
}

function fake(answers: {
  invoices?: InvoicesReadResult;
  console?: ConsoleReadResult;
  names?: DisplayNamesResult;
  mark?: InvoiceMarkResult;
}) {
  const calls: { method: string; args: unknown }[] = [];
  const port = {
    listAuctionInvoices: async (_person, read) => {
      calls.push({ method: "listAuctionInvoices", args: read });
      return answers.invoices ?? { kind: "ok", invoices: [] };
    },
    getAuctionConsole: async (_person, read): Promise<ConsoleReadResult> => {
      calls.push({ method: "getAuctionConsole", args: read });
      return (
        answers.console ?? {
          kind: "ok",
          console: {
            auctionId,
            status: "finished",
            hidden: false,
            launchedWindows: [],
            lotSets: [],
            lots: [
              {
                lot: lot(vase, "Ваза"),
                bidCount: 3,
                markedForFinal: false,
                overdue: false,
              },
              {
                lot: lot(mug, "Кружка"),
                bidCount: 1,
                markedForFinal: false,
                overdue: false,
              },
            ],
          },
        }
      );
    },
    displayNames: async (_person, read) => {
      calls.push({ method: "displayNames", args: read });
      return answers.names ?? { kind: "ok", names: { [jay]: "@jay" } };
    },
    markInvoice: async (_person, mark) => {
      calls.push({ method: "markInvoice", args: mark });
      return answers.mark ?? { kind: "ok" };
    },
  } satisfies Partial<AuctionConsoles>;
  return {
    run: createAuctionInvoices(port as unknown as AuctionConsoles, () => now),
    sent: (method: string) => calls.filter((call) => call.method === method),
  };
}

const call = { identity: person, auctionId };

describe("totalsOf", () => {
  it("sums the collected from the paid and handed over invoices and the expected from the awaiting ones", () => {
    expect(
      totalsOf([
        invoice(vase, "paid", rub(1_500)),
        invoice(mug, "handed-over", rub(500)),
        invoice(lamp, "awaiting-payment", rub(700)),
      ]),
    ).toEqual({ collected: [rub(2_000)], expected: [rub(700)] });
  });

  it("keeps the sums of different currencies apart", () => {
    expect(
      totalsOf([
        invoice(vase, "paid", rub(1_500)),
        invoice(mug, "paid", { minorUnits: 3_000, currency: "EUR" }),
      ]).collected,
    ).toEqual([rub(1_500), { minorUnits: 3_000, currency: "EUR" }]);
  });
});

describe("isOverdue", () => {
  it("calls overdue only an invoice that awaits payment after its term", () => {
    const past = "2026-10-24T12:00:00Z";
    expect(
      isOverdue(invoice(vase, "awaiting-payment", rub(1), past), now),
    ).toBe(true);
    expect(isOverdue(invoice(vase, "paid", rub(1), past), now)).toBe(false);
    expect(isOverdue(invoice(vase, "awaiting-payment", rub(1)), now)).toBe(
      false,
    );
  });
});

describe("auction invoices", () => {
  it("names the lots and the winners and puts the overdue invoices first", async () => {
    const { run } = fake({
      invoices: {
        kind: "ok",
        invoices: [
          invoice(vase, "paid", rub(1_500)),
          invoice(mug, "awaiting-payment", rub(500), "2026-10-24T12:00:00Z"),
          { ...invoice(lamp, "awaiting-payment", rub(700)), winnerId: owl },
        ],
      },
    });
    const result = await run({
      ...call,
      intent: "view-auction-invoices",
      page: 0,
    });
    expect(result).toMatchObject({
      kind: "auction-invoices",
      totals: { collected: [rub(1_500)], expected: [rub(1_200)] },
      invoices: [
        { lotId: mug, title: "Кружка", winnerName: "@jay", overdue: true },
        // Лота нет в пульте, имени нет в аукционе: строка без них.
        { lotId: lamp, overdue: false },
        { lotId: vase, title: "Ваза", status: "paid" },
      ],
    });
    if (result.kind !== "auction-invoices") throw new Error(result.kind);
    expect(result.invoices[1]).not.toHaveProperty("title");
    expect(result.invoices[1]).not.toHaveProperty("winnerName");
  });

  it("refuses the summary to a non-administrator before reading names", async () => {
    const { run, sent } = fake({
      invoices: { kind: "not-administrator" },
    });
    await expect(
      run({ ...call, intent: "view-auction-invoices", page: 0 }),
    ).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "not-administrator",
    });
    expect(sent("getAuctionConsole")).toEqual([]);
    expect(sent("displayNames")).toEqual([]);
  });

  it("keeps the summary when the names and the console fail", async () => {
    const { run } = fake({
      invoices: { kind: "ok", invoices: [invoice(vase, "paid", rub(1_500))] },
      console: { kind: "unavailable", cause: new Error("down") },
      names: { kind: "unavailable", cause: new Error("down") },
    });
    await expect(
      run({ ...call, intent: "view-auction-invoices", page: 0 }),
    ).resolves.toMatchObject({
      kind: "auction-invoices",
      invoices: [{ lotId: vase, status: "paid" }],
    });
  });

  it("does not ask a confirmation for a payment that is already marked", async () => {
    const { run } = fake({
      invoices: { kind: "ok", invoices: [invoice(vase, "paid", rub(1_500))] },
    });
    await expect(
      run({
        ...call,
        intent: "prepare-invoice-mark",
        invoiceId: `inv-${vase}`,
        mark: "paid",
      }),
    ).resolves.toMatchObject({
      kind: "invoice-mark-outcome",
      note: "already-marked",
    });
  });

  it("does not offer a handover of an unpaid invoice", async () => {
    const { run, sent } = fake({
      invoices: {
        kind: "ok",
        invoices: [invoice(vase, "awaiting-payment", rub(1_500))],
      },
    });
    await expect(
      run({
        ...call,
        intent: "prepare-invoice-mark",
        invoiceId: `inv-${vase}`,
        mark: "handed-over",
      }),
    ).resolves.toMatchObject({
      kind: "invoice-mark-outcome",
      note: "not-paid",
    });
    expect(sent("markInvoice")).toEqual([]);
  });

  it("marks the payment with the key of the press and shows the invoice paid", async () => {
    const { run, sent } = fake({
      invoices: {
        kind: "ok",
        invoices: [
          invoice(vase, "awaiting-payment", rub(1_500), "2026-10-24T12:00:00Z"),
        ],
      },
    });
    await expect(
      run({
        ...call,
        intent: "mark-invoice",
        invoiceId: `inv-${vase}`,
        mark: "paid",
        opId: "op-1",
      }),
    ).resolves.toMatchObject({
      kind: "invoice-mark-outcome",
      note: "marked",
      invoice: { status: "paid", overdue: false },
    });
    expect(sent("markInvoice")).toEqual([
      {
        method: "markInvoice",
        args: { invoiceId: `inv-${vase}`, mark: "paid", opId: "op-1" },
      },
    ]);
  });

  it("calls a repeated payment mark already marked", async () => {
    const { run } = fake({
      invoices: { kind: "ok", invoices: [invoice(vase, "paid", rub(1_500))] },
    });
    await expect(
      run({
        ...call,
        intent: "mark-invoice",
        invoiceId: `inv-${vase}`,
        mark: "paid",
        opId: "op-2",
      }),
    ).resolves.toMatchObject({ note: "already-marked" });
  });

  it("does not mark an invoice of another auction", async () => {
    const { run, sent } = fake({
      invoices: { kind: "ok", invoices: [invoice(vase, "paid", rub(1_500))] },
    });
    await expect(
      run({
        ...call,
        intent: "mark-invoice",
        invoiceId: "inv-foreign",
        mark: "paid",
        opId: "op-1",
      }),
    ).resolves.toEqual({ kind: "invoice-missing", auctionId });
    expect(sent("markInvoice")).toEqual([]);
  });

  it("shows the refusal of the handover of an unpaid invoice", async () => {
    const { run } = fake({
      invoices: {
        kind: "ok",
        invoices: [invoice(vase, "paid", rub(1_500))],
      },
      mark: { kind: "invoice-not-paid" },
    });
    await expect(
      run({
        ...call,
        intent: "mark-invoice",
        invoiceId: `inv-${vase}`,
        mark: "handed-over",
        opId: "op-1",
      }),
    ).resolves.toMatchObject({ note: "not-paid" });
  });
});
