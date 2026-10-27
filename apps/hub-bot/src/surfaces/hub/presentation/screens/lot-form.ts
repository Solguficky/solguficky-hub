import { InlineKeyboard } from "grammy";
import { encodeAuctionCallback } from "../../../../auction-ui/index.js";
import { maxLotPhotos } from "../../../../core/auction/lot-photos.js";
import { marked, pictogram } from "../../../../core/pictograms.js";
import {
  isSold,
  keptStep,
  lotCurrency,
  maxLotCopies,
  minLotCopies,
  numberedTitle,
} from "../../application/lot-form.js";
import type {
  LotAskError,
  LotFormView,
  LotQuestion,
  LotRefusal,
  LotSetField,
  LotSetMiss,
  LotTermsView,
  LotTierView,
} from "../../application/types.js";
import { uuidToToken } from "../meetup-deep-link.js";
import {
  lotAskData,
  lotCopyData,
  lotFormData,
  lotKeepStepData,
  lotPhotoRemoveConfirmData,
  lotPhotoRemoveData,
  lotPhotosData,
  lotPreviewData,
  lotRemoveConfirmData,
  lotRemoveData,
  lotScopeData,
  lotSetRetryData,
  lotStepModeData,
} from "../parse-callback.js";
import { money, truncate } from "./auction.js";
import {
  confirmKeyboard,
  escapeHtml,
  nextRow,
  outcomeText,
  type Parent,
  removeLabel,
  screenText,
  subjectLine,
  submenuText,
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
// условия торгов (ADR-057). Фото у лота — список до десяти (PER-721): экран
// «Фото лота» добавляет фото в конец и убирает любое.

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
  "created" | "text" | "terms" | "ready",
  string
> = {
  created: "Лот добавлен. Задай цену и шаг: без них он не выйдет на торги.",
  text: "Изменение сохранено.",
  terms: "Цена и шаг сохранены.",
  // Конец цепочки нового лота (PER-618): фото принято или пропущено.
  ready: "Лот готов. Описание — по желанию: его добавляет «Изменить лот».",
};

/** Исход команды фото: добавлено, убрано или снимать было нечего. */
export type PhotoSaved = "photo-added" | "photo-removed" | "photo-missing";

/** Предел фото у лота (PER-721): тот же держит Auction, общий у обоих ботов. */
export const lotPhotoLimit = maxLotPhotos;

/**
 * Исход команды фото (PER-715, PER-721) с числом фото после неё: число берётся
 * из ответа Auction, а не из отстающего чтения.
 */
export function photoSavedNote(saved: PhotoSaved, count: number): string {
  const done =
    saved === "photo-added"
      ? "Фото добавлено."
      : saved === "photo-removed"
        ? "Фото убрано."
        : "Этого фото у лота уже нет.";
  return count === 0
    ? `${done} У лота нет фото.`
    : `${done} Фото у лота: ${count} из ${lotPhotoLimit}.`;
}

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

/**
 * «Добавить фото» на экране «Фото лота» (PER-721): экран формы админский
 * целиком, и знака у кнопки нет (`pictogram.admin`).
 */
export const addPhotoLabel = "Добавить фото";

/** «Убрать фото N» на экране «Фото лота» (PER-715, PER-721). */
export function removePhotoLabel(index: number): string {
  return marked(pictogram.remove, `Убрать фото ${index}`);
}

function photoCountLine(count: number): string {
  return count === 0
    ? "Фото пока нет."
    : `Фото: ${count} из ${lotPhotoLimit}. Первое — обложка: оно открывает карточку и стоит на экране зала.`;
}

/**
 * Экран «Фото лота» (PER-721): сколько фото, «Добавить фото» и «Убрать фото N»
 * по порядку показа. Участник листает их каруселью в карточке; посмотреть
 * их можно «Глазами участника». У лота с пределом фото добавить нечего: строка
 * говорит, что сначала нужно убрать одно.
 */
export function lotPhotosScreen(lot: LotFormView): ShownScreen {
  const token = uuidToToken(lot.lotId);
  const count = lot.photos.length;
  const full = count >= lotPhotoLimit;
  const keyboard = new InlineKeyboard();
  // У лота полного сета «Добавить фото» сначала спрашивает, только ли этот
  // лот или все лоты сета (PER-716): фото встанет в конец каждого.
  const set = lot.registry?.set;
  if (!full) {
    keyboard.text(
      addPhotoLabel,
      set !== undefined && set.size >= 2
        ? lotScopeData(token, "image")
        : lotAskData(token, "image"),
    );
  }
  lot.photos.forEach((_, index) => {
    nextRow(keyboard).text(
      removePhotoLabel(index + 1),
      lotPhotoRemoveData(token, index + 1),
    );
  });
  return {
    id: "lot-photos",
    text: submenuText(
      "Фото лота",
      truncate(lot.title ?? untitled, titleLimit),
      escapeHtml(
        [
          photoCountLine(count),
          ...(full
            ? [
                `Больше ${lotPhotoLimit} фото у лота не бывает: чтобы добавить новое, убери одно.`,
              ]
            : []),
        ].join("\n"),
      ),
    ),
    keyboard: withNav(keyboard, {
      name: "Изменить лот",
      data: lotFormData(token),
    }),
    format: "HTML",
  };
}

/**
 * Подтверждение снятия фото (PER-715, PER-721). Вернуть фото бот не может — его
 * присылают заново, — поэтому «Да» красное, как у «Убрать материал». «Нет»
 * возвращает на экран фото: подтверждение открыто с него.
 */
export function lotPhotoRemoveConfirmScreen(
  lot: LotFormView,
  index: number,
  print: string,
): ShownScreen {
  const token = uuidToToken(lot.lotId);
  const count = lot.photos.length;
  return {
    id: "lot-image-remove-confirm",
    text: screenText(
      "Убрать фото?",
      subjectLine(lot.title ?? untitled),
      escapeHtml(
        [
          `Фото ${index} из ${count}.`,
          count === 1
            ? "Участники увидят карточку лота без фото."
            : index === 1
              ? "Участники больше не увидят его в карточке, обложкой станет следующее фото."
              : "Участники больше не увидят его в карточке лота.",
          "Вернуть его можно, только прислав фото заново.",
        ].join(" "),
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, убрать фото",
      yesData: lotPhotoRemoveConfirmData(token, print),
      noData: lotPhotosData(token),
      irreversible: true,
    }),
    format: "HTML",
  };
}

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

/** Предупреждение на выборе способа шага при правке цены (PER-714). */
export const unsavedPriceNote =
  "Цена сохранится только вместе с шагом: «‹ Изменить лот» её не сохранит.";

/**
 * Подпись «Оставить шаг» по прежнему шагу лота (PER-714) — тому же, что
 * сохранит команда; шага нет — оставлять нечего, и кнопки нет.
 */
function keptStepLabel(terms: LotTermsView): string | undefined {
  const step = keptStep(terms);
  if (step === undefined) return undefined;
  return step.policy.kind === "tiered"
    ? "Оставить пороги шага"
    : `Оставить шаг ${money(step.policy.step)}`;
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
  // Правка цены всех лотов сета (PER-716): признак едет дальше в кнопках.
  set?: boolean,
): ShownScreen {
  const token = uuidToToken(lot.lotId);
  const scope = set === true ? "set" : chain;
  // Бинарная пара выбора — одним рядом (дизайн-код, «Клавиатура»).
  const keyboard = new InlineKeyboard()
    .text("Один шаг", lotStepModeData(token, priceRubles, "single", scope))
    .text("По порогам", lotStepModeData(token, priceRubles, "tiered", scope));
  // Правка цены у лота с шагом (PER-714): прежний шаг оставляется одним
  // нажатием, а уход возвратом цену не сохраняет — экран говорит это до ухода.
  // В цепочке нового лота прежнего шага нет.
  const kept = chain === true ? undefined : keptStepLabel(lot.terms);
  if (kept !== undefined) {
    keyboard.row().text(kept, lotKeepStepData(token, priceRubles, set));
  }
  return {
    id: "lot-step-mode",
    text: screenText(
      "Шаг ставки",
      [
        `Стартовая цена: ${rublesOf(priceRubles)}.`,
        "Как задать шаг?",
        "Один шаг — на столько поднимается ставка при любой цене.",
        "По порогам — шаг растёт вместе с ценой.",
        ...(chain === true ? [] : [unsavedPriceNote]),
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
 * Исход команды фото (PER-721): исход в заголовке, число фото абзацем, «Фото лота»
 * — к следующему фото одним нажатием, «‹ Лот» — к карточке.
 */
export function lotPhotoSavedScreen(
  lot: LotFormView,
  saved: PhotoSaved,
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(photoSavedNote(saved, lot.photos.length), lot.title),
    keyboard: withNav(
      new InlineKeyboard().text(
        "Фото лота",
        lotPhotosData(uuidToToken(lot.lotId)),
      ),
      toLot(lot.lotId),
    ),
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
  const set = lot.registry?.set;
  // Поле лота полного сета сначала спрашивает, только ли этот лот править
  // или все лоты сета (PER-716).
  const field = (name: "title" | "description" | "image" | "price") =>
    set !== undefined && set.size >= 2
      ? lotScopeData(token, name)
      : lotAskData(token, name);
  const fields: [label: string, data: string][] = [
    ...(sold
      ? []
      : ([
          [marked(pictogram.title, "Название"), field("title")],
          [marked(pictogram.description, "Описание"), field("description")],
          [marked(pictogram.photo, "Фото"), lotPhotosData(token)],
        ] satisfies [string, string][])),
    ...(lot.terms.kind === "closed"
      ? []
      : ([[marked(pictogram.price, "Цена и шаг"), field("price")]] satisfies [
          string,
          string,
        ][])),
  ];
  const keyboard = new InlineKeyboard();
  fields.forEach(([label, data], index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(label, data);
  });
  // Предпросмотр (PER-512) — и после старта торгов: участник видит ту же
  // карточку, только с ценой.
  nextRow(keyboard).text("Глазами участника", lotPreviewData(token));
  // Копии и удаление (PER-716) — пока реестр открыт, то есть до онлайн-недели.
  // Копии собираются в сет, поэтому у лота, который уже в сете, их нет.
  if (lot.registry?.open === true) {
    if (set === undefined) {
      keyboard.row().text("Копировать", lotCopyData(token));
    }
    keyboard.row().text(removeLabel("Удалить лот"), lotRemoveData(token));
  }
  return {
    id: "lot-form",
    text: screenText(
      "Изменить лот",
      [
        `Название: ${truncate(lot.title ?? untitled, titleLimit)}`,
        `Описание: ${lot.description === "" ? "нет" : truncate(lot.description, descriptionLimit)}`,
        `Фото: ${lot.photos.length === 0 ? "нет" : lot.photos.length}`,
        ...termsLines(lot.terms),
        ...(set === undefined ? [] : [`Сет: ${set.name}, лотов: ${set.size}`]),
      ]
        .map(escapeHtml)
        .join("\n"),
    ),
    keyboard: withNav(keyboard, toLot(lot.lotId)),
    format: "HTML",
  };
}

// Образец порогов: тот же у вопроса и у отказов, чтобы человек видел один ввод.
const tiersExample = "0 — 100\n5000 — 250";
// Отказ на пороги не с нуля: обычно человек начал со стартовой цены.
const fromZeroReason =
  "Первый порог — 0. Пороги считаются по цене лота от 0, а не от стартовой цены.";

const lotAskErrors: Record<LotAskError, string> = {
  "empty-title": "Название не может быть пустым.",
  "empty-description": "Описание не может быть пустым.",
  "amount-format": "Нужно целое число рублей. Только цифры, без копеек.",
  "amount-range": "Сумма — от 1 до 9 999 999 рублей.",
  "step-format":
    "Это не порог. Каждая строка — «от цены — шаг» целыми рублями. Например: 0 — 100.",
  "step-start": `${fromZeroReason} Например:\n${tiersExample}`,
  "step-order": `Цены порогов не по возрастанию. Каждый следующий порог — с цены выше прежнего. Например:\n${tiersExample}`,
  "step-decreasing": `Шаг не может уменьшаться. С ростом цены шаг остаётся прежним или растёт. Например:\n${tiersExample}`,
  "step-refused": "Аукцион отклонил такой шаг. Проверь шаг и пришли заново.",
  "image-too-large": "Фото слишком большое, аукцион его не принял.",
  "unsupported-image": "Аукцион не узнал в этом файле изображение.",
  "photo-needed": "Нужна фотография, а не текст, файл или стикер.",
  "photo-unavailable":
    "Не получилось получить фото у Telegram. Пришли фото ещё раз.",
  "photo-not-saved":
    "Не получилось сохранить фото. Это на моей стороне. Пришли фото ещё раз.",
  "copies-count": `Нужно целое число от ${minLotCopies} до ${maxLotCopies}.`,
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

// Пороги так, как их вводят: целые рубли без разрядов и знака валюты.
function tiersInput(tiers: LotTierView[]): string {
  return tiers
    .map(
      (tier) =>
        `${tier.lowerBound.minorUnits / 100} — ${tier.step.minorUnits / 100}`,
    )
    .join("\n");
}

/** Причина отказа ответу на вопрос формы лота: заголовок экрана исхода. */
export function lotAskErrorText(
  error: LotAskError,
  details: {
    maxImageBytes?: number | undefined;
    suggestedTiers?: LotTierView[] | undefined;
  } = {},
): string {
  if (error === "image-too-large" && details.maxImageBytes !== undefined) {
    return `Фото больше ${imageLimitText(details.maxImageBytes)}, аукцион его не принял.`;
  }
  // Исправленный ввод вместо образца (PER-709): человек видит свои же строки.
  if (error === "step-start" && details.suggestedTiers !== undefined) {
    return `${fromZeroReason} Пришли так:\n${tiersInput(details.suggestedTiers)}`;
  }
  return lotAskErrors[error];
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
        : `Пороги шага — строками «от цены — шаг». Цена считается от 0, а не от стартовой: первый порог всегда 0. Дальше цены растут, а шаг не уменьшается. Например:\n${tiersExample}\nДо 5 000 ₽ шаг 100 ₽, с 5 000 ₽ — 250 ₽.`;
    case "image":
      return question.chain === true
        ? "Пришли фото лота ответом на это сообщение — одно или альбомом. Их увидят участники на карточке лота, первое — обложка. Нет фото под рукой — «Пропустить», их можно добавить потом."
        : `Пришли фото лота ответом на это сообщение — одно или альбомом. Фото встанут в конец, у лота их бывает до ${lotPhotoLimit}.`;

    case "copies":
      return `Сколько всего нужно таких лотов вместе с этим? Целое число от ${minLotCopies} до ${maxLotCopies}. Копии получат то же описание, все фото, цену и шаг, все лоты назовутся «название | N из M» и соберутся в сет.`;
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
      return lot.photos.length === 0
        ? "нет"
        : `фото ${lot.photos.length} из ${lotPhotoLimit}, новое встанет в конец`;
    case "copies":
      return undefined;
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
    question.kind !== "copies" &&
    question.chain === true;
  const now = chained ? undefined : current(question, lot);
  const set =
    question.kind !== "new" &&
    question.kind !== "copies" &&
    question.set === true;
  return [
    ...(lead === undefined ? [] : [lead]),
    ...(question.kind === "step"
      ? [`Стартовая цена: ${rublesOf(question.priceRubles)}.`]
      : []),
    ...(now === undefined ? [] : [`Сейчас: ${now}`]),
    prompt(question),
    // Правка всех лотов сета (PER-716): вопрос говорит, куда уйдёт ответ.
    ...(set ? [setScopeNote(question, lot)] : []),
  ].join("\n");
}

/** Отказ копий лоту, который уже в сете, с именем сета (PER-716). */
export function lotInSetText(setName: string): string {
  return `Лот уже в сете «${setName}». Копии заводятся только у лота вне сета.`;
}

/** Текст кадра отказа; отказ по праву несёт общий текст хаба. */
export const lotRefusalText: Record<
  Exclude<LotRefusal, "not-administrator">,
  string
> = {
  "lots-frozen": "Торги уже начались. Добавить лот в этот аукцион нельзя.",
  "terms-closed": "Торги уже начались. Цену и шаг лота изменить нельзя.",
  "lot-sold": "Лот продан. Название, описание и фото больше не меняются.",
  "card-closed": "Лот закрыт. Название, описание и фото больше не меняются.",
  "lot-not-found": "Лот не найден или больше недоступен.",
  "auction-not-found": "Аукцион не найден. Открой сходку заново.",
  "lot-not-in-auction": "Лот сняли с аукциона. Цену и шаг ему задать нельзя.",
  "meetup-cancelled": "Сходку отменили. Лоты её аукциона больше не меняются.",
  "lot-in-set": "Лот уже в сете. Копии заводятся только у лота вне сета.",
  // Предел — десять сетов: его держит экран сетов (`lotSetLimit`).
  "set-limit":
    "Сетов в аукционе уже десять. Копии собираются в новый сет, а места для него нет.",
  "removal-frozen": "Торги уже начались. Удалить лот из аукциона нельзя.",
  "photo-limit": photoLimitText(lotPhotoLimit),
};

/** Строка вопроса правки всех лотов сета (PER-716). */
function setScopeNote(
  question: Exclude<LotQuestion, { kind: "new" | "copies" }>,
  lot: LotFormView | undefined,
): string {
  const size = lot?.registry?.set?.size;
  const all = size === undefined ? "все лоты сета" : `все лоты сета (${size})`;
  return question.kind === "text" && question.field === "title"
    ? `Новое название получат ${all}, номер «| N из M» бот допишет сам.`
    : question.kind === "price" || question.kind === "step"
      ? `Цену и шаг получат ${all}, где торги ещё не начались.`
      : question.kind === "image"
        ? `Фото встанет в конец у каждого лота сета${size === undefined ? "" : ` (${size})`}, где фото меньше ${lotPhotoLimit}.`
        : `Изменение получат ${all}.`;
}

// Поле в подписи выбора: что именно правится у одного лота или у всех.
const scopeFieldWord: Record<LotSetField, string> = {
  title: "Название",
  description: "Описание",
  image: "Фото",
  price: "Цену и шаг",
};

/**
 * Выбор «Только этот лот» или «Все лоты сета (M)» перед вопросом поля лота
 * сета (PER-716). Бинарная пара выбора — одним рядом; возврат — в форму.
 */
export function lotScopeScreen(
  lot: LotFormView,
  set: { name: string; size: number },
  field: LotSetField,
): ShownScreen {
  const token = uuidToToken(lot.lotId);
  return {
    id: "lot-scope",
    text: screenText(
      "Какие лоты изменить?",
      subjectLine(lot.title ?? untitled),
      escapeHtml(
        field === "image"
          ? `Лот входит в сет «${set.name}». Фото можно добавить только этому лоту или всем лотам сета сразу — в конец их фото.`
          : `Лот входит в сет «${set.name}». ${scopeFieldWord[field]} можно изменить только у этого лота или у всех лотов сета сразу.`,
      ),
    ),
    keyboard: withNav(
      new InlineKeyboard()
        .text("Только этот лот", lotAskData(token, field))
        .text(`Все лоты сета (${set.size})`, lotAskData(token, field, "set")),
      { name: "Изменить лот", data: lotFormData(token) },
    ),
    format: "HTML",
  };
}

// Сколько непрошедших лотов исход называет поимённо и как длинно.
const missedShown = 5;
const missedTitleLimit = 80;

const missWords: Record<LotSetMiss, string> = {
  sold: "лот продан",
  "card-closed": "лот закрыт",
  "terms-closed": "торги по лоту начались",
  "photo-limit": "у лота предел фото",
  "not-in-auction": "лота нет в аукционе",
  unavailable: "аукцион не ответил",
  refused: "аукцион отказал",
};

/**
 * Исход правки всех лотов сета (PER-716): до скольких лотов она дошла и, если
 * не до всех, какие остались и почему. «Повторить для оставшихся» разносит
 * значение заново: лоты, где оно уже такое, команды не получают.
 */
export function lotSetAppliedScreen(
  lot: LotFormView,
  outcome: {
    field: LotSetField;
    applied: number;
    total: number;
    missed: readonly { title: string; reason: LotSetMiss }[];
    photoPrint?: string;
  },
): ShownScreen {
  const token = uuidToToken(lot.lotId);
  const keyboard = new InlineKeyboard();
  if (outcome.missed.length > 0) {
    keyboard
      .text(
        "Повторить для оставшихся",
        lotSetRetryData(token, outcome.field, outcome.photoPrint),
      )
      .row();
  }
  keyboard.text("Изменить лот", lotFormData(token));
  // Список держит предел сообщения Telegram: до пяти лотов с укороченными
  // названиями, остальные — числом; «Повторить» дойдёт и до них.
  const named = outcome.missed
    .slice(0, missedShown)
    .map(
      (each) =>
        `«${truncate(each.title, missedTitleLimit)}» — ${missWords[each.reason]}`,
    )
    .join("; ");
  const rest = outcome.missed.length - missedShown;
  const missed = rest > 0 ? `${named}; и ещё ${rest}` : named;
  return {
    id: "outcome",
    text: outcomeText(
      outcome.missed.length === 0
        ? `Применено к ${outcome.applied} из ${outcome.total}.`
        : `Применено к ${outcome.applied} из ${outcome.total}. Не применено: ${missed}.`,
      lot.title,
    ),
    keyboard: withNav(keyboard, toLot(lot.lotId)),
    format: "HTML",
  };
}

/**
 * Исход копий (PER-716): сколько лотов в сете и как они названы. Возврат — в
 * ленту, где копии стоят за исходным лотом.
 */
export function lotCopiesScreen(
  lot: LotFormView,
  copies: { total: number; name: string },
): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(
      `Лоты скопированы. В сете ${copies.total} лотов: от «${numberedTitle(copies.name, 1, copies.total)}» до «${numberedTitle(copies.name, copies.total, copies.total)}». Описание, фото, цена и шаг у всех одни.`,
      copies.name,
    ),
    keyboard: withNav(
      new InlineKeyboard().text(
        "Изменить лот",
        lotFormData(uuidToToken(lot.lotId)),
      ),
      toLots(lot.auctionId),
    ),
    format: "HTML",
  };
}

/**
 * Подтверждение удаления лота (PER-716). Вернуть лот бот не умеет — его
 * заводят заново, — поэтому «Да» красное. «Нет» возвращает в форму.
 */
export function lotRemoveConfirmScreen(lot: LotFormView): ShownScreen {
  const token = uuidToToken(lot.lotId);
  return {
    id: "lot-remove-confirm",
    text: screenText(
      "Удалить лот?",
      subjectLine(lot.title ?? untitled),
      escapeHtml(
        lot.registry?.set === undefined
          ? "Лот уйдёт из ленты аукциона. Вернуть его нельзя, только завести заново."
          : `Лот уйдёт из ленты аукциона и из сета «${lot.registry.set.name}». Вернуть его нельзя, только завести заново.`,
      ),
    ),
    keyboard: confirmKeyboard({
      yes: "Да, удалить лот",
      yesData: lotRemoveConfirmData(token),
      noData: lotFormData(token),
      irreversible: true,
    }),
    format: "HTML",
  };
}

/** Исход удаления лота (PER-716) с возвратом в ленту аукциона. */
export function lotRemovedScreen(removed: {
  auctionId: string;
  title?: string;
  already?: true;
}): ShownScreen {
  return {
    id: "outcome",
    text: outcomeText(
      removed.already === true
        ? "Лот уже удалён. В ленте аукциона его нет."
        : "Лот удалён. В ленте аукциона его больше нет.",
      removed.title,
    ),
    keyboard: withNav(new InlineKeyboard(), toLots(removed.auctionId)),
    format: "HTML",
  };
}

/**
 * Отказ на фото сверх предела (PER-721). Число — из отказа Auction, как у
 * предела размера: предел держит он.
 */
export function photoLimitText(maxPhotos: number): string {
  return `У лота уже ${maxPhotos} фото — больше не бывает. Чтобы добавить новое, убери одно в «Фото лота».`;
}
