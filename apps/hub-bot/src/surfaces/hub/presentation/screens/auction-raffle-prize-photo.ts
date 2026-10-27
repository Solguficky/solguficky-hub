import { InlineKeyboard } from "grammy";
import type {
  RafflePrizePhotoAskError,
  RafflePrizePhotoOutcome,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleRafflePrizePhotoAskData,
  consoleRafflePrizePhotoData,
  consoleRafflePrizePhotoRemoveConfirmData,
  consoleRafflePrizePhotoRemoveData,
  consoleViewData,
} from "../parse-callback.js";
import {
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  removeLabel,
  screenText,
  withNav,
} from "./kit.js";
import { imageLimitText } from "./lot-form.js";
import type { ShownScreen } from "./show.js";

// Фото приза идущего розыгрыша (PER-773; хранение — PER-772): экран фото с
// пульта, вопрос о фото, подтверждение снятия и исход. Участникам о фото бот
// не пишет: они видят его над текстом экрана розыгрыша. Правило то же, что у
// смены приза (PER-737): пока у розыгрыша нет итога.

export const rafflePrizePhotoLabel = "Фото приза";
const title = "Фото приза";
const sendLabel = "Прислать фото";
const replaceLabel = "Заменить фото";
const removePhotoLabel = removeLabel("Убрать фото");

function toConsole(auctionId: string): Parent {
  return { name: "Пульт", data: consoleViewData(uuidToToken(auctionId)) };
}

/**
 * Экран фото: есть ли фото у приза и что с ним можно сделать. Самого фото
 * экран не несёт — его видно на экране розыгрыша.
 */
export function rafflePrizePhotoScreen(view: {
  auctionId: string;
  hasPhoto: boolean;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const keyboard = new InlineKeyboard();
  if (view.hasPhoto) {
    keyboard.text(replaceLabel, consoleRafflePrizePhotoAskData(auction));
    nextRow(keyboard).text(
      removePhotoLabel,
      consoleRafflePrizePhotoRemoveData(auction),
    );
  } else {
    keyboard.text(sendLabel, consoleRafflePrizePhotoAskData(auction));
  }
  return {
    id: "raffle-prize-photo",
    text: screenText(
      title,
      escapeHtml(
        view.hasPhoto
          ? "Фото у приза есть: участники видят его над текстом розыгрыша."
          : "Фото у приза нет. Пришли его — участники увидят фото над текстом розыгрыша.",
      ),
      escapeHtml("Фото меняется, пока у розыгрыша нет итога."),
    ),
    keyboard: withNav(keyboard, toConsole(view.auctionId)),
    format: "HTML",
  };
}

/** Подтверждение снятия: вернуть фото можно, только прислав его заново. */
export function rafflePrizePhotoRemoveConfirmScreen(
  auctionId: string,
): ShownScreen {
  const auction = uuidToToken(auctionId);
  return {
    id: "raffle-prize-photo-remove-confirm",
    text: screenText(
      "Убрать фото приза?",
      escapeHtml(
        "Участники увидят розыгрыш без фото. Вернуть его можно, только прислав фото заново.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, убрать фото",
      yesData: consoleRafflePrizePhotoRemoveConfirmData(auction),
      noData: consoleRafflePrizePhotoData(auction),
      irreversible: true,
    }),
    format: "HTML",
  };
}

export const rafflePrizePhotoPrompt =
  "Пришли фото приза ответом на это сообщение. Участники увидят его над текстом розыгрыша.";

const askErrors: Record<RafflePrizePhotoAskError, string> = {
  "photo-needed": "Нужна фотография, а не текст, файл или стикер.",
  "photo-unavailable":
    "Не получилось получить фото у Telegram. Пришли фото ещё раз.",
  "photo-not-saved":
    "Не получилось сохранить фото. Это на моей стороне. Пришли фото ещё раз.",
  "image-too-large": "Фото слишком большое, аукцион его не принял.",
  "unsupported-image": "Аукцион не узнал в этом файле изображение.",
};

/** Причина отказа ответу на вопрос о фото приза — те же слова, что у лота. */
export function rafflePrizePhotoAskErrorText(
  error: RafflePrizePhotoAskError,
  maxBytes?: number,
): string {
  if (error === "image-too-large" && maxBytes !== undefined) {
    return `Фото больше ${imageLimitText(maxBytes)}, аукцион его не принял.`;
  }
  return askErrors[error];
}

function noteText(outcome: RafflePrizePhotoOutcome): string {
  switch (outcome.note) {
    case "set":
      return "Фото приза сохранено. Участники видят его на экране розыгрыша.";
    case "removed":
      return "Фото приза убрано. Участники видят розыгрыш без фото.";
    case "already-drawn":
      return "Итог розыгрыша уже подведён. Фото приза больше не меняется.";
    case "without-result":
      return "Розыгрыш без итога: он не проводится, не состоялся или отменён. Фото приза не меняется.";
    case "no-raffle":
      return "Розыгрыша у аукциона нет. Фото ставить некуда.";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/** Исход фото приза — свой экран с возвратом в пульт. */
export function rafflePrizePhotoOutcomeScreen(
  view: { auctionId: string } & RafflePrizePhotoOutcome,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(noteText(view)),
    keyboard: withNav(new InlineKeyboard(), toConsole(view.auctionId)),
    format: "HTML",
  };
}
