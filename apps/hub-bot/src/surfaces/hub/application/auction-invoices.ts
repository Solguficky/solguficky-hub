import { rpcMeta } from "../../../core/rpc-metadata.js";
import type { AuctionConsoles, AuctionFailure } from "../auction/port.js";
import type {
  AuctionInvoicesRequest,
  ExecuteResult,
  Invoice,
  InvoiceMark,
  InvoiceRow,
  InvoiceTotals,
  LotAmount,
} from "./types.js";

// Счета проданных лотов в пульте организатора (PER-321; integration.md,
// «Счета»): сводка, счёт, подтверждение отметки оплаты или выдачи и исход.
// Своего состояния нет: аукцион и счёт едут в кнопке, ключ отметки рождается
// на нажатие «Да», а каждое действие читает счета заново. Право решает
// Auction у Meetups; пускает сюда край — держателя права вести аукцион.
//
// Статусы и переходы — у счёта в Auction: повторная отметка с новым ключом
// принимается без второго перехода. Просрочку и итоги Auction не считает —
// их считает край из полного списка счетов аукциона.

function failed(failure: AuctionFailure): ExecuteResult {
  return failure.kind === "invalid"
    ? { kind: "dependency-rejected", reason: "invalid", cause: failure.cause }
    : { kind: "dependency-rejected", reason: failure.kind };
}

const notAdministrator: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "not-administrator",
};
const auctionNotFound: ExecuteResult = {
  kind: "auction-console-refused",
  reason: "auction-not-found",
};

/** Просрочен — ждёт оплаты после срока; оплаченный не просрочен никогда. */
export function isOverdue(invoice: Invoice, now: Date): boolean {
  return (
    invoice.status === "awaiting-payment" &&
    Date.parse(invoice.paymentDueAt) < now.getTime()
  );
}

/**
 * Собрано — сумма оплаченных и выданных счетов, ожидается — ждущих оплаты;
 * по валюте отдельно, в порядке первой встречи валюты.
 */
export function totalsOf(invoices: readonly Invoice[]): InvoiceTotals {
  const add = (sums: Map<string, number>, amount: LotAmount) =>
    sums.set(
      amount.currency,
      (sums.get(amount.currency) ?? 0) + amount.minorUnits,
    );
  const collected = new Map<string, number>();
  const expected = new Map<string, number>();
  for (const invoice of invoices) {
    add(
      invoice.status === "awaiting-payment" ? expected : collected,
      invoice.amount,
    );
  }
  const amounts = (sums: Map<string, number>): LotAmount[] =>
    [...sums].map(([currency, minorUnits]) => ({ currency, minorUnits }));
  return { collected: amounts(collected), expected: amounts(expected) };
}

// Порядок сводки: сначала то, что требует действия, — просроченные, затем
// ждущие оплаты, оплаченные и выданные; внутри — порядок заведения лотов
// (идентификатор лота UUIDv7), как у пульта. Сравнение строк, а не `localeCompare`:
// страница едет в кнопке и переживает перезапуск процесса.
const statusRank = { "awaiting-payment": 1, paid: 2, "handed-over": 3 };

function compareRows(a: InvoiceRow, b: InvoiceRow): number {
  const rank = (row: InvoiceRow) => (row.overdue ? 0 : statusRank[row.status]);
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank;
  return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
}

// Какая отметка уже стоит: выдача включает оплату.
function marked(invoice: Invoice, mark: InvoiceMark): boolean {
  return mark === "paid"
    ? invoice.status !== "awaiting-payment"
    : invoice.status === "handed-over";
}

