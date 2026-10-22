import { Code, ConnectError } from "@connectrpc/connect";
import { FulfillmentMethod } from "../../../gen/auction/v1/auction_pb.js";
import type {
  ChooseFulfillmentResponse,
  InvoiceSnapshot,
  ListMyInvoicesResponse,
} from "../../../gen/auction/v1/auction_service_pb.js";
import type {
  FulfillmentOutcome,
  FulfillmentMethod as FulfillmentView,
  InvoiceStatus,
  MyInvoicesView,
  WinnerInvoiceView,
} from "../../auction-ui/index.js";
import { unansweredOn } from "./commands.js";
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
  const fulfillment = fulfillmentViewOf(snapshot.fulfillment);
  return {
    invoiceId: snapshot.id,
    lotId: snapshot.lotId,
    amount: moneyOf(snapshot.amount),
    paymentDueAt: snapshot.paymentDueAt,
    ...(fulfillment === undefined ? {} : { fulfillment }),
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

// Способ новее схемы показывается невыбранным: счёт важнее подписи способа.
function fulfillmentViewOf(
  method: FulfillmentMethod,
): FulfillmentView | undefined {
  switch (method) {
    case FulfillmentMethod.PICKUP:
      return "pickup";
    case FulfillmentMethod.DELIVERY:
      return "delivery";
    case FulfillmentMethod.DIGITAL:
      return "digital";
    default:
      return undefined;
  }
}

export function wireFulfillment(method: FulfillmentView): FulfillmentMethod {
  switch (method) {
    case "pickup":
      return FulfillmentMethod.PICKUP;
    case "delivery":
      return FulfillmentMethod.DELIVERY;
    case "digital":
      return FulfillmentMethod.DIGITAL;
    default: {
      const _exhaustive: never = method;
      return _exhaustive;
    }
  }
}

// Выбор способа: `NOT_FOUND` — счёта нет или он чужой, это ответ, а не сбой;
// молчание Auction — `unanswered`, как у команд участника.
export function fulfillmentOutcomeOn(
  call: () => Promise<ChooseFulfillmentResponse>,
): Promise<FulfillmentOutcome> {
  return unansweredOn(async () => {
    try {
      return fulfillmentOutcomeOf(await call());
    } catch (cause) {
      if (cause instanceof ConnectError && cause.code === Code.NotFound) {
        return { kind: "not-found" as const };
      }
      throw cause;
    }
  });
}

function fulfillmentOutcomeOf(
  response: ChooseFulfillmentResponse,
): FulfillmentOutcome {
  switch (response.outcome.case) {
    case "accepted":
      return { kind: "accepted" };
    case "refused":
      if (response.outcome.value.reason.case === "fulfillmentFrozen") {
        return { kind: "refused", refusal: "fulfillment-frozen" };
      }
      throw new Error("fulfillment refusal without a known reason");
    default:
      throw new Error("fulfillment response without an outcome");
  }
}
