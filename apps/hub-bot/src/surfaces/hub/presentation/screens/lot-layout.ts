import { InlineKeyboard } from "grammy";
import type { LotLayoutView } from "../../../../auction-ui/index.js";
import { truncate } from "../../../../core/format.js";
import {
  arrangedLayout,
  generalPlace,
  layoutEditable,
  lotSectionLimit,
  lotsOfPlace,
  placeOfLot,
} from "../../application/lot-layout.js";
import type {
  AuctionConsoleSnapshot,
  ConsoleLotSnapshot,
  LotLayoutNote,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  consoleLayoutData,
  consoleLayoutListData,
  consoleLayoutLotData,
  consoleLayoutPlaceData,
  consoleSectionAskData,
  consoleSectionDeleteData,
  consoleSectionMoveData,
  consoleViewData,
} from "../parse-callback.js";
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
  withNav,
  withPager,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Порядок и разделы ленты (PER-719): администратор выставляет порядок лотов и
// делит их на разделы, пока финал впереди. Вход — «Порядок» пульта. В живом
// финале лента идёт порядком зала (PER-639), и экран только показывает
// раскладку.

const untitled = "Лот без названия";
const titleLimit = 60;
// Название раздела в кнопке и строке — укороченное, как название сета.
const nameLimit = 40;

const toConsole = (auction: string) => ({
  name: "Пульт",
  data: consoleViewData(auction),
});

const toLayout = (auction: string) => ({
  name: "Порядок",
  data: consoleLayoutData(auction),
});

function lotsLabel(count: number): string {
  return plural(count, ["лот", "лота", "лотов"]);
}

function titles(console: AuctionConsoleSnapshot): Map<string, string> {
  return new Map(
    console.lots.map((entry: ConsoleLotSnapshot) => [
      entry.lot.lotId,
      truncate(entry.lot.card?.title ?? untitled, titleLimit),
    ]),
  );
}

/** Название места: раздела или общего списка. */
function placeName(layout: LotLayoutView, place: number): string {
  if (place === generalPlace) {
    return layout.sections.length === 0 ? "Все лоты" : "Без раздела";
  }
  const section = layout.sections.find((each) => each.sectionId === place);
  return section === undefined
    ? "Раздел"
    : `Раздел «${truncate(section.name, nameLimit)}»`;
}

function noteText(note: LotLayoutNote): string {
  switch (note.kind) {
    case "deleted":
      return "Раздел удалён. Его лоты — в общем списке ленты.";
    case "changed":
      return "Порядок изменился. Открой его заново.";
    case "closed":
      return "Финал начался или аукцион закончен. Порядок ленты больше не меняется.";
    case "limit":
      return `Разделов уже ${lotSectionLimit}. Удали ненужный, чтобы завести новый.`;
    case "lot-not-in-auction":
      return "Этого лота нет в аукционе. Открой порядок заново.";
    default: {
      const _exhaustive: never = note;
      return _exhaustive;
    }
  }
}

/** Всплывающий текст принятого переноса лота. */
export const lotLayoutMovedToast = "Порядок сохранён.";

/**
 * «Порядок и разделы»: разделы строками и кнопками в порядке ленты, затем
 * общий список. Без разделов лента — один список. Пока финал впереди —
 * «Новый раздел».
 */