export function createAuctionInvoices(
  consoles: AuctionConsoles,
  now: () => Date = () => new Date(),
) {
  type Read =
    | { kind: "ok"; rows: readonly InvoiceRow[]; invoices: readonly Invoice[] }
    | { kind: "refused"; result: ExecuteResult };

  // Счета решают право и существование аукциона; названия лотов и имена
  // победителей — подсказки, их отказ оставляет строки без них, а не роняет
  // сводку. Пульт и имена читаются параллельно после счетов: без права
  // их не спрашивают.
  async function read(request: AuctionInvoicesRequest): Promise<Read> {
    const meta = rpcMeta(request);
    const found = await consoles.listAuctionInvoices(
      request.identity,
      request.auctionId,
      meta,
    );
    switch (found.kind) {
      case "ok":
        break;
      case "not-administrator":
      case "meetup-not-found":
        return { kind: "refused", result: notAdministrator };
      case "auction-not-found":
        return { kind: "refused", result: auctionNotFound };
      default:
        return { kind: "refused", result: failed(found) };
    }
    if (found.invoices.length === 0) {
      return { kind: "ok", rows: [], invoices: [] };
    }
    // Имена — по победителям, а не списком имён аукциона: тот сужен правом
    // ставить сейчас, и победитель, потерявший право после покупки, остался
    // бы без имени.
    const winnerIds = [...new Set(found.invoices.map((each) => each.winnerId))];
    const [console, names] = await Promise.all([
      consoles.getAuctionConsole(request.identity, request.auctionId, meta),
      consoles.displayNames(
        request.identity,
        { auctionId: request.auctionId, participantIds: winnerIds },
        meta,
      ),
    ]);
    const titles = new Map(
      console.kind === "ok"
        ? console.console.lots.flatMap((entry) =>
            entry.lot.card?.title === undefined
              ? []
              : [[entry.lot.lotId, entry.lot.card.title] as const],
          )
        : [],
    );
    const winners = new Map(
      names.kind === "ok" ? Object.entries(names.names) : [],
    );
    const at = now();
    const rows = found.invoices
      .map((invoice): InvoiceRow => {
        const title = titles.get(invoice.lotId);
        const winnerName = winners.get(invoice.winnerId);
        return {
          ...invoice,
          ...(title === undefined ? {} : { title }),
          ...(winnerName === undefined || winnerName === ""
            ? {}
            : { winnerName }),
          overdue: isOverdue(invoice, at),
        };
      })
      .sort(compareRows);
    return { kind: "ok", rows, invoices: found.invoices };
  }

  type Found =
    | { kind: "ok"; invoice: InvoiceRow }
    | { kind: "refused"; result: ExecuteResult };

  // Счёт по кнопке ищется в счетах аукциона кнопки: счёт другого аукциона —
  // такая же подделка, как несуществующий.
  async function invoiceRead(
    request: Extract<AuctionInvoicesRequest, { invoiceId: string }>,
  ): Promise<Found> {
    const current = await read(request);
    if (current.kind === "refused") return current;
    const invoice = current.rows.find(
      (row) => row.invoiceId === request.invoiceId,
    );
    return invoice === undefined
      ? {
          kind: "refused",
          result: { kind: "invoice-missing", auctionId: request.auctionId },
        }
      : { kind: "ok", invoice };
  }

  async function mark(
    request: Extract<AuctionInvoicesRequest, { intent: "mark-invoice" }>,
  ): Promise<ExecuteResult> {
    const before = await invoiceRead(request);
    if (before.kind === "refused") return before.result;
    const answer = await consoles.markInvoice(
      request.identity,
      { invoiceId: request.invoiceId, mark: request.mark, opId: request.opId },
      rpcMeta(request),
    );
    const outcome = (
      invoice: InvoiceRow,
      note: "marked" | "already-marked" | "not-paid",
    ): ExecuteResult => ({
      kind: "invoice-mark-outcome",
      invoice,
      mark: request.mark,
      note,
    });
    switch (answer.kind) {
      case "ok":
        break;
      case "invoice-not-paid":
        return outcome(before.invoice, "not-paid");
      case "invoice-not-found":
        return { kind: "invoice-missing", auctionId: request.auctionId };
      case "not-administrator":
      case "meetup-not-found":
        return notAdministrator;
      default:
        return failed(answer);
    }
    // Ответ Auction одинаков, был переход или нет, поэтому повтор бот узнаёт
    // только по чтению до «Да»: оно отстаёт от команд, и отметку, которую
    // чтение ещё не видит, исход называет просто отмеченной — это тоже верно.
    // Обратной ошибки нет: проекция счёта монотонна. Строка исхода — счёт с
    // новым статусом: чтение после команды отстаёт от неё, а переход решён.
    if (marked(before.invoice, request.mark)) {
      return outcome(before.invoice, "already-marked");
    }
    const status = request.mark === "paid" ? "paid" : "handed-over";
    return outcome({ ...before.invoice, status, overdue: false }, "marked");
  }

  return async (request: AuctionInvoicesRequest): Promise<ExecuteResult> => {
    switch (request.intent) {
      case "view-auction-invoices": {
        const current = await read(request);
        return current.kind === "refused"
          ? current.result
          : {
              kind: "auction-invoices",
              auctionId: request.auctionId,
              invoices: current.rows,
              totals: totalsOf(current.invoices),
              page: request.page,
            };
      }
      case "view-auction-invoice": {
        const found = await invoiceRead(request);
        return found.kind === "refused"
          ? found.result
          : { kind: "auction-invoice", invoice: found.invoice };
      }
      // Подтверждение по уже стоящей отметке не задаётся: кнопка устарела,
      // и исход называет, что отметка уже есть.
      case "prepare-invoice-mark": {
        const found = await invoiceRead(request);
        if (found.kind === "refused") return found.result;
        if (marked(found.invoice, request.mark)) {
          return {
            kind: "invoice-mark-outcome",
            invoice: found.invoice,
            mark: request.mark,
            note: "already-marked",
          };
        }
        if (
          request.mark === "handed-over" &&
          found.invoice.status === "awaiting-payment"
        ) {
          return {
            kind: "invoice-mark-outcome",
            invoice: found.invoice,
            mark: request.mark,
            note: "not-paid",
          };
        }
        return {
          kind: "invoice-mark-confirm",
          invoice: found.invoice,
          mark: request.mark,
        };
      }
      case "mark-invoice":
        return mark(request);
      default: {
        const _exhaustive: never = request;
        return _exhaustive;
      }
    }
  };
}
