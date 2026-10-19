import { InlineKeyboard } from "grammy";
import { encodeAuctionCallback } from "../../../../auction-ui/index.js";
import { marked, pictogram } from "../../../../core/pictograms.js";
import { isSold, lotCurrency } from "../../application/lot-form.js";
import type {
  LotAskError,
  LotFormView,
  LotQuestion,
  LotRefusal,
  LotTermsView,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  lotAskData,
  lotFormData,
  lotPreviewData,
  lotStepModeData,
} from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import {
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  screenText,
  withNav,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Форма лота администратора в боте хаба (PER-319; ADR-057, дополнение
// 2026-10-05). Новый лот бот ведёт цепочкой (PER-618, решение владельца
// 14 октября 2026 года): название, стартовая цена, способ шага, шаг или пороги
// и фото по порядку, затем «Лот готов». Описание — по желанию, с экрана правки,
// где человек сам выбирает, что поменять. Цена и шаг — один ряд: Auction
// принимает их только парой.
// Фото (PER-452) меняется, как тексты, и после старта торгов: это каталог, а не
// условия торгов (ADR-057).

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

export const lotSavedNote: Record<
  "created" | "text" | "terms" | "image" | "ready",
  string
> = {
  created: "Лот добавлен. Задай цену и шаг: без них он не выйдет на торги.",
  text: "Изменение сохранено.",
  terms: "Цена и шаг сохранены.",
  image: "Фото сохранено.",
  // Конец цепочки нового лота (PER-618): фото принято или пропущено.
  ready: "Лот готов. Описание — по желанию: его добавляет «Изменить лот».",
};

/**
 * Строки над вопросом цепочки нового лота (PER-618): что уже сделано. Они
 * стоят только на переходе — вопрос, заданный заново, их не несёт.
 */
export const lotChainLead = {
  created: "Лот добавлен. Без цены и шага он не выйдет на торги.",
  terms: "Цена и шаг сохранены.",
} as const;

/** «Пропустить» под вопросом о фото в цепочке нового лота (PER-618). */
export const skipPhotoLabel = "Пропустить";

function stepTermsLines(
  terms: Extract<LotTermsView, { kind: "set" }>,
): string[] {
  if (terms.tiers !== undefined) {
    return [
      "Шаг по порогам:",
      ...terms.tiers.map(
        (tier) => `от ${money(tier.lowerBound)} — ${money(tier.step)}`,
      ),
    ];
  }
  return [
    `Шаг: ${terms.step === undefined ? "зависит от цены" : money(terms.step)}`,
  ];
}

function termsLines(terms: LotTermsView): string[] {
  switch (terms.kind) {
    case "unset":
      return ["Стартовая цена: не задана", "Шаг: не задан"];
    case "set":
      return [
        `Стартовая цена: ${money(terms.startingPrice)}`,
        ...stepTermsLines(terms),
      ];
    case "closed":
      return terms.soldFor === undefined
        ? ["Торги по лоту начались: цену и шаг изменить нельзя."]
        : [
            `Лот продан за ${money(terms.soldFor)}: название, описание и фото больше не меняются.`,
          ];
    default: {
      const _exhaustive: never = terms;
      return _exhaustive;
    }
  }
}

/**
 * Экран выбора способа шага (PER-491): цена уже принята, шаг ещё нет. Кнопка
 * несёт цену, чтобы вопрос о шаге задавался и после рестарта, а в цепочке
 * нового лота (PER-618) — и признак цепочки.
 */
export function lotStepModeScreen(
  lot: LotFormView,
  priceRubles: number,
  chain?: boolean,
): ShownScreen {
  const token = uuidToToken(lot.lotId);
  // Бинарная пара выбора — одним рядом (дизайн-код, «Клавиатура»).
  const keyboard = new InlineKeyboard()
    .text("Один шаг", lotStepModeData(token, priceRubles, "single", chain))
    .text("По порогам", lotStepModeData(token, priceRubles, "tiered", chain));
  return {
    id: "lot-step-mode",
    text: screenText(
      "Шаг ставки",
      [
        `Стартовая цена: ${rublesOf(priceRubles)}.`,
        "Как задать шаг?",
        "Один шаг — на столько поднимается ставка при любой цене.",
        "По порогам — шаг растёт вместе с ценой.",
      ]
        .map(escapeHtml)
        .join("\n"),
    ),
    // Возврат — в форму лота, а не на карточку: сюда человек попал из неё.
    keyboard: withNav(keyboard, {
      name: "Изменить лот",
      data: lotFormData(token),
    }),
    format: "HTML",
  };
}

/**
 * Исход правки лота — свой экран (PER-472): исход в заголовке, название лота
 * жирным. «Изменить лот» возвращает к правке одним нажатием, «‹ Лот» — к
 * карточке.
 */
export function lotSavedScreen(lot: LotFormView, outcome: string): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(outcome, lot.title),
    keyboard: withNav(
      new InlineKeyboard().text(
        "Изменить лот",
        lotFormData(uuidToToken(lot.lotId)),
      ),
      toLot(lot.lotId),
    ),
    format: "HTML",
  };
}

/**
 * Экран правки лота: поля по два в ряд со знаками (прогон 12.10, №17 и №18).
 * После старта торгов ряда «Цена и шаг» нет; у проданного лота нет и рядов
 * названия, описания и фото (решение владельца 15 октября 2026 года).
 */
