import { InlineKeyboard } from "grammy";
import { money, truncate } from "../../../../core/format.js";
import type {
  FulfillmentMethod,
  InvoiceMark,
  InvoiceMarkNote,
  InvoiceRow,
  InvoiceTotals,
  LotAmount,
} from "../../application/types.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleInvoiceData,
  consoleInvoiceMarkConfirmData,
  consoleInvoiceMarkData,
  consoleInvoicesData,
  consoleViewData,
} from "../parse-callback.js";
import {
  bullet,
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  pagedTitle,
  paginate,
  plural,
  readableMoment,
  screenText,
  subjectLine,
  submenuText,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Счета проданных лотов в пульте организатора (PER-321): сводка с итогом
// собранного и ожидаемого, счёт с отметкой оплаты или выдачи, подтверждение
// и исход. Вход — ряд «Счета» пульта, как только лоты продаются. Деньги через
// бота не идут: оплату организатор отмечает руками, когда получил перевод.

const untitled = "Лот без названия";
const unnamed = "победитель без имени";
const titleLimit = 120;

export const invoicesLabel = "Счета";

type Clock = { timeZone: string; today: CommunityDay };

function lotTitle(invoice: InvoiceRow): string {
  return truncate(invoice.title ?? untitled, titleLimit);
}

function winnerOf(invoice: InvoiceRow): string {
  return invoice.winnerName ?? unnamed;
}

function momentOf(at: string, clock: Clock): string {
  return readableMoment(communityLocalTime(at, clock.timeZone), clock.today);
}

const fulfillmentText: Record<FulfillmentMethod, string> = {
  unspecified: "способ получения не выбран",
  pickup: "самовывоз",
  delivery: "доставка",
  digital: "цифровой лот",
};

function statusText(invoice: InvoiceRow, clock: Clock): string {
  switch (invoice.status) {
    case "awaiting-payment":
      return invoice.overdue
        ? `просрочен, срок был ${momentOf(invoice.paymentDueAt, clock)}`
        : `ждёт оплаты до ${momentOf(invoice.paymentDueAt, clock)}`;
    case "paid":
      return "оплачен, ждёт выдачи";
    case "handed-over":
      return "выдан";
    default: {
      const _exhaustive: never = invoice.status;
      return _exhaustive;
    }
  }
}

// Суммы разных валют не складываются: каждая валюта своей суммой.
function sumText(amounts: readonly LotAmount[]): string {
  return amounts.length === 0 ? "ничего" : amounts.map(money).join(" и ");
}

function toInvoices(auctionId: string): Parent {
  return {
    name: invoicesLabel,
    data: consoleInvoicesData(uuidToToken(auctionId)),
  };
}

function toInvoice(invoice: InvoiceRow): Parent {
  return {
    name: "Счёт",
    data: consoleInvoiceData(
      uuidToToken(invoice.auctionId),
      uuidToToken(invoice.invoiceId),
    ),
  };
}

/**
 * Сводка: итог собранного и ожидаемого, число просроченных и строка на счёт —
 * лот, победитель, сумма, статус и способ получения. Просроченные первыми:
 * порядок даёт юзкейс. Кнопка на строку открывает счёт с отметкой.
 */
export function invoicesScreen(
  view: {
    auctionId: string;
    invoices: readonly InvoiceRow[];
    totals: InvoiceTotals;
    page: number;
  } & Clock,
): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const page = paginate(view.invoices, view.page);
  const keyboard = new InlineKeyboard();
  for (const invoice of page.items) {
    nextRow(keyboard).text(
      buttonText(`${lotTitle(invoice)} · ${winnerOf(invoice)}`),
      consoleInvoiceData(auction, uuidToToken(invoice.invoiceId)),
    );
  }
  withPager(keyboard, page, (at) => consoleInvoicesData(auction, at));
  const overdue = view.invoices.filter((invoice) => invoice.overdue).length;
  return {
    id: "invoices",
    text: screenText(
      pagedTitle(invoicesLabel, page),
      view.invoices.length === 0
        ? escapeHtml(
            "Проданных лотов пока нет. Счёт появляется на каждый проданный лот.",
          )
        : escapeHtml(
            [
              `Собрано: ${sumText(view.totals.collected)}.`,
              `Ожидается: ${sumText(view.totals.expected)}.`,
              ...(overdue === 0
                ? []
                : [
                    `Просрочено: ${plural(overdue, ["счёт", "счёта", "счетов"])}.`,
                  ]),
            ].join("\n"),
          ),
      page.items
        .map((invoice) =>
          escapeHtml(
            bullet(
              `${lotTitle(invoice)} — ${winnerOf(invoice)}, ${money(invoice.amount)}: ${statusText(invoice, view)}, ${fulfillmentText[invoice.fulfillment]}.`,
            ),
          ),
        )
        .join("\n"),
    ),
    keyboard: withNav(keyboard, {
      name: "Пульт",
      data: consoleViewData(auction),
    }),
    format: "HTML",
  };
}

