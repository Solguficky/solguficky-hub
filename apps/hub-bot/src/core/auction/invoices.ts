import type {
  InvoiceSnapshot,
  ListMyInvoicesResponse,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  InvoiceStatus,
  MyInvoicesView,
  WinnerInvoiceView,
} from "../../auction-ui/index.js";
import { moneyOf } from "./snapshot.js";

// Счета победителя (PER-322) в словаре пакета. Перевод общий у обеих
// поверхностей. Счёт без суммы, статуса или разборчивого срока — дефект
// соседа: перевод бросает, а не показывает счёт без денег.

export function myInvoicesOf(response: ListMyInvoicesResponse): MyInvoicesView {
  return {
    invoices: response.invoices.map(winnerInvoiceOf),
    ...(response.paymentInstructions === undefined
      ? {}
      : { paymentInstructions: response.paymentInstructions }),
  };
}

function winnerInvoiceOf(snapshot: InvoiceSnapshot): WinnerInvoiceView {
  const status = statusOf(snapshot);
  if (
    snapshot.amount === undefined ||
    Number.isNaN(Date.parse(snapshot.paymentDueAt)) ||
    status === undefined
  ) {
    throw new Error("auction invoice without an amount, a status or a due");
  }
  return {
    invoiceId: snapshot.id,
    lotId: snapshot.lotId,
    amount: moneyOf(snapshot.amount),
    paymentDueAt: snapshot.paymentDueAt,
    status,
  };
}

function statusOf(snapshot: InvoiceSnapshot): InvoiceStatus | undefined {
  switch (snapshot.status.case) {
    case "awaitingPayment":
      return "awaiting-payment";
    case "paid":
      return "paid";
    case "handedOver":
      return "handed-over";
    default:
      return undefined;
  }
}
