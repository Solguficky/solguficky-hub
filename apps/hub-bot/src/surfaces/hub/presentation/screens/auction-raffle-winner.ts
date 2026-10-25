import { InlineKeyboard } from "grammy";
import type {
  RaffleTicketView,
  RaffleView,
} from "../../../../auction-ui/index.js";
import type {
  RaffleWinnerAskError,
  RaffleWinnerOutcome,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleRaffleWinnerAskData,
  consoleRaffleWinnerConfirmData,
  consoleRaffleWinnerData,
  consoleViewData,
} from "../parse-callback.js";
import {
  confirmKeyboard,
  escapeHtml,
  outcomeText,
  type Parent,
  pagedTitle,
  screenText,
  subjectLine,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Итог розыгрыша вручную (PER-727; ADR-066, дополнение 2026-10-24): экран
// администратора со списком билетов, вопрос о номере выигравшего билета,
// подтверждение с именем и исход. Победителя выбирают на внешнем сайте с
// колесом, поэтому список — полный и удобный для копирования: строка на
// билет блоком `<pre>`, который клиент Telegram копирует одним нажатием.

export const raffleWinnerLabel = "Итог розыгрыша";
const askLabel = "Ввести победителя";
const retryLabel = "Ввести заново";

/**
 * Билетов на страницу списка. Сообщение Telegram — до 4096 знаков, а строка
 * билета — до 43: «№» и номер, « — » и имя до 33 знаков (ник с «@» не длиннее
 * 32). Восемьдесят строк — до 3440 знаков с запасом под заголовок и
 * пояснение; пул больше листается, а не режется.
 */
export const raffleWinnerPageSize = 80;

function toConsole(auctionId: string): Parent {
  return { name: "Пульт", data: consoleViewData(uuidToToken(auctionId)) };
}

/** Строка билета: номер и имя в аукционе; имени нет — один номер. */
export function ticketLine(ticket: RaffleTicketView): string {
  return ticket.displayName === undefined
    ? `№${ticket.number}`
    : `№${ticket.number} — ${ticket.displayName}`;
}

function winnerSubject(ticket: RaffleTicketView): string {
  return `Победитель — билет ${ticketLine(ticket)}`;
}

/**
 * Список билетов, который администратор вносит в колесо: число билетов,
 * приз, что делать дальше и блок строк страницы.
 */
export function raffleWinnerScreen(view: {
  auctionId: string;
  raffle: RaffleView;
  page: number;
}): ShownScreen {
  const { raffle } = view;
  const auction = uuidToToken(view.auctionId);
  const pageCount = Math.max(
    1,
    Math.ceil(raffle.tickets.length / raffleWinnerPageSize),
  );
  const page = Math.min(Math.max(view.page, 0), pageCount - 1);
  const items = raffle.tickets.slice(
    page * raffleWinnerPageSize,
    (page + 1) * raffleWinnerPageSize,
  );
  const paging = { items, page, pageCount };
  const keyboard = new InlineKeyboard().text(
    askLabel,
    consoleRaffleWinnerAskData(auction),
  );
  withPager(keyboard, paging, (target) =>
    consoleRaffleWinnerData(auction, target),
  );
  return {
    id: "raffle-winner",
    text: screenText(
      pagedTitle(raffleWinnerLabel, paging),
      escapeHtml(
        [
          `Билетов: ${raffle.tickets.length}`,
          ...(raffle.prize === undefined ? [] : [`Приз: ${raffle.prize}`]),
        ].join("\n"),
      ),
      escapeHtml(
        pageCount === 1
          ? "Регистрация закрыта. Внеси билеты в колесо, выбери победителя и введи номер его билета: участники получат сообщение с итогом."
          : `Регистрация закрыта. Внеси билеты со всех страниц в колесо, выбери победителя и введи номер его билета: участники получат сообщение с итогом. Здесь билеты ${items[0]?.number ?? 1}–${items.at(-1)?.number ?? 1}.`,
      ),
      items.length === 0
        ? undefined
        : `<pre>${items.map((ticket) => escapeHtml(ticketLine(ticket))).join("\n")}</pre>`,
    ),
    keyboard: withNav(keyboard, toConsole(view.auctionId)),
    format: "HTML",
  };
}

/** Вопрос о номере выигравшего билета: что прислать, диапазон и образец. */
export function raffleWinnerQuestionText(tickets: number): string {
  return `Номер выигравшего билета — целое число от 1 до ${tickets}, как его назвало колесо.\nНапример: ${Math.min(7, Math.max(tickets, 1))}`;
}

/** Причина отказа ответу о номере победителя. */
export function raffleWinnerAskErrorText(
  error: RaffleWinnerAskError,
  tickets: number,
): string {
  switch (error) {
    case "winner-format":
      return `Это не номер билета. Нужно целое число от 1 до ${tickets}.`;
    case "winner-range":
      return `Такого билета нет. В розыгрыше билеты от 1 до ${tickets}.`;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}

/**
 * Подтверждение победителя: билет с именем жирным и последствие. Итог не
 * меняется, поэтому «Да» красное. «Нет» возвращает к списку билетов, где
 * «Ввести победителя» спрашивает номер заново: номер едет в кнопке, и
 * присылать заново нечего.
 */
export function raffleWinnerConfirmScreen(view: {
  auctionId: string;
  ticket: RaffleTicketView;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  return {
    id: "raffle-winner-confirm",
    text: screenText(
      "Назначить победителя?",
      subjectLine(winnerSubject(view.ticket)),
      escapeHtml(
        "Итог розыгрыша не меняется: участники сразу получат сообщение с ним.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, назначить",
      yesData: consoleRaffleWinnerConfirmData(auction, view.ticket.number),
      noData: consoleRaffleWinnerData(auction),
      irreversible: true,
    }),
    format: "HTML",
  };
}

function noteText(outcome: RaffleWinnerOutcome): string {
  switch (outcome.note) {
    case "assigned":
      return "Итог розыгрыша подведён. Участники получат сообщение с итогом.";
    case "already-drawn":
      return "Итог розыгрыша уже подведён. Он не меняется.";
    case "not-in-pool":
      return `Такого билета нет. В розыгрыше билеты от 1 до ${outcome.tickets}.`;
    case "not-awaiting":
      return "Розыгрыш не ждёт итога. Что с ним — в строке розыгрыша на пульте.";
    case "no-raffle":
      return "Розыгрыша у аукциона нет. Подводить нечего.";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** Исход итога — свой экран с возвратом в пульт. */
export function raffleWinnerOutcomeScreen(
  view: { auctionId: string } & RaffleWinnerOutcome,
): ShownScreen {
  const keyboard = new InlineKeyboard();
  // Номер вне пула — ввести другой: вопрос задаётся заново.
  if (view.note === "not-in-pool") {
    keyboard.text(
      retryLabel,
      consoleRaffleWinnerAskData(uuidToToken(view.auctionId)),
    );
  }
  return {
    id: "outcome",
    text: outcomeText(
      noteText(view),
      view.note === "assigned" || view.note === "already-drawn"
        ? winnerSubject(view.ticket)
        : undefined,
    ),
    keyboard: withNav(keyboard, toConsole(view.auctionId)),
    format: "HTML",
  };
}