// Следующая отметка счёта: оплата, затем выдача; у выданного отмечать нечего.
function nextMark(invoice: InvoiceRow): InvoiceMark | undefined {
  switch (invoice.status) {
    case "awaiting-payment":
      return "paid";
    case "paid":
      return "handed-over";
    case "handed-over":
      return undefined;
    default: {
      const _exhaustive: never = invoice.status;
      return _exhaustive;
    }
  }
}

const markLabel: Record<InvoiceMark, string> = {
  paid: "Отметить оплату",
  "handed-over": "Отметить выдачу",
};

/** Счёт: поля и одна кнопка следующей отметки. */
export function invoiceScreen(
  view: { invoice: InvoiceRow } & Clock,
): ShownScreen {
  const { invoice } = view;
  const keyboard = new InlineKeyboard();
  const mark = nextMark(invoice);
  if (mark !== undefined) {
    keyboard.text(
      markLabel[mark],
      consoleInvoiceMarkData(
        uuidToToken(invoice.auctionId),
        uuidToToken(invoice.invoiceId),
        mark,
      ),
    );
  }
  return {
    id: "invoice",
    text: submenuText(
      "Счёт",
      lotTitle(invoice),
      escapeHtml(
        [
          `Победитель: ${winnerOf(invoice)}.`,
          `Сумма: ${money(invoice.amount)}.`,
          `Статус: ${statusText(invoice, view)}.`,
          `Получение: ${fulfillmentText[invoice.fulfillment]}.`,
        ].join("\n"),
      ),
    ),
    keyboard: withNav(keyboard, toInvoices(invoice.auctionId)),
    format: "HTML",
  };
}

/**
 * Подтверждение отметки. Снять отметку нельзя — обратной команды у счёта нет,
 * — поэтому «Да» красное. Ключ команды рождается на нажатие: повтор того же
 * «Да» Auction примет без второго перехода.
 */
export function invoiceMarkConfirmScreen(view: {
  invoice: InvoiceRow;
  mark: InvoiceMark;
}): ShownScreen {
  const { invoice } = view;
  const auction = uuidToToken(invoice.auctionId);
  const token = uuidToToken(invoice.invoiceId);
  return {
    id: "invoice-mark-confirm",
    text: screenText(
      `${markLabel[view.mark]}?`,
      subjectLine(lotTitle(invoice)),
      escapeHtml(
        `Победитель: ${winnerOf(invoice)}. Сумма: ${money(invoice.amount)}.`,
      ),
      escapeHtml(
        view.mark === "paid"
          ? "Отмечай, когда перевод уже пришёл. Снять отметку нельзя."
          : "Отмечай, когда лот у победителя. Снять отметку нельзя.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, отметить",
      yesData: consoleInvoiceMarkConfirmData(auction, token, view.mark),
      noData: consoleInvoiceData(auction, token),
      irreversible: true,
    }),
    format: "HTML",
  };
}

function noteText(mark: InvoiceMark, note: InvoiceMarkNote): string {
  switch (note) {
    case "marked":
      return mark === "paid"
        ? "Оплата отмечена. Лот можно выдавать."
        : "Выдача отмечена. Счёт закрыт.";
    case "already-marked":
      return mark === "paid"
        ? "Оплата уже отмечена. Второй раз она не записывается."
        : "Выдача уже отмечена. Второй раз она не записывается.";
    case "not-paid":
      return "Выдать пока нельзя. Счёт не оплачен: сначала отметь оплату.";
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

/** Исход отметки — свой экран с возвратом к счёту. */
export function invoiceMarkOutcomeScreen(view: {
  invoice: InvoiceRow;
  mark: InvoiceMark;
  note: InvoiceMarkNote;
}): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(noteText(view.mark, view.note), lotTitle(view.invoice)),
    keyboard: withNav(new InlineKeyboard(), toInvoice(view.invoice)),
    format: "HTML",
  };
}

/** Счёта по кнопке нет в аукционе: исход с возвратом к сводке. */
export function invoiceMissingScreen(auctionId: string): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText("Счёт не найден. Открой счета аукциона заново."),
    keyboard: withNav(new InlineKeyboard(), toInvoices(auctionId)),
    format: "HTML",
  };
}
