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
  consoleViewData,
  floorAddData,
  floorConfirmData,
  floorData,
  floorEditData,
  floorLeaderData,
  floorPickData,
  floorRemoveData,
  floorSearchData,
} from "../parse-callback.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  type Parent,
  pagedTitle,
  paginate,
  removeLabel,
  screenText,
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
export const floorSearchLabel = "Добавить человека…";
export const floorEditLabel = "Состав";
export const floorLeaderToast = "Этот человек уже лидер.";
export const floorNoLotText = "Сейчас лот не открыт.";
export const floorEmptyRoomText =
  "В зале пока никого. Добавь людей, которые сейчас в зале.";
export const floorSearchQuestionText =
  "Кого добавить в зал? Напиши ник в Telegram или его часть.";
export const floorRoomUnavailableText =
  "Состав зала не прочитался. Нажми «Обновить».";

export type FloorScreenView = {
  floor: FloorView;
  page: number;
  note?: FloorNote;
  search?: string;
  // Поток аукциона оборвался, пока экран живой: цена могла устареть.
  stale?: boolean;
  // Правка состава: кнопки людей убирают их из зала.
  edit?: boolean;
};

export const staleFloorText =
  "Связь с аукционом прервалась — цена могла устареть. Нажми «Обновить».";

// Живая правка (PER-565): по потоку правится экран людей, пока идёт финал.
// Найденные по имени — ответ на вопрос, и правка по потоку вернула бы весь
// список поверх него.
export function liveFloor(view: FloorScreenView): boolean {
  return (
    view.search === undefined &&
    view.edit !== true &&
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
    case "outbid":
      return `Принято: ${note.name} — ${priceText(note.price)}. Цену уже подняли: ${priceText(note.now)}.`;
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
      return "У человека нет имени в этом аукционе: пусть откроет бота и выберет имя — ставка не поставлена.";
    case "cannot-bid":
      return "Этот человек не может ставить в аукционе — ставка не поставлена.";
    case "removed-from-lot":
      return "Этого человека сняли с лота — ставка не поставлена.";
    case "unanswered":
      return `Аукцион не ответил — ставка ${note.name === undefined ? "" : `${note.name} — `}${priceText(note.price)} могла пройти. Проверь лидера на экране.`;
    case "not-found":
      return `Никого не нашлось по «${note.search}».`;
    case "not-in-room":
      return "Этого человека нет в составе зала — ставка не поставлена.";
    case "member-added":
      return `${note.name} в зале.`;
    case "member-removed":
      return `${note.name} убран из зала.`;
    case "member-already-in":
      return "Этот человек уже в зале.";
    case "members-unavailable":
      return "Список участников не прочитался — человека не добавить.";
    case "room-write-failed":
      return "Состав зала не сохранился — повтори.";
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

// Ник и имя в аукционе: помощник знает человека по любому из них (PER-838).
const foundLabel = (member: {
  username?: string;
  auctionName?: string;
}): string =>
  member.username === undefined
    ? (member.auctionName ?? memberName(member))
    : member.auctionName === undefined
      ? memberName(member)
      : `${memberName(member)} · ${member.auctionName}`;

const memberName = (member: { username?: string }): string =>
  member.username === undefined ? "Участник" : `@${member.username}`;

// Экран помощника (PER-816): лот, состав зала и ставка нажатием на человека.
// Три вида: основной — люди с ценой; «Состав» — те же люди кнопками убрать;
// найденные по нику — кнопки добавить. Людей по две в ряд, место человека не
// меняется от ставок (решение владельца 20.10.2026).
export function floorScreen(view: FloorScreenView): ShownScreen {
  const { floor } = view;
  const auction = uuidToToken(floor.auctionId);
  const keyboard = new InlineKeyboard();
  const lot = floor.lot;
  const next = lot?.nextPrice;
  let title = floorTitle;
  const lines: string[] = [];
  const found = view.search !== undefined;
  const editing = view.edit === true && !found;
  if (floor.roomUnavailable === true) {
    lines.push(floorRoomUnavailableText);
  } else if (found) {
    const inRoom = new Set([
      ...floor.people.map((each) => each.participantId),
      ...floor.waiting.map((each) => each.identityId),
    ]);
    const candidates = (floor.found ?? []).filter(
      (each) => !inRoom.has(each.identityId),
    );
    lines.push(
      candidates.length === 0
        ? `По «${view.search}» все уже в зале.`
        : `Нашлось по «${view.search}»: ${candidates.length}. Нажми на человека, чтобы добавить его в зал.`,
    );
    for (const row of pairs(candidates)) {
      nextRow(keyboard);
      for (const member of row) {
        keyboard.text(
          buttonText(foundLabel(member)),
          floorAddData(auction, uuidToToken(member.identityId)),
        );
      }
    }
  } else {
    const size = floor.people.length + floor.waiting.length;
    lines.push(size === 0 ? floorEmptyRoomText : `В зале: ${size}.`);
    if (floor.waiting.length > 0) {
      lines.push(
        `Ждут имени в аукционе: ${floor.waiting.map(memberName).join(", ")}. Пусть откроют бота и выберут имя.`,
      );
    }
    if (editing) {
      for (const row of pairs([
        ...floor.people.map((each) => ({
          identityId: each.participantId,
          label: each.name,
        })),
        ...floor.waiting.map((each) => ({
          identityId: each.identityId,
          label: memberName(each),
        })),
      ])) {
        nextRow(keyboard);
        for (const member of row) {
          keyboard.text(
            buttonText(removeLabel(`Убрать ${member.label}`)),
            floorRemoveData(auction, uuidToToken(member.identityId)),
          );
        }
      }
    } else if (lot !== undefined && next !== undefined) {
      const page = paginate(pairs(floor.people), view.page);
      title = pagedTitle(floorTitle, page);
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
    if (!editing && floor.roomUnavailable !== true) {
      nextRow(keyboard).text(floorSearchLabel, floorSearchData(auction));
      if (size > 0) keyboard.text(floorEditLabel, floorEditData(auction));
    }
  }
  if (!found && !editing) {
    nextRow(keyboard).text(refreshLabel, floorData(auction));
  }
  return {
    id: found ? "floor-found" : editing ? "floor-room" : "floor-bids",
    text: screenText(
      title,
      view.stale === true ? escapeHtml(staleFloorText) : undefined,
      view.note === undefined ? undefined : escapeHtml(noteText(view.note)),
      lotLines(view).map(escapeHtml).join("\n"),
      lines.length === 0 ? undefined : lines.map(escapeHtml).join("\n"),
    ),
    keyboard: withNav(
      keyboard,
      found || editing
        ? { name: floorTitle, data: floorData(auction) }
        : toConsole(floor.auctionId),
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

// Вход — из пульта (PER-802), и возврат — в пульт.
function toConsole(auctionId: string): Parent {
  return { name: "Пульт", data: consoleViewData(uuidToToken(auctionId)) };
}
