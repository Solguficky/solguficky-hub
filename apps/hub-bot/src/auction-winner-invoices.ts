import type { AuctionBlock, InvoiceItem, Money } from "./auction-ui/index.js";
import { money, truncate } from "./core/format.js";

// Тексты счетов победителя (PER-322) общие у обеих поверхностей: счёт один,
// и его слова не должны расходиться между ботами. Навигацию и формат момента
// задаёт оболочка. Деньги идут мимо продукта: как оплатить и получить, пишет
// организатор, и бот его текст показывает как есть.

export const invoicesTitle = "Мои счета";
export const invoicesButtonLabel = "Мои счета";
export const invoicesBackName = "Счета";
export const invoicesBackLabel = `‹ ${invoicesBackName}`;
export const invoiceMissingTitle = "Счёт не найден";

const instructionsHeading = "<b>Как оплатить и получить</b>";
const noInstructions =
  "Как оплатить и получить, организатор ещё не написал. Загляни сюда позже.";

export type InvoiceTextOptions = {
  // Момент RFC 3339 для чтения в поясе сообщества.
  moment: (instant: string) => string;
};

// Подпись кнопки счёта в списке: название и сумма.
export function invoiceLabel(item: InvoiceItem | undefined): string {
  if (item === undefined) return "Счёт";
  return `${truncate(item.title ?? "Лот", 40)} · ${money(item.amount)}`;
}

function statusLine(item: InvoiceItem, options: InvoiceTextOptions): string {
  switch (item.status) {
    case "awaiting-payment":
      return `ждёт оплаты до ${options.moment(item.paymentDueAt)}`;
    case "paid":
      return "оплачен, ждёт выдачи";
    case "handed-over":
      return "выдан";
    default: {
      const _exhaustive: never = item.status;
      return _exhaustive;
    }
  }
}

// Сумма корзины по валютам: разные валюты не складываются.
function totals(amounts: readonly Money[]): string {
  const byCurrency = new Map<string, number>();
  for (const amount of amounts) {
    byCurrency.set(
      amount.currency,
      (byCurrency.get(amount.currency) ?? 0) + amount.minorUnits,
    );
  }
  return [...byCurrency]
    .map(([currency, minorUnits]) => money({ currency, minorUnits }))
    .join(" + ");
}

function instructionsParagraph(text: string | undefined): string {
  return text === undefined
    ? noInstructions
    : `${instructionsHeading}\n${escapeHtml(text)}`;
}

/** Абзацы списка счетов под заголовком, уже экранированные. */
export function invoicesParagraphs(
  block: Extract<AuctionBlock, { kind: "invoices" }>,
  options: InvoiceTextOptions,
): string[] {
  if (block.invoices.length === 0) {
    return ["Счетов в этом аукционе у тебя нет."];
  }
  const lines = block.invoices.map(
    (item) =>
      `• ${escapeHtml(item.title ?? "Лот")} — ${money(item.amount)}, ${escapeHtml(statusLine(item, options))}`,
  );
  const awaiting = block.invoices.filter(
    (item) => item.status === "awaiting-payment",
  );
  return [
    lines.join("\n"),
    [
      `Всего: <b>${totals(block.invoices.map((item) => item.amount))}</b>`,
      ...(awaiting.length === 0 || awaiting.length === block.invoices.length
        ? []
        : [`Ждёт оплаты: ${totals(awaiting.map((item) => item.amount))}`]),
    ].join("\n"),
    instructionsParagraph(block.paymentInstructions),
  ];
}

export function invoiceTitle(
  block: Extract<AuctionBlock, { kind: "invoice" }>,
): string {
  return `Счёт: ${block.invoice.title ?? "лот"}`;
}

/** Абзацы экрана счёта под заголовком, уже экранированные. */
export function invoiceParagraphs(
  block: Extract<AuctionBlock, { kind: "invoice" }>,
  options: InvoiceTextOptions,
): string[] {
  const { invoice } = block;
  return [
    [
      `Сумма: <b>${money(invoice.amount)}</b>`,
      `Статус: ${escapeHtml(statusLine(invoice, options))}`,
    ].join("\n"),
    instructionsParagraph(block.paymentInstructions),
  ];
}

export function invoiceMissingParagraphs(): string[] {
  return ["Открой счета аукциона заново."];
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
