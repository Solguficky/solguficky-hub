import { InlineKeyboard } from "grammy";
import { acceptsLots } from "../../application/auction-console.js";
import { lotSetLimit, lotSetRef } from "../../application/lot-sets.js";
import type {
  AuctionConsoleSnapshot,
  ConsoleLotSnapshot,
  LotSet,
  LotSetNote,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleSetAskData,
  consoleSetData,
  consoleSetDeleteConfirmData,
  consoleSetDeleteData,
  consoleSetLotData,
  consoleSetsData,
} from "../parse-callback.js";
import { truncate } from "./auction.js";
import {
  buttonText,
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  pagedTitle,
  pageSize,
  paginate,
  plural,
  removeLabel,
  screenText,
  toAuctionRoot,
  toggleLabel,
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Сеты лотов аукциона (ADR-073, PER-509): организатор называет сет и выбирает
// его лоты из реестра, пока онлайн-неделя не открыта; после открытия сеты
// видны только для просмотра. Вход — «🛠 Сеты» корня аукциона.

const untitled = "Лот без названия";
const titleLimit = 120;
// Название сета в кнопке и строке — укороченное, как название лота.
const nameLimit = 60;

const toSets = (auction: string) => ({
  name: "Сеты",
  data: consoleSetsData(auction),
});

function lotsLabel(count: number): string {
  return plural(count, ["лот", "лота", "лотов"]);
}

function nameOf(set: LotSet): string {
  return truncate(set.name, nameLimit);
}

function titleOf(entry: ConsoleLotSnapshot): string {
  return truncate(entry.lot.card?.title ?? untitled, titleLimit);
}

// Неполный сет — меньше двух лотов (ADR-073, п. 1): участники его не видят.
function incomplete(set: LotSet): boolean {
  return set.lotIds.length < 2;
}

function setLine(set: LotSet, index: number): string {
  const count = lotsLabel(set.lotIds.length);
  return incomplete(set)
    ? `${index + 1}. ${nameOf(set)} — ${count}, неполный`
    : `${index + 1}. ${nameOf(set)} — ${count}`;
}

/** Текст исхода команды над сетами: заголовок экрана исхода. */
function noteText(note: LotSetNote): string {
  switch (note.kind) {
    case "deleted":
      return "Сет удалён. Лоты остались в аукционе.";
    case "already-deleted":
      return "Сет уже удалён.";
    case "changed":
      return "Сеты изменились. Открой сет заново.";
    case "frozen":
      return "Торги уже начались. Сеты этого аукциона больше не меняются.";
    case "limit":
      return `Сетов уже ${lotSetLimit}. Удали ненужный, чтобы завести новый.`;
    case "lot-not-in-auction":
      return "Этого лота нет в аукционе. Открой сет заново.";
    case "lot-in-another-set":
      return note.name === undefined
        ? "Лот уже в другом сете. Сначала убери его оттуда."
        : `Лот уже в сете «${truncate(note.name, nameLimit)}». Сначала убери его оттуда.`;
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

/** Всплывающий текст принятого переключателя лота в сете. */
export function lotSetLotToast(selected: boolean): string {
  return selected ? "Лот добавлен в сет." : "Лот убран из сета.";
}

/**
 * «Сеты»: сеты строками с номером, названием и числом лотов, неполный —
 * с пометкой. Пока неделя не открыта — «Новый сет»; кнопка на каждый сет
 * открывает его и после открытия, только для просмотра.
 */
export function lotSetsScreen(view: {
  console: AuctionConsoleSnapshot;
  note?: LotSetNote | undefined;
}): ShownScreen {
  const { console } = view;
  const auction = uuidToToken(console.auctionId);
  if (view.note !== undefined) {
    const subject = view.note.kind === "deleted" ? view.note.name : undefined;
    return {
      id: "outcome",
      text: outcomeText(noteText(view.note), subject),
      keyboard: withNav(new InlineKeyboard(), toSets(auction)),
      format: "HTML",
    };
  }
  const sets = console.lotSets;
  const editable = acceptsLots(console.status);
  const keyboard = new InlineKeyboard();
  sets.slice(0, lotSetLimit).forEach((set, index) => {
    nextRow(keyboard).text(
      buttonText(`${nameOf(set)} · ${lotsLabel(set.lotIds.length)}`),
      consoleSetData(auction, lotSetRef(set, index)),
    );
  });
  if (editable && sets.length < lotSetLimit) {
    nextRow(keyboard).text("Новый сет", consoleSetAskData(auction));
  }
  return {
    id: "lot-sets",
    text: screenText(
      "Сеты",
      escapeHtml(
        editable
          ? "Сет — лоты, которые собирают вместе: кто купит все лоты сета, получит отметку собранного сета. Сеты меняются до открытия недели."
          : "Сет — лоты, которые собирают вместе: кто купит все лоты сета, получит отметку собранного сета. Неделя открыта, и сеты больше не меняются.",
      ),
      sets.length === 0
        ? "Сетов пока нет."
        : [
            ...sets.map((set, index) => escapeHtml(setLine(set, index))),
            ...(sets.some(incomplete)
              ? [
                  escapeHtml(
                    "Неполный сет участники не видят: в сете нужно хотя бы два лота.",
                  ),
                ]
              : []),
          ].join("\n"),
    ),
    keyboard: withNav(keyboard, toAuctionRoot(console.auctionId)),
    format: "HTML",
  };
}

/**
 * Сет: число лотов, затем лоты реестра в порядке заведения переключателями
 * «в сете — нет». Лот чужого сета подписан его сетом: нажатие объяснит, что
 * лот сначала убирают оттуда. После открытия недели — только лоты сета в
 * порядке организатора.
 */
export function lotSetScreen(view: {
  console: AuctionConsoleSnapshot;
  index: number;
  at: { page: number } | { lotId: string };
}): ShownScreen {
  const { console, index } = view;
  const auction = uuidToToken(console.auctionId);
  const set = console.lotSets[index];
  if (set === undefined) {
    return lotSetsScreen({ console, note: { kind: "changed" } });
  }
  const ref = lotSetRef(set, index);
  const title = `Сет «${nameOf(set)}»`;
  const count = set.lotIds.length;
  const summary =
    count < 2
      ? `В сете ${lotsLabel(count)}. Неполный: участники увидят сет, когда в нём будет хотя бы два лота.`
      : `В сете ${lotsLabel(count)}.`;
  const keyboard = new InlineKeyboard();
  let heading: string;
  let lines: string;
  if (acceptsLots(console.status)) {
    const lots = [...console.lots].sort((a, b) =>
      a.lot.lotId < b.lot.lotId ? -1 : a.lot.lotId > b.lot.lotId ? 1 : 0,
    );
    const at = view.at;
    const requested =
      "page" in at
        ? at.page
        : Math.floor(
            Math.max(
              lots.findIndex((each) => each.lot.lotId === at.lotId),
              0,
            ) / pageSize,
          );
    const page = paginate(lots, requested);
    heading = pagedTitle(title, page);
    for (const entry of page.items) {
      const lotId = entry.lot.lotId;
      const selected = set.lotIds.includes(lotId);
      const holder = console.lotSets.find(
        (each) => each.lotSetId !== set.lotSetId && each.lotIds.includes(lotId),
      );
      const label =
        holder === undefined
          ? titleOf(entry)
          : `${titleOf(entry)} · в сете «${nameOf(holder)}»`;
      nextRow(keyboard).text(
        buttonText(toggleLabel(label, selected)),
        consoleSetLotData({
          auction,
          set: ref,
          lot: uuidToToken(lotId),
          selected: !selected,
        }),
      );
    }
    withPager(keyboard, page, (target) => consoleSetData(auction, ref, target));
    nextRow(keyboard).text(
      removeLabel("Удалить сет"),
      consoleSetDeleteData(auction, ref),
    );
    lines =
      lots.length === 0
        ? "Лотов пока нет: заведи их в ленте аукциона."
        : escapeHtml("Вкл — лот в сете. Лот входит только в один сет.");
  } else {
    heading = title;
    // Сеты читаются с аукционом, а лоты — с отставанием: лот сета, которого
    // реестр ещё не отдал, стоит строкой без названия.
    const byId = new Map(console.lots.map((each) => [each.lot.lotId, each]));
    lines =
      count === 0
        ? "Лотов в сете нет."
        : set.lotIds
            .map((lotId) => {
              const entry = byId.get(lotId);
              return escapeHtml(
                `• ${entry === undefined ? untitled : titleOf(entry)}`,
              );
            })
            .join("\n");
  }
  return {
    id: "lot-set",
    text: screenText(heading, escapeHtml(summary), lines),
    keyboard: withNav(keyboard, toSets(auction)),
    format: "HTML",
  };
}

/**
 * Подтверждение удаления сета. Сет задаётся заново, поэтому «Да» без красного;
 * ключ команды рождается на нажатие.
 */
export function lotSetDeleteConfirmScreen(view: {
  console: AuctionConsoleSnapshot;
  index: number;
}): ShownScreen {
  const { console, index } = view;
  const set = console.lotSets[index];
  if (set === undefined) {
    return lotSetsScreen({ console, note: { kind: "changed" } });
  }
  const auction = uuidToToken(console.auctionId);
  const ref = lotSetRef(set, index);
  return {
    id: "lot-set-delete-confirm",
    text: screenText(
      "Удалить сет?",
      escapeHtml(`«${nameOf(set)}» — ${lotsLabel(set.lotIds.length)}.`),
      escapeHtml("Лоты останутся в аукционе, сет можно завести заново."),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, удалить",
      yesData: consoleSetDeleteConfirmData(auction, ref),
      noData: consoleSetData(auction, ref),
    }),
    format: "HTML",
  };
}

export const lotSetPrompt =
  "Название сета одной строкой — его увидят участники в карточках лотов. Например: Кружки с котами";

/** Причина отказа ответу о названии: заголовок экрана исхода. */
export const lotSetAskErrorText = {
  "name-empty": "Название пустое. Напиши название сета.",
} as const;
