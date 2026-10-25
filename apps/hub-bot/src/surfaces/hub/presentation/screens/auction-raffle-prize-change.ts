import { InlineKeyboard } from "grammy";
import { fingerprint } from "../../application/fingerprint.js";
import type { RafflePrizeChangeOutcome } from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleRafflePrizeChangeConfirmData,
  consoleRafflePrizeChangeData,
  consoleViewData,
} from "../parse-callback.js";
import {
  confirmKeyboard,
  escapeHtml,
  outcomeText,
  type Parent,
  screenText,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Смена приза идущего розыгрыша (PER-737; ADR-066, дополнение 2026-10-25):
// вопрос о новом тексте, подтверждение «было → станет» и исход. Участникам о
// смене бот не пишет: новый приз они видят на экране розыгрыша, а победитель
// получает его в сообщении с итогом. Вопрос и его отказы — те же, что у
// «Приза» запланированного аукциона (`screens/auction-console.ts`).

export const rafflePrizeChangeLabel = "Изменить приз";
const retryLabel = "Ввести заново";

/**
 * Начало строки нового приза на подтверждении: «Да» читает приз из неё
 * (`presentation/raffle-prize-input.ts`), поэтому строка — последняя с этим
 * началом, а приз — одна строка.
 */
export const newPrizeLead = "Станет: ";

function toConsole(auctionId: string): Parent {
  return { name: "Пульт", data: consoleViewData(uuidToToken(auctionId)) };
}

/**
 * Подтверждение: прежний и новый приз строками и последствие. «Да» несёт
 * отпечаток нового текста, сам текст — строка «Станет: …» этого экрана.
 * «Нет» возвращает в пульт: присылать заново нечего.
 */
export function rafflePrizeChangeConfirmScreen(view: {
  auctionId: string;
  before?: string | undefined;
  after: string;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  return {
    id: "raffle-prize-change-confirm",
    text: screenText(
      "Изменить приз?",
      escapeHtml(
        [
          `Было: ${view.before ?? "приза нет"}`,
          `${newPrizeLead}${view.after}`,
        ].join("\n"),
      ),
      escapeHtml(
        "Участники увидят новый приз на экране розыгрыша, сообщения им не будет. В итоге победитель получит этот приз.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, изменить",
      yesData: consoleRafflePrizeChangeConfirmData(
        auction,
        fingerprint(view.after),
      ),
      noData: consoleViewData(auction),
    }),
    format: "HTML",
  };
}

function noteText(outcome: RafflePrizeChangeOutcome): string {
  switch (outcome.note) {
    case "changed":
      return "Приз розыгрыша изменён. Участники видят его на экране розыгрыша.";
    case "already-drawn":
      return "Итог розыгрыша уже подведён. Приз больше не меняется.";
    case "without-result":
      return "Розыгрыш без итога: он не проводится, не состоялся или отменён. Приз не меняется.";
    case "no-raffle":
      return "Розыгрыша у аукциона нет. Менять нечего.";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** Исход смены приза — свой экран с возвратом в пульт. */
export function rafflePrizeChangeOutcomeScreen(
  view: { auctionId: string } & RafflePrizeChangeOutcome,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(
      noteText(view),
      view.note === "changed" ? `Приз: ${view.prize}` : undefined,
    ),
    keyboard: withNav(new InlineKeyboard(), toConsole(view.auctionId)),
    format: "HTML",
  };
}

/**
 * Подтверждение устарело: строки нового приза в нём нет или она не сходится
 * с кнопкой. Ничего не изменено, вопрос задаётся заново.
 */
export function rafflePrizeChangeStaleScreen(auctionId: string): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(
      "Подтверждение устарело. Приз не изменён: введи его заново.",
    ),
    keyboard: withNav(
      new InlineKeyboard().text(
        retryLabel,
        consoleRafflePrizeChangeData(uuidToToken(auctionId)),
      ),
      toConsole(auctionId),
    ),
    format: "HTML",
  };
}
