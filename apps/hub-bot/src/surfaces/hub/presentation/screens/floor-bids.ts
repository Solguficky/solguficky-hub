import { InlineKeyboard } from "grammy";
import { money, truncate } from "../../../../core/format.js";
import { refreshLabel } from "../../../../core/pictograms.js";
import type {
  FloorLot,
  FloorNote,
  FloorPerson,
  FloorView,
  LotAmount,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  floorConfirmData,
  floorData,
  floorLeaderData,
  floorPickData,
  floorSearchData,
} from "../parse-callback.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  pagedTitle,
  paginate,
  screenText,
  toAuctionRoot,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// «Ставки зала» помощника ведущего (PER-565, ADR-070 пп. 4–6). Экран хаба, как
// пульт: у бота аукциона его нет. Люди зала — кнопки по две в ряд с именем и
// следующей ценой, по алфавиту: место человека не меняется от ставок, а лидер
// остаётся на своём месте с пометкой (решение владельца 20.10.2026). Лот,
// человек и цена едут в кнопке, и устаревшее нажатие ставку не ставит.

const untitled = "Лот без названия";
const titleLimit = 120;

export const floorTitle = "Ставки зала";
export const floorSearchLabel = "Другой человек…";
export const floorLeaderToast = "Этот человек уже лидер.";
export const floorNoLotText = "Сейчас лот не открыт.";
export const floorNoNamesText = "В этом аукционе ещё никто не выбрал имя.";
export const floorSearchQuestionText =
  "Кого ищем? Напиши имя в аукционе или его часть.";

export type FloorScreenView = {
  floor: FloorView;
  page: number;
  note?: FloorNote;
  search?: string;
  // Поток аукциона оборвался, пока экран живой: цена могла устареть.
  stale?: boolean;
};

export const staleFloorText =
  "Связь с аукционом прервалась — цена могла устареть. Нажми «Обновить».";

// Живая правка (PER-565): по потоку правится экран людей, пока идёт финал.
// Найденные по имени — ответ на вопрос, и правка по потоку вернула бы весь
// список поверх него.
export function liveFloor(view: FloorScreenView): boolean {
  return (
    view.search === undefined &&
    (view.floor.status === "final" || view.floor.status === "lineup-frozen")
  );
}

function priceText(amount: LotAmount): string {
  return money(amount);
}