export function lotFormScreen(lot: LotFormView): ShownScreen {
  const token = uuidToToken(lot.lotId);
  const sold = isSold(lot.terms);
  const fields: [label: string, data: string][] = [
    ...(sold
      ? []
      : ([
          [marked(pictogram.title, "Название"), lotAskData(token, "title")],
          [
            marked(pictogram.description, "Описание"),
            lotAskData(token, "description"),
          ],
          [marked(pictogram.photo, "Фото"), lotAskData(token, "image")],
        ] satisfies [string, string][])),
    ...(lot.terms.kind === "closed"
      ? []
      : ([
          [marked(pictogram.price, "Цена и шаг"), lotAskData(token, "price")],
        ] satisfies [string, string][])),
  ];
  const keyboard = new InlineKeyboard();
  fields.forEach(([label, data], index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(label, data);
  });
  // Предпросмотр (PER-512) — и после старта торгов: участник видит ту же
  // карточку, только с ценой.
  nextRow(keyboard).text("Глазами участника", lotPreviewData(token));
  return {
    id: "lot-form",
    text: screenText(
      "Изменить лот",
      [
        `Название: ${truncate(lot.title ?? untitled, titleLimit)}`,
        `Описание: ${lot.description === "" ? "нет" : truncate(lot.description, descriptionLimit)}`,
        `Фото: ${lot.hasImage ? "есть" : "нет"}`,
        ...termsLines(lot.terms),
      ]
        .map(escapeHtml)
        .join("\n"),
    ),
    keyboard: withNav(keyboard, toLot(lot.lotId)),
    format: "HTML",
  };
}

const lotAskErrors: Record<LotAskError, string> = {
  "empty-title": "Название не может быть пустым.",
  "empty-description": "Описание не может быть пустым.",
  "amount-format": "Нужно целое число рублей. Только цифры, без копеек.",
  "amount-range": "Сумма — от 1 до 9 999 999 рублей.",
  "step-format":
    "Порог — строка «от суммы — шаг», целыми рублями. Например: 0 — 100.",
  "step-order": "Пороги идут по возрастанию, и первый начинается с 0.",
  "step-refused": "Аукцион отклонил такой шаг. Проверь шаг и пришли заново.",
  "image-too-large": "Фото слишком большое, аукцион его не принял.",
  "unsupported-image": "Аукцион не узнал в этом файле изображение.",
  "photo-needed": "Нужна фотография, а не текст, файл или стикер.",
  "photo-album": "Нужна одна фотография, альбом не подходит.",
  "photo-unavailable": "Не получилось получить фото у Telegram.",
};

/**
 * Предел Auction словами: мегабайты с одним знаком, меньше мегабайта — в
 * килобайтах. Число берётся из отказа, а не из кода бота: предел держит Auction.
 */
export function imageLimitText(maxBytes: number): string {
  const mib = 1024 * 1024;
  if (maxBytes >= mib) {
    const value = Math.round((maxBytes / mib) * 10) / 10;
    return `${String(value).replace(".", ",")} МБ`;
  }
  return `${Math.max(1, Math.round(maxBytes / 1024))} КБ`;
}

/** Причина отказа ответу на вопрос формы лота: заголовок экрана исхода. */
export function lotAskErrorText(
  error: LotAskError,
  maxImageBytes?: number,
): string {
  return error === "image-too-large" && maxImageBytes !== undefined
    ? `Фото больше ${imageLimitText(maxImageBytes)}, аукцион его не принял.`
    : lotAskErrors[error];
}

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
      return question.mode === "single"
        ? "Шаг ставки в рублях, целым числом: на столько новая ставка обязана быть выше текущей цены. Например: 100"
        : "Пороги шага строками «от суммы — шаг». Первый — от 0, дальше границы возрастают, шаг растёт. Например:\n0 — 100\n5000 — 250";
    case "image":
      return question.chain === true
        ? "Пришли фото лота ответом на это сообщение. Его увидят участники на карточке лота. Нет фото под рукой — «Пропустить», его можно добавить потом."
        : "Пришли фото лота ответом на это сообщение. Его увидят участники на карточке лота.";
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
      if (lot.terms.kind !== "set") return undefined;
      return lot.terms.tiers !== undefined
        ? lot.terms.tiers
            .map((tier) => `от ${money(tier.lowerBound)} — ${money(tier.step)}`)
            .join(", ")
        : lot.terms.step === undefined
          ? undefined
          : money(lot.terms.step);
    case "image":
      return lot.hasImage ? "фото есть, новое его заменит" : "нет";
    default: {
      const _exhaustive: never = question;
      return _exhaustive;
    }
  }
}

/**
 * Текст вопроса формы лота (дизайн-код, «Вопросы»): что уже сделано на
 * переходе цепочки, затем текущее значение и то, что нужно прислать. Вопрос о
 * шаге называет принятую цену: в Auction она уйдёт вместе с шагом. У вопроса
 * цепочки нового лота (PER-618) строки «Сейчас» нет: значение ещё не задано.
 */
export function lotQuestionText(
  question: LotQuestion,
  lot?: LotFormView,
  lead?: string,
): string {
  const chained =
    question.kind !== "new" &&
    question.kind !== "text" &&
    question.chain === true;
  const now = chained ? undefined : current(question, lot);
  return [
    ...(lead === undefined ? [] : [lead]),
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
  "lot-sold": "Лот продан. Название, описание и фото больше не меняются.",
  "lot-not-found": "Лот не найден или больше недоступен.",
  "auction-not-found": "Аукцион не найден. Открой сходку заново.",
  "lot-not-in-auction": "Лот сняли с аукциона. Цену и шаг ему задать нельзя.",
  "meetup-cancelled": "Сходку отменили. Лоты её аукциона больше не меняются.",
};
