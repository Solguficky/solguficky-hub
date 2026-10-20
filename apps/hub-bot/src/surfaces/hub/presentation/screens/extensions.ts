import { InlineKeyboard } from "grammy";
import { nameSettingsTitle } from "../../../../auction-standing.js";
import { encodeAuctionCallback } from "../../../../auction-ui/index.js";
import { adminLabel, marked, pictogram } from "../../../../core/pictograms.js";
import type { MeetupAuctionView } from "../../application/types.js";
import type { MeetupSnapshot } from "../../meetups/port.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { lotNewData } from "../parse-callback.js";
import {
  addLotLabel,
  auctionRootData,
  extensionsData,
  outcomeText,
  type Parent,
  retryLabel,
  screenText,
  submenuText,
  toCard,
  toExtensions,
  toSettings,
  withNav,
} from "./kit.js";
import { meetupTitleLabel } from "./meetup.js";
import type { ShownScreen } from "./show.js";

// Расширения сходки (ADR-064, дополнение 2026-10-12; PER-605): ядро даёт
// расширению места входа — меню сходки и пункт «Настроек», — а содержимое за
// входом принадлежит расширению. Расширение пока одно — аукцион, и список
// держит код бота, без каталога.

/** «Расширения» в «Настройках»: список расширений. */
export const settingsExtensionsData = "v1:nav:ext";

export const toSettingsExtensions: Parent = {
  name: "Расширения",
  data: settingsExtensionsData,
};

/** Настройки одного расширения — аукциона. */
export const settingsAuctionData = "v1:nav:ext:auc";

export const toSettingsAuction: Parent = {
  name: "Аукцион",
  data: settingsAuctionData,
};

// Вход в раздел аукциона несёт его знак во всех ботах (PER-644).
const auctionLabel = marked(pictogram.auction, "Аукцион");
const enableLabel = adminLabel("Включить аукцион");

/**
 * Меню «Расширения» сходки. Включённый аукцион открывает свой корень;
 * держателю права управлять сходкой у невключённого — «Включить аукцион»,
 * кроме отменённой сходки. Auction не ответил — меню говорит об этом с
 * повтором и не показывает ни входа, ни включения по догадке.
 */
export function extensionsScreen(view: {
  meetup: MeetupSnapshot;
  // Нет — бот без Auction или человек, за которого Auction не зовут.
  auction?: MeetupAuctionView | undefined;
  manageable: boolean;
}): ShownScreen {
  const { meetup, auction } = view;
  const token = uuidToToken(meetup.id);
  const keyboard = new InlineKeyboard();
  let line: string;
  if (auction?.kind === "open") {
    line = marked(
      pictogram.auction,
      "Аукцион: торги лотов сходки, избранное, розыгрыш и правила.",
    );
    keyboard.text(auctionLabel, auctionRootData(auction.auctionId)).row();
  } else if (auction?.kind === "unavailable") {
    line = "Аукцион сейчас не отвечает. Попробуй ещё раз.";
    keyboard.text(retryLabel, extensionsData(token)).row();
  } else if (
    auction?.kind === "none" &&
    view.manageable &&
    meetup.lifecycle !== "cancelled"
  ) {
    line =
      "Аукцион у сходки не включён. Включи его, чтобы добавить лоты и открыть торги.";
    keyboard.text(enableLabel, `v1:manage:auction:${token}`).row();
  } else {
    line = "У этой сходки пока нет расширений.";
  }
  return {
    id: "extensions",
    text: submenuText("Расширения", meetupTitleLabel(meetup.title), line),
    keyboard: withNav(keyboard, toCard(token)),
    format: "HTML",
  };
}

/**
 * Аукцион включён. Корень открывает кнопка, а не этот же ответ: read model
 * Auction может ещё не увидеть только что рождённый аукцион. Над ней —
 * «Добавить лот» (прогон 12.10, №16): первый шаг после включения, без захода
 * через корень и ленту.
 */
export function auctionEnabledScreen(view: {
  meetupToken: string;
  auctionId: string;
  alreadyExisted: boolean;
}): ShownScreen {
  const keyboard = new InlineKeyboard()
    .text(addLotLabel, lotNewData(uuidToToken(view.auctionId)))
    .row()
    .text(auctionLabel, auctionRootData(view.auctionId));
  return {
    id: "outcome",
    text: outcomeText(
      view.alreadyExisted
        ? "Аукцион у этой сходки уже включён"
        : "Аукцион включён. Первый лот добавляет кнопка ниже, все лоты — в «Аукционе» → «Лоты».",
    ),
    keyboard: withNav(keyboard, toExtensions(view.meetupToken)),
    format: "HTML",
  };
}

/**
 * «Расширения» в «Настройках»: список расширений, без их настроек.
 * Без Auction у бота расширений нет.
 */
export function settingsExtensionsScreen(auction: boolean): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (auction) keyboard.text(auctionLabel, settingsAuctionData).row();
  return {
    id: "settings-extensions",
    text: screenText(
      "Расширения",
      auction ? "Настройки расширений сходок." : "Расширений пока нет.",
    ),
    keyboard: withNav(keyboard, toSettings),
    format: "HTML",
  };
}

/**
 * Настройки расширения «Аукцион»: уведомления и, пока идёт аукцион, имя.
 */
export function settingsAuctionScreen(nameAuctionId?: string): ShownScreen {
  const keyboard = new InlineKeyboard().text("Уведомления", "v1:notify:outbid");
  if (nameAuctionId !== undefined) {
    keyboard
      .row()
      .text(
        nameSettingsTitle,
        encodeAuctionCallback({ kind: "name", auctionId: nameAuctionId }),
      );
  }
  return {
    id: "settings-auction",
    text: screenText(
      "Аукцион",
      nameAuctionId === undefined
        ? "Уведомления аукциона."
        : "Уведомления аукциона и имя, под которым ты ставишь в идущем аукционе.",
    ),
    keyboard: withNav(keyboard.row(), toSettingsExtensions),
    format: "HTML",
  };
}
