import type {
  InvoiceDueReminder,
  InvoiceReminder,
} from "../../../gen/notifications/v1/notifications_pb.js";
import type { RenderContext, RenderResult } from "../delivery/index.js";
import { money } from "../format.js";
import type { LotNoticeReads } from "./lot-notice.js";

// Напоминание о неоплаченном счёте (PER-330) с кнопкой на счёт (PER-322). У
// двух ботов весть одна: участнику её доставляет бот хаба, гостю — бот
// аукциона (ADR-064). Здесь разбор ветки, чтение названия, текст и кнопка;
// данные кнопки каждая поверхность кодирует своим следом, как у вестей о лотах.
//
// Права `place-bids` канал перед этой вестью не спрашивает: счёт — дело
// победителя, и о долге знать нужно и тому, у кого право сняли после продажи.

export type InvoiceNotice = {
  // Первое напоминание — через ~12 часов после выставления, второе — за сутки
  // до срока (integration.md, «Счёт на шине»).
  kind: "invoice-reminder" | "invoice-due-reminder";
  invoiceId: string;
  lotId: string;
  amount: { minorUnits: number; currency: string };
  // RFC 3339 в UTC.
  paymentDueAt: string;
};

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Факт — ввод соседа: счёт без суммы, срока или канонических идентификаторов
// — дефект издателя, и разбор отвечает `undefined`, как у остальных веток.
export function invoiceNoticeOf(
  kind: InvoiceNotice["kind"],
  value: InvoiceReminder | InvoiceDueReminder,
): InvoiceNotice | undefined {
  const { invoiceId, lotId, amount, paymentDueAt } = value;
  if (!CANONICAL_UUID.test(invoiceId) || !CANONICAL_UUID.test(lotId)) {
    return undefined;
  }
  if (amount === undefined || Number.isNaN(Date.parse(paymentDueAt))) {
    return undefined;
  }
  const minorUnits = Number(amount.minorUnits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) return undefined;
  return {
    kind,
    invoiceId,
    lotId,
    amount: { minorUnits, currency: amount.currency },
    paymentDueAt,
  };
}

export function isInvoiceNotice(content: {
  kind: string;
}): content is InvoiceNotice {
  return (
    content.kind === "invoice-reminder" ||
    content.kind === "invoice-due-reminder"
  );
}

// Кнопка следа: счёт приходит новым сообщением, весть остаётся в истории.
export type InvoiceNoticeButton = {
  lotId: string;
  invoiceId: string;
  text: string;
};

export type InvoiceNoticeView = { text: string; button: InvoiceNoticeButton };

const toInvoiceLabel = "К счёту";

// Срок — дата и время по часам сообщества: до него сутки и больше.
function dueMoment(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instant));
}

// Одна фраза на «ты», без заголовка и разметки (дизайн-код, «Уведомления
// аукциона»). Название — подсказка: без него весть называет просто лот.
export function renderInvoiceNotice(
  notice: InvoiceNotice,
  options: { title?: string; timeZone: string },
): InvoiceNoticeView {
  const lot = options.title === undefined ? "лот" : `«${options.title}»`;
  const due = dueMoment(notice.paymentDueAt, options.timeZone);
  const sum = money(notice.amount);
  return {
    text:
      notice.kind === "invoice-reminder"
        ? `Счёт за ${lot} — ${sum} — ждёт оплаты до ${due}. Как оплатить и получить — в счёте.`
        : `Срок оплаты счёта за ${lot} — ${sum} — истекает ${due}. Как оплатить и получить — в счёте.`,
    button: {
      lotId: notice.lotId,
      invoiceId: notice.invoiceId,
      text: toInvoiceLabel,
    },
  };
}

// Название лота читается у Auction глазами получателя; отказ чтения весть не
// снимает — она уходит без названия, а отказ пишется в лог.
export function createInvoiceNoticeRender(options: {
  reads?: LotNoticeReads | undefined;
  onTitleMissing: (cause: unknown, requestId?: string) => void;
  timeZone: string;
}): (
  notice: InvoiceNotice,
  context: RenderContext,
) => Promise<RenderResult<InvoiceNoticeView>> {
  return async (notice, { recipientId, requestId }) => {
    let title: string | undefined;
    if (options.reads !== undefined) {
      try {
        const info = await options.reads.lotInfo(
          recipientId,
          notice.lotId,
          requestId,
        );
        title = info.title === "" ? undefined : info.title;
      } catch (cause) {
        options.onTitleMissing(cause, requestId);
      }
    }
    return {
      kind: "ready",
      message: renderInvoiceNotice(notice, {
        ...(title === undefined ? {} : { title }),
        timeZone: options.timeZone,
      }),
    };
  };
}
