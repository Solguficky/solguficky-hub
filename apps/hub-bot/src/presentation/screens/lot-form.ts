import { encodeAuctionCallback } from "@solguficky/auction-bot-ui";
import { InlineKeyboard } from "grammy";
import { lotCurrency } from "../../application/lot-form.js";
import type {
  LotAskError,
  LotFormView,
  LotQuestion,
  LotRefusal,
  LotTermsView,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import { lotAskData } from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import { escapeHtml, type Parent, screenText, withNav } from "./kit.js";
import type { ShownScreen } from "./show.js";

// Форма лота администратора в боте хаба (PER-319; ADR-057, дополнение
// 2026-10-05). Форма устроена как у сходки (дизайн-код, «Форма создания»): бот
// спрашивает только название, а дальше человек сам выбирает, что заполнить, с
// этого экрана. Цена и шаг — один ряд: Auction принимает их только парой.

const untitled = "Лот без названия";
// Заголовок карточки держит тот же предел; описание на экране правки — только
// напоминание, целиком его показывает карточка.
const titleLimit = 256;
const descriptionLimit = 600;

/**
 * Возврат к карточке лота. Страницу ленты форма не помнит: с карточки «‹ Лоты»
 * ведёт на первую.
 */
export function toLot(lotId: string): Parent {
  return {
    name: "Лот",
    data: encodeAuctionCallback({ kind: "lot", lotId, page: 0 }),
  };
}

/** Возврат в ленту аукциона, на первую страницу. */
export function toLots(auctionId: string): Parent {
  return {
    name: "Лоты",
    data: encodeAuctionCallback({ kind: "feed", auctionId, page: 0 }),
  };
}

export const lotSavedNote: Record<"created" | "text" | "terms", string> = {
  created: "Лот добавлен. Задай цену и шаг: без них он не выйдет на торги.",
  text: "Изменение сохранено.",
  terms: "Цена и шаг сохранены.",
};

function termsLines(terms: LotTermsView): string[] {
  switch (terms.kind) {
    case "unset":
      return ["Стартовая цена: не задана", "Шаг: не задан"];
    case "set":
      return [
        `Стартовая цена: ${money(terms.startingPrice)}`,
        // Шаг по сетке цен форма не задаёт и не пересказывает.
        `Шаг: ${terms.step === undefined ? "зависит от цены" : money(terms.step)}`,
      ];
    case "closed":
      return ["Торги по лоту начались: цену и шаг изменить нельзя."];
    default: {
      const _exhaustive: never = terms;
      return _exhaustive;
    }
  }
}

export function lotFormScreen(lot: LotFormView, note?: string): ShownScreen {
  const token = uuidToToken(lot.lotId);
  const keyboard = new InlineKeyboard()
    .text("Название", lotAskData(token, "title"))
    .row()
    .text("Описание", lotAskData(token, "description"));
  if (lot.terms.kind !== "closed") {
    keyboard.row().text("Цена и шаг", lotAskData(token, "price"));
  }
  return {
    id: "lot-form",
    text: screenText(
      "Изменить лот",
      note === undefined ? undefined : escapeHtml(note),
      [
        `Название: ${truncate(lot.title ?? untitled, titleLimit)}`,
        `Описание: ${lot.description === "" ? "нет" : truncate(lot.description, descriptionLimit)}`,
        ...termsLines(lot.terms),
      ]
        .map(escapeHtml)
        .join("\n"),
    ),
    keyboard: withNav(keyboard, toLot(lot.lotId)),
    format: "HTML",
  };
}

const lotAskErrorText: Record<LotAskError, string> = {
  "empty-title": "Название не может быть пустым.",
  "empty-description": "Описание не может быть пустым.",
  "amount-format": "Нужно целое число рублей: только цифры, без копеек.",
  "amount-range": "Сумма — от 1 до 9 999 999 рублей.",
  "step-refused": "Такой шаг аукцион не принимает. Пришли другой.",
};

const rublesOf = (amount: number) =>
  money({ minorUnits: amount * 100, currency: lotCurrency });

/** Что вопрос просит прислать, с образцом формата там, где формат есть. */
function prompt(question: LotQuestion): string {
  switch (question.kind) {
    case "new":
      return "Как называется лот? Название увидят участники в ленте и на карточке.";
    case "text":
      return question.field === "title"
        ? "Как назвать лот?"
        : "Опиши лот: что это, в каком состоянии, чем интересен.";
    case "price":
      return "Стартовая цена в рублях, целым числом. Например: 1500";
    case "step":
      return "Шаг ставки в рублях, целым числом: на столько новая ставка обязана быть выше текущей цены. Например: 100";
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

/** Текущее значение для строки «Сейчас: …»; нет — показывать нечего. */
function current(
  question: LotQuestion,
  lot: LotFormView | undefined,
): string | undefined {
  if (lot === undefined) return undefined;
  switch (question.kind) {
    case "new":
      return undefined;
    case "text":
      return question.field === "title"
        ? lot.title === undefined
          ? undefined
          : truncate(lot.title, titleLimit)
        : lot.description === ""
          ? "нет"
          : truncate(lot.description, descriptionLimit);
    case "price":
      return lot.terms.kind === "set"
        ? money(lot.terms.startingPrice)
        : undefined;
    case "step":
      return lot.terms.kind === "set" && lot.terms.step !== undefined
        ? money(lot.terms.step)
        : undefined;
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

/**
 * Текст вопроса формы лота (дизайн-код, «Вопросы»): причина отказа первой
 * строкой, затем текущее значение и то, что нужно прислать. Вопрос о шаге
 * называет принятую цену: в Auction она уйдёт вместе с шагом.
 */
export function lotQuestionText(
  question: LotQuestion,
  lot?: LotFormView,
  error?: LotAskError,
): string {
  const now = current(question, lot);
  return [
    ...(error === undefined ? [] : [lotAskErrorText[error]]),
    ...(question.kind === "step"
      ? [`Стартовая цена: ${rublesOf(question.priceRubles)}.`]
      : []),
    ...(now === undefined ? [] : [`Сейчас: ${now}`]),
    prompt(question),
  ].join("\n");
}

/** Текст кадра отказа; отказ по праву несёт общий текст хаба. */
export const lotRefusalText: Record<
  Exclude<LotRefusal, "not-administrator">,
  string
> = {
  "lots-frozen": "Торги уже начались. Добавить лот в этот аукцион нельзя.",
  "terms-closed": "Торги уже начались. Цену и шаг лота изменить нельзя.",
  "lot-not-found": "Лот не найден или больше недоступен.",
  "auction-not-found": "Аукцион не найден. Открой сходку заново.",
  "lot-not-in-auction": "Лот сняли с аукциона. Цену и шаг ему задать нельзя.",
};