export function lotLayoutScreen(view: {
  console: AuctionConsoleSnapshot;
  note?: LotLayoutNote | undefined;
}): ShownScreen {
  const { console } = view;
  const auction = uuidToToken(console.auctionId);
  if (view.note !== undefined) {
    const subject = view.note.kind === "deleted" ? view.note.name : undefined;
    return {
      id: "outcome",
      text: outcomeText(noteText(view.note), subject),
      keyboard: withNav(
        new InlineKeyboard(),
        view.note.kind === "closed" ? toConsole(auction) : toLayout(auction),
      ),
      format: "HTML",
    };
  }
  const layout = arrangedLayout(console);
  const editable = layoutEditable(console.status);
  const keyboard = new InlineKeyboard();
  for (const section of layout.sections) {
    nextRow(keyboard).text(
      buttonText(
        `${truncate(section.name, nameLimit)} · ${lotsLabel(section.lotIds.length)}`,
      ),
      consoleLayoutListData(auction, section.sectionId),
    );
  }
  nextRow(keyboard).text(
    buttonText(
      `${placeName(layout, generalPlace)} · ${lotsLabel(layout.lotIds.length)}`,
    ),
    consoleLayoutListData(auction, generalPlace),
  );
  if (editable && layout.sections.length < lotSectionLimit) {
    nextRow(keyboard).text("Новый раздел", consoleSectionAskData(auction));
  }
  const lines = [
    ...layout.sections.map(
      (section, index) =>
        `${index + 1}. ${truncate(section.name, nameLimit)} — ${lotsLabel(section.lotIds.length)}`,
    ),
    `${placeName(layout, generalPlace)} — ${lotsLabel(layout.lotIds.length)}`,
  ];
  return {
    id: "lot-layout",
    text: screenText(
      "Порядок и разделы",
      escapeHtml(
        editable
          ? "Так лоты стоят в ленте у участников. С разделами лента начинается со списка разделов, а лоты без раздела идут после них. Новые лоты встают в конец общего списка."
          : "Так лоты стояли в ленте. Финал начался или аукцион закончен, и порядок больше не меняется.",
      ),
      lines.map(escapeHtml).join("\n"),
    ),
    keyboard: withNav(keyboard, toConsole(auction)),
    format: "HTML",
  };
}

/**
 * Раздел или общий список: лоты строками и кнопками в порядке ленты. Кнопка
 * лота открывает его место — выше, ниже, в другой раздел. У раздела —
 * «Раздел выше», «Раздел ниже», «Переименовать» и «Удалить раздел».
 */
export function lotLayoutListScreen(view: {
  console: AuctionConsoleSnapshot;
  place: number;
  at: { page: number } | { lotId: string };
}): ShownScreen {
  const { console, place } = view;
  const auction = uuidToToken(console.auctionId);
  const layout = arrangedLayout(console);
  const lots = lotsOfPlace(layout, place);
  if (lots === undefined) {
    return lotLayoutScreen({ console, note: { kind: "changed" } });
  }
  const names = titles(console);
  const at = view.at;
  const requested =
    "page" in at
      ? at.page
      : Math.floor(Math.max(lots.indexOf(at.lotId), 0) / pageSize);
  const page = paginate(lots, requested);
  const editable = layoutEditable(console.status);
  const first = page.page * pageSize;
  const label = (lotId: string, index: number) =>
    `${first + index + 1}. ${names.get(lotId) ?? untitled}`;
  const keyboard = new InlineKeyboard();
  if (editable) {
    page.items.forEach((lotId, index) => {
      nextRow(keyboard).text(
        buttonText(label(lotId, index)),
        consoleLayoutLotData(auction, uuidToToken(lotId)),
      );
    });
  }
  withPager(keyboard, page, (target) =>
    consoleLayoutListData(auction, place, target),
  );
  const index = layout.sections.findIndex(
    (section) => section.sectionId === place,
  );
  if (editable && index !== -1) {
    const moves: [string, "up" | "down"][] = [
      ...(index > 0 ? [["Раздел выше", "up"] as [string, "up"]] : []),
      ...(index < layout.sections.length - 1
        ? [["Раздел ниже", "down"] as [string, "down"]]
        : []),
    ];
    if (moves.length > 0) {
      nextRow(keyboard);
      for (const [text, direction] of moves) {
        keyboard.text(text, consoleSectionMoveData(auction, place, direction));
      }
    }
    nextRow(keyboard)
      .text("Переименовать", consoleSectionAskData(auction, place))
      .text(
        removeLabel("Удалить раздел"),
        consoleSectionDeleteData(auction, place),
      );
  }
  return {
    id: "lot-layout-list",
    text: screenText(
      pagedTitle(placeName(layout, place), page),
      lots.length === 0
        ? escapeHtml(
            place === generalPlace
              ? "Лотов вне разделов нет."
              : "В разделе пока нет лотов: перенеси их сюда с экрана лота.",
          )
        : [
            ...(editable
              ? [
                  escapeHtml(
                    "Нажми лот, чтобы поднять или опустить его либо перенести в другой раздел.",
                  ),
                  "",
                ]
              : []),
            ...page.items.map((lotId, at) => escapeHtml(label(lotId, at))),
          ].join("\n"),
    ),
    keyboard: withNav(keyboard, toLayout(auction)),
    format: "HTML",
  };
}