function noteText(note: FloorNote): string {
  switch (note.kind) {
    case "accepted":
      return `Принято: ${note.name} — ${priceText(note.price)}.`;
    case "proxy-answered":
      return `Принято: ${note.name} — ${priceText(note.price)}, автоставка ответила ${priceText(note.answer)}.`;
    case "price-taken":
      return note.leader === undefined
        ? `${priceText(note.price)} уже взята.`
        : `${priceText(note.price)} уже взята — лидер ${note.leader}.`;
    case "lot-changed":
      return "Лот сменился — ставка не поставлена.";
    case "price-changed":
      return "Цена изменилась — ставка не поставлена.";
    case "bidder-is-leader":
      return `${note.name} уже лидер — ставка не нужна.`;
    case "lot-not-open":
      return "Лот уже не торгуется — ставка не поставлена.";
    case "name-not-chosen":
      return "У человека нет имени в этом аукционе — ставка не поставлена.";
    case "cannot-bid":
      return "Этот человек не может ставить в аукционе — ставка не поставлена.";
    case "removed-from-lot":
      return "Этого человека сняли с лота — ставка не поставлена.";
    case "unanswered":
      return `Аукцион не ответил — ставка ${note.name === undefined ? "" : `${note.name} — `}${priceText(note.price)} могла пройти. Проверь лидера на экране.`;
    case "not-found":
      return `Никого не нашлось по «${note.search}».`;
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

function lotTitle(lot: FloorLot): string {
  return truncate(lot.title ?? untitled, titleLimit);
}

function lotLines(view: FloorScreenView): string[] {
  const { floor } = view;
  if (floor.status === "finished") return ["Аукцион завершён."];
  const lot = floor.lot;
  if (lot === undefined) return [floorNoLotText];
  return [
    `Сейчас: ${lotTitle(lot)}.`,
    lot.nextPrice === undefined
      ? `Цена: ${priceText(lot.currentPrice)}.`
      : `Цена: ${priceText(lot.currentPrice)}, следующая: ${priceText(lot.nextPrice)}.`,
    lot.leaderId === undefined
      ? "Ставок нет."
      : `Лидер: ${lot.leaderName ?? "имя не получено"}.`,
  ];
}

function personLabel(person: FloorPerson, lot: FloorLot, next: LotAmount) {
  return buttonText(
    lot.leaderId === person.participantId
      ? `${person.name} — лидер`
      : `${person.name} — ${priceText(next)}`,
  );
}

// Людей — по две кнопки в ряд, восемь рядов на странице.
function pairs<T>(all: readonly T[]): T[][] {
  const rows: T[][] = [];
  for (let at = 0; at < all.length; at += 2) rows.push(all.slice(at, at + 2));
  return rows;
}

export function floorScreen(view: FloorScreenView): ShownScreen {
  const { floor } = view;
  const auction = uuidToToken(floor.auctionId);
  const keyboard = new InlineKeyboard();
  const lot = floor.lot;
  const next = lot?.nextPrice;
  let title = floorTitle;
  let peopleLine: string | undefined;
  if (lot !== undefined && next !== undefined) {
    if (floor.people.length === 0) {
      peopleLine = floorNoNamesText;
    } else {
      const page = paginate(pairs(floor.people), view.page);
      title = pagedTitle(floorTitle, page);
      if (view.search !== undefined) {
        peopleLine = `Нашлось по «${view.search}»: ${floor.people.length}.`;
      }
      for (const row of page.items) {
        nextRow(keyboard);
        for (const person of row) {
          keyboard.text(
            personLabel(person, lot, next),
            lot.leaderId === person.participantId
              ? floorLeaderData(auction)
              : floorPickData(
                  uuidToToken(lot.lotId),
                  uuidToToken(person.participantId),
                  next.minorUnits,
                ),
          );
        }
      }
      withPager(keyboard, page, (at) => floorData(auction, at));
    }
    if (view.search === undefined && floor.people.length > 0) {
      nextRow(keyboard).text(floorSearchLabel, floorSearchData(auction));
    }
  }
  // Найденные по имени — ответ на вопрос: «Обновить» вернул бы весь список.
  if (view.search === undefined) {
    nextRow(keyboard).text(refreshLabel, floorData(auction));
  }
  return {
    id: view.search === undefined ? "floor-bids" : "floor-found",
    text: screenText(
      title,
      view.stale === true ? escapeHtml(staleFloorText) : undefined,
      view.note === undefined ? undefined : escapeHtml(noteText(view.note)),
      lotLines(view).map(escapeHtml).join("\n"),
      peopleLine === undefined ? undefined : escapeHtml(peopleLine),
    ),
    keyboard: withNav(
      keyboard,
      view.search === undefined
        ? toAuctionRoot(floor.auctionId)
        : { name: floorTitle, data: floorData(auction) },
    ),
    format: "HTML",
  };
}

// Подтверждение ставки зала (ADR-070 п. 4): лот назван, «Да» несёт лот,
// человека и цену. Ставка за другого необратима: «Да» красное.
export function floorConfirmScreen(confirm: {
  auctionId: string;
  lot: FloorLot;
  person: FloorPerson;
  amount: LotAmount;
}): ShownScreen {
  const named = `${confirm.person.name} — ${priceText(confirm.amount)}`;
  return {
    id: "floor-confirm",
    text: screenText(
      `Ставка зала: ${escapeHtml(named)}?`,
      escapeHtml(`Лот: ${lotTitle(confirm.lot)}.`),
      escapeHtml("Отменить ставку нельзя."),
    ),
    keyboard: confirmKeyboard({
      yes: buttonText(`Да, ${named}`),
      yesData: floorConfirmData(
        uuidToToken(confirm.lot.lotId),
        uuidToToken(confirm.person.participantId),
        confirm.amount.minorUnits,
      ),
      noData: floorData(uuidToToken(confirm.auctionId)),
      irreversible: true,
    }),
    format: "HTML",
  };
}
