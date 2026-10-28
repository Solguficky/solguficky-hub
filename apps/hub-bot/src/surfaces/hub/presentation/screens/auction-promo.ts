import { InlineKeyboard } from "grammy";
import { promoButtonLabel, promoCaption } from "../../../../auction-promo.js";
import type { AuctionBlock } from "../../../../auction-ui/index.js";
import type { PromoVideoNote } from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consolePromoVideoAskData,
  consolePromoVideoData,
  consolePromoVideoRemoveConfirmData,
  consolePromoVideoRemoveData,
  consoleViewData,
} from "../parse-callback.js";
import {
  confirmKeyboard,
  escapeHtml,
  outcomeText,
  type Parent,
  removeLabel,
  screenText,
  toAuctionRoot,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Промо-видео аукциона (PER-774): одно видео у аукциона — пост чата медиа
// ботов (PER-775). Держатель права вести аукцион прикрепляет, заменяет и
// убирает его с экрана «Промо-видео»: вход — ряд «Участникам» пульта рядом с
// «Объявлением» (PER-802). Участник открывает
// видео кнопкой «🎬 Промо» корня — копией поста новым сообщением с «‹ Аукцион».

/** Вход из пульта (PER-802): экран видит только держатель права, без 🛠. */
export const promoVideoLabel = "Промо-видео";

const promoVideoTitle = "Промо-видео";

function toPromoVideo(auctionId: string): Parent {
  return {
    name: promoVideoTitle,
    data: consolePromoVideoData(uuidToToken(auctionId)),
  };
}

/**
 * Видео под кнопкой «🎬 Промо»: копия поста с подписью и «‹ Аукцион». Текст
 * экрана — подпись копии, заголовком.
 */
export function auctionPromoScreen(
  block: Extract<AuctionBlock, { kind: "promo" }>,
): ShownScreen {
  return {
    id: "auction-promo",
    text: screenText(promoCaption),
    keyboard: withNav(new InlineKeyboard(), toAuctionRoot(block.auctionId)),
    format: "HTML",
  };
}

/** Экран промо-видео: есть ли видео и что с ним сделать. */
export function promoVideoScreen(view: {
  auctionId: string;
  video: boolean;
}): ShownScreen {
  const auction = uuidToToken(view.auctionId);
  const keyboard = new InlineKeyboard();
  if (view.video) {
    keyboard
      .text("Заменить видео", consolePromoVideoAskData(auction))
      .row()
      .text(removeLabel("Убрать видео"), consolePromoVideoRemoveData(auction));
  } else {
    keyboard.text("Прикрепить видео", consolePromoVideoAskData(auction));
  }
  return {
    id: "promo-video",
    text: screenText(
      promoVideoTitle,
      escapeHtml(
        view.video
          ? `Видео прикреплено: участники открывают его кнопкой «${promoButtonLabel}» в корне аукциона в обоих ботах.`
          : `Видео нет. Прикрепи одно видео — участники откроют его кнопкой «${promoButtonLabel}» в корне аукциона в обоих ботах.`,
      ),
    ),
    keyboard: withNav(keyboard, toConsole(view.auctionId)),
    format: "HTML",
  };
}

// Вход — из пульта (PER-802), и возврат — в пульт.
function toConsole(auctionId: string): Parent {
  return { name: "Пульт", data: consoleViewData(uuidToToken(auctionId)) };
}

/** Вопрос о видео: одно видео ответом, первый раз или заново после отказа. */
export function promoVideoQuestionText(refused = false): string {
  return refused
    ? "Это не видео. Пришли одно видео ответом на это сообщение."
    : "Пришли одно видео ответом на это сообщение. Прежнее видео, если оно есть, заменится.";
}

/**
 * Подтверждение снятия. Снятое видео прикрепляется заново тем же вопросом,
 * поэтому «Да» не красное.
 */
export function promoVideoRemoveScreen(auctionId: string): ShownScreen {
  const auction = uuidToToken(auctionId);
  return {
    id: "promo-video-remove-confirm",
    text: screenText(
      "Убрать промо-видео?",
      escapeHtml(
        `Кнопка «${promoButtonLabel}» пропадёт из корня аукциона в обоих ботах. Видео можно прикрепить заново.`,
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, убрать",
      yesData: consolePromoVideoRemoveConfirmData(auction),
      noData: consolePromoVideoData(auction),
    }),
    format: "HTML",
  };
}

const noteTexts: Readonly<Record<PromoVideoNote, string>> = {
  set: `Видео прикреплено. Участники открывают его кнопкой «${promoButtonLabel}» в корне аукциона.`,
  removed: `Видео убрано. Кнопки «${promoButtonLabel}» в корне аукциона больше нет.`,
  "media-off":
    "Видео сейчас прикрепить нельзя: канал медиа ботов не настроен. Видео не сохранено.",
  "media-failed":
    "Не получилось сохранить видео в канал медиа ботов. Проверь, что бот — администратор канала, и пришли видео заново.",
};

/** Исход промо-видео — свой экран с возвратом на экран видео. */
export function promoVideoOutcomeScreen(view: {
  auctionId: string;
  note: PromoVideoNote;
}): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(noteTexts[view.note]),
    keyboard: withNav(new InlineKeyboard(), toPromoVideo(view.auctionId)),
    format: "HTML",
  };
}
