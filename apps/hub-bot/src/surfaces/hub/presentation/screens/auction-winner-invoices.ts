import { InlineKeyboard } from "grammy";
import type {
  AuctionBlock,
  AuctionButton,
} from "../../../../auction-ui/index.js";
import {
  invoiceLabel,
  invoiceMissingParagraphs,
  invoiceMissingTitle,
  invoiceParagraphs,
  invoicesBackLabel,
  invoicesBackName,
  invoicesParagraphs,
  invoicesTitle,
  invoiceTitle,
} from "../../../../auction-winner-invoices.js";
import { type CommunityDay, communityLocalTime } from "../../community-time.js";
import {
  nextRow,
  readableMoment,
  retryLabel,
  screenText,
  toAuctionRoot,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Счета победителя в оболочке хаба (PER-322): список открывает «Мои счета» в
// корне аукциона сходки, возврат — в корень, со счёта — «‹ Счета». Тексты
// общие с ботом аукциона (`src/auction-winner-invoices.ts`), оболочка ставит
// навигацию и момент в поясе сообщества.

type Keyboard = readonly (readonly AuctionButton[])[];
type View = { timeZone: string; today: CommunityDay };

const moment = (view: View) => (instant: string) =>
  readableMoment(communityLocalTime(instant, view.timeZone), view.today);

function dataOf(keyboard: Keyboard, action: AuctionButton["action"]): string {
  const button = keyboard.flat().find((each) => each.action === action);
  if (button === undefined) throw new Error(`body without ${action}`);
  return button.callbackData;
}

export function invoicesScreen(
  block: Extract<AuctionBlock, { kind: "invoices" }>,
  keyboard: Keyboard,
  view: View,
): ShownScreen {
  const rows = new InlineKeyboard();
  for (const button of keyboard.flat()) {
    if (button.action === "invoices.open") {
      const item = block.invoices.find(
        (each) => each.invoiceId === button.invoiceId,
      );
      nextRow(rows).text(invoiceLabel(item), button.callbackData);
    }
  }
  return {
    id: "my-invoices",
    text: screenText(
      invoicesTitle,
      ...invoicesParagraphs(block, { moment: moment(view) }),
    ),
    keyboard: withNav(rows, toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}

export function invoiceScreen(
  block: Extract<AuctionBlock, { kind: "invoice" }>,
  keyboard: Keyboard,
  view: View,
): ShownScreen {
  const rows = new InlineKeyboard();
  return {
    id: "my-invoice",
    text: screenText(
      invoiceTitle(block),
      ...invoiceParagraphs(block, { moment: moment(view) }),
    ),
    keyboard: withNav(rows, {
      name: invoicesBackName,
      data: dataOf(keyboard, "invoice.back"),
    }),
    format: "HTML",
  };
}

// Счёта по кнопке нет: «‹ Счета», если лот прочитался, иначе «Повторить».
export function invoiceMissingScreen(keyboard: Keyboard): ShownScreen {
  const back = keyboard.flat().find((each) => each.action === "invoice.back");
  const rows = new InlineKeyboard();
  if (back === undefined) {
    rows.text(retryLabel, dataOf(keyboard, "invoice.retry"));
  } else {
    rows.text(invoicesBackLabel, back.callbackData);
  }
  return {
    id: "my-invoice-missing",
    text: screenText(invoiceMissingTitle, ...invoiceMissingParagraphs()),
    keyboard: rows,
    format: "HTML",
  };
}
