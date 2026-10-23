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

/** «Расширения» в «Настройках»: настройки каждого расширения. */
export const settingsExtensionsData = "v1:nav:ext";

export const toSettingsExtensions: Parent = {
  name: "Расширения",
  data: settingsExtensionsData,
};

// Вход в раздел аукциона несёт его знак во всех ботах (PER-644).
const auctionLabel = marked(pictogram.auction, "Аукцион");
const enableLabel = adminLabel("Включить аукцион");

/**
 * Меню «Расширения» сходки. Включённый аукцион открывает свой корень;
 * держателю права вести аукцион у невключённого — «Включить аукцион»,
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
 * «Расширения» в «Настройках»: только список расширений, у каждого — свои
 * настройки за его пунктом (решение владельца по прогону 14 октября 2026
 * года, №74). Расширение пока одно — аукцион; без Auction у бота расширений
 * нет.
 */
export function settingsExtensionsScreen(auction: boolean): ShownScreen {
  const keyboard = new InlineKeyboard();
  if (auction) keyboard.text(auctionLabel, settingsAuctionData).row();
  return {
    id: "settings-extensions",
    text: screenText(
      "Расширения",
      auction
        ? "Настройки расширений сходок: у каждого расширения — свои."
        : "Расширений пока нет.",
    ),
    keyboard: withNav(keyboard, toSettings),
    format: "HTML",
  };
}

/** «Аукцион» в «Расширениях» настроек: его уведомления и имя в нём. */
export const settingsAuctionData = "v1:nav:exta";

export const toSettingsAuction: Parent = {
  name: "Аукцион",
  data: settingsAuctionData,
};

/**
 * Настройки расширения «Аукцион» (№74): «Уведомления» — частота «перебили»,
 * «Перебили в финале» и анонс финала — и, пока идёт аукцион, «Имя в
 * аукционе» (PER-595).
 */
export function settingsAuctionScreen(nameAuctionId?: string): ShownScreen {
  const keyboard = new InlineKeyboard().text(
    "Уведомления",
    auctionNotificationsData,
  );
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
      `Уведомления — когда писать о торгах.${nameAuctionId === undefined ? "" : " Имя в аукционе — под каким именем ты ставишь в идущем аукционе."}`,
    ),
    keyboard: withNav(keyboard, toSettingsExtensions),
    format: "HTML",
  };
}

/** Экран уведомлений аукциона; те же данные у «Частоты уведомлений» под вестью. */
export const auctionNotificationsData = "v1:notify:outbid";
