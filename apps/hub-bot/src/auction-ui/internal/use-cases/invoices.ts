import { encodeAuctionCallback } from "../../callback-data.js";
import type { AuctionPort, Viewer, WinnerInvoiceView } from "../../ports.js";
import type {
  AuctionButton,
  AuctionScreenBody,
  InvoiceItem,
} from "../../screen.js";
import type { CommandContext } from "./commands.js";

// Сырые юзкейсы счетов победителя (PER-322; integration.md, «Счета»). Доступ
// проверил шлюз; чужих счетов Auction не отдаёт, а чужой счёт на выборе
// способа неотличим от несуществующего. Каждый экран читает счета заново:
// отметка организатора видна на следующем открытии без перезапуска бота.

// Ждущие оплаты — первыми, по сроку; затем оплаченные и выданные.
const STATUS_ORDER = { "awaiting-payment": 0, paid: 1, "handed-over": 2 };

function ordered(
  invoices: readonly WinnerInvoiceView[],
): readonly WinnerInvoiceView[] {
  return [...invoices].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.paymentDueAt ?? "").localeCompare(b.paymentDueAt ?? "") ||
      a.invoiceId.localeCompare(b.invoiceId),
  );
}

// Название — подсказка: отказ чтения лота оставляет строку без него, а не
// роняет экран.
async function titleOf(
  auction: AuctionPort,
  viewer: Viewer,
  lotId: string,
): Promise<string | undefined> {
  try {
    return (await auction.findLot({ viewer, lotId }))?.card?.title;
  } catch {
    return undefined;
  }
}

const toInvoices = (auctionId: string): AuctionButton => ({
  action: "invoice.back",
  callbackData: encodeAuctionCallback({ kind: "invoices", auctionId }),
});

// Есть ли у смотрящего счета в аукционе: корень ставит вход, только когда
// есть. Отказ чтения убирает кнопку, а не роняет корень.
export async function hasInvoices(input: {
  auction: AuctionPort;
  viewer: Viewer;
  auctionId: string;
}): Promise<boolean> {
  try {
    const mine = await input.auction.listMyInvoices({
      viewer: input.viewer,
      auctionId: input.auctionId,
    });
    return mine.invoices.length > 0;
  } catch {
    return false;
  }
}

export async function openInvoices(
  context: CommandContext,
  auctionId: string,
): Promise<AuctionScreenBody> {
  const mine = await context.auction.listMyInvoices({
    viewer: context.viewer,
    auctionId,
  });
  const invoices: InvoiceItem[] = await Promise.all(
    ordered(mine.invoices).map(async (invoice) => {
      const title = await titleOf(
        context.auction,
        context.viewer,
        invoice.lotId,
      );
      return title === undefined ? invoice : { ...invoice, title };
    }),
  );
  return {
    blocks: [
      {
        kind: "invoices",
        auctionId,
        invoices,
        ...(mine.paymentInstructions === undefined
          ? {}
          : { paymentInstructions: mine.paymentInstructions }),
      },
    ],
    keyboard: [
      ...invoices.map((invoice) => [
        {
          action: "invoices.open" as const,
          invoiceId: invoice.invoiceId,
          callbackData: encodeAuctionCallback({
            kind: "invoice",
            lotId: invoice.lotId,
            invoiceId: invoice.invoiceId,
          }),
        },
      ]),
      [
        {
          action: "invoices.back",
          callbackData: encodeAuctionCallback({ kind: "root", auctionId }),
        },
      ],
    ],
  };
}

export async function openInvoice(
  context: CommandContext,
  lotId: string,
  invoiceId: string,
): Promise<AuctionScreenBody> {
  const lot = await context.auction.findLot({ viewer: context.viewer, lotId });
  if (lot === undefined) {
    return {
      blocks: [{ kind: "invoice-missing" }],
      keyboard: [
        [
          {
            action: "invoice.retry",
            callbackData: encodeAuctionCallback({
              kind: "invoice",
              lotId,
              invoiceId,
            }),
          },
        ],
      ],
    };
  }
  const mine = await context.auction.listMyInvoices({
    viewer: context.viewer,
    auctionId: lot.auctionId,
  });
  const invoice = mine.invoices.find((each) => each.invoiceId === invoiceId);
  if (invoice === undefined) {
    return {
      blocks: [{ kind: "invoice-missing", auctionId: lot.auctionId }],
      keyboard: [[toInvoices(lot.auctionId)]],
    };
  }
  const title = lot.card?.title;
  return {
    blocks: [
      {
        kind: "invoice",
        auctionId: lot.auctionId,
        invoice: title === undefined ? invoice : { ...invoice, title },
        ...(mine.paymentInstructions === undefined
          ? {}
          : { paymentInstructions: mine.paymentInstructions }),
      },
    ],
    keyboard: [[toInvoices(lot.auctionId)]],
  };
}
