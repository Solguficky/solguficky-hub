import { InlineKeyboard } from "grammy";
import {
  encodeAuctionCallback,
  MAX_FEED_PAGE,
} from "../../../../auction-ui/index.js";
import { money, truncate } from "../../../../core/format.js";
import type {
  RemovalConfirm,
  RemovalForecast,
  RemovalLot,
  RemovalNote,
  RemovalPerson,
  RemovalRefusal,
} from "../../application/types.js";
import { type CommunityDay, communityShownTime } from "../../community-time.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  removalConfirmData,
  removalData,
  removalPickData,
} from "../parse-callback.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  pagedTitle,
  paginate,
  readableMoment,
  screenText,
  subjectLine,
  submenuText,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Снятие участника с лота администратором (PER-659, ADR-072): экран хаба,
// вход — ряд «Снять участника» на «Ставках» лота. У бота аукциона его нет.
// Люди — кнопки по две в ряд в порядке первой ставки, подтверждение
// показывает лот после снятия, как его решил предпросмотр, а исход — свой
// экран с возвратом к лоту.

const untitled = "Лот без названия";
const titleLimit = 120;
const unnamed = "Участник без имени";

export const removalTitle = "Снять участника";
export const removalLabel = removalTitle;

const refusalText: Record<RemovalRefusal, string> = {
  "lot-not-in-auction": "Лота нет в этом аукционе. Открой лот заново.",
  "not-in-prebidding":
    "Снять пока нельзя. Онлайн-неделя ещё не открыта, ставок нет.",
  "lineup-frozen":
    "Снять нельзя. Состав финала объявлен, и цена лота уже вошла в него.",
  "lot-not-open": "Снять нельзя. Торги по лоту закончены.",
  "not-in-online-phase":
    "Снять нельзя. Лот торгуется в зале: ошибку ставки там исправляет ведущий.",
  "deadline-passed": "Снять нельзя. Дедлайн лота прошёл.",
  "not-a-lot-participant":
    "Снимать некого. У человека нет ставок на этом лоте.",
  "already-removed": "Участник уже снят. Его ставки на лоте не действуют.",
};

function lotTitle(lot: RemovalLot): string {
  return truncate(lot.title ?? untitled, titleLimit);
}

function nameOf(person: RemovalPerson): string {
  return person.name ?? unnamed;
}

// Возврат на «Ставки» лота — последняя страница хронологии: страница за
// пределом открывает её.
function toBids(lot: RemovalLot): Parent {
  return {
    name: "Ставки",
    data: encodeAuctionCallback({
      kind: "history",
      lotId: lot.lotId,
      page: 0,
      historyPage: MAX_FEED_PAGE,
    }),
  };
}

function pairs<T>(all: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let at = 0; at < all.length; at += 2) rows.push(all.slice(at, at + 2));
  return rows;
}

/** Кого снять: участники лота, ещё не снятые, кнопками по два в ряд. */
export function removalPeopleScreen(view: {
  lot: RemovalLot;
  people: readonly RemovalPerson[];
  page: number;
}): ShownScreen {
  const lot = uuidToToken(view.lot.lotId);
  const page = paginate(pairs(view.people), view.page);
  const keyboard = new InlineKeyboard();
  for (const row of page.items) {
    nextRow(keyboard);
    for (const person of row) {
      keyboard.text(
        buttonText(nameOf(person)),
        removalPickData(lot, uuidToToken(person.participantId)),
      );
    }
  }
  withPager(keyboard, page, (at) => removalData(lot, at));
  return {
    id: "removal-people",
    text: submenuText(
      pagedTitle(removalTitle, page),
      lotTitle(view.lot),
      escapeHtml(
        "Кого снять с лота? Его ставки и автоставка на этом лоте перестанут действовать, а лидер и цена пересчитаются без него.",
      ),
    ),
    keyboard: withNav(keyboard, toBids(view.lot)),
    format: "HTML",
  };
}

function forecastLines(
  forecast: RemovalForecast,
  view: { timeZone: string; today: CommunityDay },
): string[] {
  return [
    forecast.leader === "none"
      ? "Лидера не останется."
      : forecast.leader.name === undefined
        ? "Лидер сменится."
        : `Лидер: ${forecast.leader.name}.`,
    `Цена: ${money(forecast.price)}.`,
    ...(forecast.extendedDeadline === undefined
      ? []
      : [
          `Торги продлятся до ${readableMoment(
            communityShownTime(forecast.extendedDeadline, view.timeZone),
            view.today,
          )}.`,
        ]),
  ];
}

/**
 * Подтверждение снятия: лот после снятия, как его решил предпросмотр. «Да»
 * несёт номер лота предпросмотра, и лот, который с тех пор изменился, Auction
 * не меняет. Снятие необратимо: «Да» красное.
 */
export function removalConfirmScreen(
  confirm: RemovalConfirm & { timeZone: string; today: CommunityDay },
): ShownScreen {
  const lot = uuidToToken(confirm.lot.lotId);
  return {
    id: "removal-confirm",
    text: screenText(
      escapeHtml(`Снять ${nameOf(confirm.person)} с лота?`),
      confirm.changed === true
        ? escapeHtml(
            "Лот изменился, пока было открыто подтверждение. Проверь заново.",
          )
        : undefined,
      subjectLine(lotTitle(confirm.lot)),
      escapeHtml(
        ["После снятия:", ...forecastLines(confirm.forecast, confirm)].join(
          "\n",
        ),
      ),
      escapeHtml(
        "Вернуть участника нельзя: его ставки и автоставка на этом лоте перестанут действовать.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, снять",
      yesData: removalConfirmData(
        lot,
        uuidToToken(confirm.person.participantId),
        confirm.version,
      ),
      noData: removalData(lot),
      irreversible: true,
    }),
    format: "HTML",
  };
}

function noteText(
  note: RemovalNote,
  view: { timeZone: string; today: CommunityDay },
): string {
  switch (note.kind) {
    case "removed": {
      const removed =
        note.name === undefined
          ? "Участник снят."
          : `Участник снят: ${note.name}.`;
      return note.after === undefined
        ? removed
        : [removed, ...forecastLines(note.after, view)].join(" ");
    }
    case "refused":
      return refusalText[note.reason];
    case "no-participants":
      return "Снимать некого. На лоте нет ставок.";
    case "everyone-removed":
      return "Снимать некого. Все участники лота уже сняты, их ставки зачёркнуты.";
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

/**
 * Исход снятия — свой экран с возвратом к лоту. После принятого снятия «‹
 * Лот» несёт номер лота из ответа: карточка дочитывается до него.
 */
export function removalOutcomeScreen(outcome: {
  lot: RemovalLot;
  note: RemovalNote;
  lotVersion?: number;
  timeZone: string;
  today: CommunityDay;
}): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(noteText(outcome.note, outcome), lotTitle(outcome.lot)),
    keyboard: withNav(new InlineKeyboard(), {
      name: "Лот",
      data: encodeAuctionCallback({
        kind: "lot",
        lotId: outcome.lot.lotId,
        page: 0,
        ...(outcome.lotVersion === undefined
          ? {}
          : { atLeastVersion: outcome.lotVersion }),
      }),
    }),
    format: "HTML",
  };
}