/**
 * Лот в раскладке: его место, «Выше» и «Ниже» и перенос в другой раздел или в
 * общий список. Лот встаёт в конец нового места.
 */
export function lotLayoutLotScreen(view: {
  console: AuctionConsoleSnapshot;
  lotId: string;
}): ShownScreen {
  const { console, lotId } = view;
  const auction = uuidToToken(console.auctionId);
  const layout = arrangedLayout(console);
  const at = placeOfLot(layout, lotId);
  if (at === undefined) {
    return lotLayoutScreen({ console, note: { kind: "changed" } });
  }
  const lots = lotsOfPlace(layout, at.place) ?? [];
  const lot = uuidToToken(lotId);
  const keyboard = new InlineKeyboard();
  if (layoutEditable(console.status)) {
    const moves: [string, "up" | "down"][] = [
      ...(at.index > 0 ? [["Выше", "up"] as [string, "up"]] : []),
      ...(at.index < lots.length - 1
        ? [["Ниже", "down"] as [string, "down"]]
        : []),
    ];
    if (moves.length > 0) {
      nextRow(keyboard);
      for (const [text, direction] of moves) {
        keyboard.text(text, consoleLayoutLotData(auction, lot, direction));
      }
    }
    for (const section of layout.sections) {
      if (section.sectionId === at.place) continue;
      nextRow(keyboard).text(
        buttonText(`В раздел «${truncate(section.name, nameLimit)}»`),
        consoleLayoutPlaceData(auction, lot, section.sectionId),
      );
    }
    if (at.place !== generalPlace) {
      nextRow(keyboard).text(
        "В общий список",
        consoleLayoutPlaceData(auction, lot, generalPlace),
      );
    }
  }
  const title = titles(console).get(lotId) ?? untitled;
  return {
    id: "lot-layout-lot",
    text: screenText(
      `Лот «${title}»`,
      escapeHtml(
        `${placeName(layout, at.place)}: место ${at.index + 1} из ${lots.length}.`,
      ),
    ),
    keyboard: withNav(keyboard, {
      name: "Список",
      data: consoleLayoutListData(
        auction,
        at.place,
        Math.floor(at.index / pageSize),
      ),
    }),
    format: "HTML",
  };
}

/**
 * Подтверждение удаления раздела. Раздел заводится заново, а лоты остаются в
 * ленте, поэтому «Да» без красного; ключ команды рождается на нажатие.
 */
export function lotSectionDeleteConfirmScreen(view: {
  console: AuctionConsoleSnapshot;
  sectionId: number;
}): ShownScreen {
  const { console, sectionId } = view;
  const layout = arrangedLayout(console);
  const section = layout.sections.find((each) => each.sectionId === sectionId);
  if (section === undefined) {
    return lotLayoutScreen({ console, note: { kind: "changed" } });
  }
  const auction = uuidToToken(console.auctionId);
  return {
    id: "lot-layout-section-delete-confirm",
    text: screenText(
      "Удалить раздел?",
      escapeHtml(
        `«${truncate(section.name, nameLimit)}» — ${lotsLabel(section.lotIds.length)}.`,
      ),
      escapeHtml(
        "Лоты раздела уйдут в конец общего списка ленты, раздел можно завести заново.",
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, удалить",
      yesData: consoleSectionDeleteData(auction, sectionId, true),
      noData: consoleLayoutListData(auction, sectionId),
    }),
    format: "HTML",
  };
}

export const lotSectionPrompt =
  "Название раздела одной строкой — его увидят участники в ленте. Например: Книги";

export const lotSectionRenamePrompt =
  "Новое название раздела одной строкой — его увидят участники в ленте.";

/** Причина отказа ответу о названии: заголовок экрана исхода. */
export const lotSectionAskErrorText = {
  "name-empty": "Название пустое. Напиши название раздела.",
} as const;
