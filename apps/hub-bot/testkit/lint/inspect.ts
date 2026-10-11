import {
  admitLabel,
  confirmNoLabel,
  confirmYesPrefix,
  marked,
  pictogram,
  pictogramWords,
} from "../../src/core/pictograms.js";
import type {
  Catalog,
  RuleName,
  ScreenEntry,
  WaivableRule,
} from "./catalog.js";

// Линтер экрана: сверяет вызов Bot API, который несёт клавиатуру, с каталогом
// бота и правилами дизайн-кода (docs/design/bot/design-code.md). Его зовёт
// записывающий трансформер харнесса бота, поэтому правило проверяется в каждом
// тесте, который вообще что-то отправил, а не в отдельном наборе.

export type ScreenViolation = {
  /** Запись каталога либо «—», если вызов её не назвал. */
  screen: string;
  method: string;
  rule: RuleName;
  detail: string;
};

/** Что у бота своё: метка вызова, каталог и частные правила его дерева. */
export type LintConfig = {
  /** Символ, под которым вызов несёт идентификатор записи каталога. */
  tag: symbol;
  catalog: Catalog;
  /**
   * Родители, которые означают несколько экранов: карточка сходки возвращает
   * в тот список, где сходка стоит. Возврат принимается к любому из них.
   */
  parentGroups?: Readonly<Record<string, readonly string[]>>;
  /**
   * Пары кнопок в одном ряду, которые дерево бота называет поимённо: подписи
   * через «|». Знак «#» стоит на месте числа в подписи — счётчика вроде
   * «Материалы (#)», — и пара принимается с любым числом.
   */
  namedPairs?: ReadonlySet<string>;
};

type Button = {
  text: string;
  callback_data?: string;
  url?: string;
  style?: string;
};

type Carried = {
  text?: unknown;
  caption?: unknown;
  parse_mode?: unknown;
  media?: { caption?: unknown; parse_mode?: unknown };
  rich_message?: { html?: unknown };
  reply_markup?: { force_reply?: unknown; inline_keyboard?: Button[][] };
};

const carryingMethods: ReadonlySet<string> = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendDocument",
  "sendPhoto",
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia",
  "editMessageReplyMarkup",
]);

// Словарь у обоих ботов один (дизайн-код, «Аукцион: тело, шлюз, оболочка»).
const backSign = "‹ ";
// Выход кадра исхода аукциона — к карточке лота, как у кнопки следа.
const toLotLabel = "К лоту";
const removeMaterialLabel = marked(pictogram.remove, "Убрать");
const linkSign = " ↗";
const callbackDataLimit = 64;
const defaultMaxRows = 12;

// Слова, которые дизайн-код заменил: возврат называет родителя, подтверждение —
// действие, состояние переключателя пишется словом. Кнопки «Меню» нет: корня
// «Меню» нет ни в одном боте, между разделами человек ходит командами
// (решение владельца 10 октября 2026 года).
const retiredLabels: ReadonlySet<string> = new Set([
  "Меню",
  "Назад",
  "К списку",
  "К сходке",
  "К управлению",
  "К материалам",
  "К лотам",
  "Да, продолжить",
]);

export function inspectCall(
  config: LintConfig,
  method: string,
  payload: unknown,
): ScreenViolation[] {
  if (!carryingMethods.has(method)) return [];
  // Запись трансформера — объект параметров вызова; поля, которых у метода
  // нет, просто отсутствуют.
  const call = payload as Carried;
  const rows = call.reply_markup?.inline_keyboard ?? [];
  const asks = call.reply_markup?.force_reply === true;
  const tag = (payload as Record<symbol, unknown>)[config.tag];
  const at = (screen: string, rule: RuleName, detail: string) => ({
    screen,
    method,
    rule,
    detail,
  });
  if (tag === undefined) {
    return rows.flat().length > 0 || asks
      ? [
          at(
            "—",
            "untagged",
            `клавиатура ушла мимо единого отправителя: ${describeRows(rows)}`,
          ),
        ]
      : [];
  }
  const entry = typeof tag === "string" ? config.catalog[tag] : undefined;
  if (typeof tag !== "string" || entry === undefined) {
    return [at(String(tag), "unknown-screen", "такой записи в каталоге нет")];
  }
  const found = checkRules(config, entry, method, call, rows, asks)
    .filter(([rule]) => !waived(entry, rule))
    .map(([rule, detail]) => at(tag, rule, detail));
  if (entry.legacy !== true) return found;
  return found.length === 0
    ? [
        at(
          tag,
          "legacy-outlived",
          "экран уже проходит правила: сними пометку legacy в каталоге",
        ),
      ]
    : [];
}

function waived(entry: ScreenEntry, rule: RuleName): boolean {
  return entry.waive?.[rule as WaivableRule] !== undefined;
}

function checkRules(
  config: LintConfig,
  entry: ScreenEntry,
  method: string,
  call: Carried,
  rows: readonly (readonly Button[])[],
  asks: boolean,
): [rule: RuleName, detail: string][] {
  const found: [RuleName, string][] = [];
  const buttons = rows.flat();
  const labels = (row: readonly Button[] | undefined) =>
    (row ?? []).map((button) => button.text);
  const last = rows.at(-1);

  if (entry.class === "screen" && method !== "editMessageReplyMarkup") {
    const title = titleProblem(call, entry.title);
    if (title !== undefined) found.push(["title", title]);
    const body = bodyProblem(call);
    if (body !== undefined) found.push(["body", body]);
  }

  switch (entry.nav) {
    case "root":
      if (buttons.some((button) => button.text.startsWith(backSign))) {
        found.push(["nav", "у корня дерева возврата нет"]);
      }
      break;
    case "tree": {
      // Ряд навигации — одна кнопка `[‹ Родитель]`: кнопки «Меню» нет
      // (решение владельца 10 октября 2026 года).
      const parents = backNamesOf(config, entry.parent);
      const [back, ...rest] = labels(last);
      const backOk =
        back !== undefined &&
        parents.some((name) => back === `${backSign}${name}`);
      if (!backOk || rest.length > 0) {
        found.push([
          "nav",
          `последний ряд ${describeRow(last)}, а нужен [${backSign}${parents.join(" | ")}]`,
        ]);
      }
      break;
    }
    case "confirm": {
      // Ответы подтверждения — один ряд `[✔️ Да, …] [✖️ Нет]` (решение
      // владельца 10 октября 2026 года); над ним — только ссылки источника.
      const [yes, no, ...rest] = labels(last);
      const pairOk =
        yes?.startsWith(confirmYesPrefix) === true &&
        no === confirmNoLabel &&
        rest.length === 0;
      const leadOk = rows
        .slice(0, -1)
        .every((row) => row.every((button) => button.url !== undefined));
      if (!pairOk || !leadOk) {
        found.push([
          "nav",
          `подтверждение — один ряд [${confirmYesPrefix}<глагол>] [${confirmNoLabel}], а пришло ${describeRows(rows)}`,
        ]);
      }
      break;
    }
    case "question": {
      // Режим ответа ставит отправка. Правка вопроса на месте — смена
      // заготовок дня на время — его не несёт и не снимает.
      const mode = asks || !method.startsWith("send");
      if (!mode || labels(last).join("|") !== "Отмена") {
        found.push([
          "nav",
          `вопрос несёт режим ответа и [Отмена], а пришло ${describeRows(rows)}${mode ? "" : " без force_reply"}`,
        ]);
      }
      break;
    }
    case "choice":
      // Выбор кнопками режима ответа не несёт: иначе после нажатия он остался
      // бы висеть в клиенте (зонд PER-443).
      if (asks || labels(last).join("|") !== "Отмена") {
        found.push([
          "nav",
          `выбор кнопками кончается рядом [Отмена] и не несёт force_reply, а пришло ${describeRows(rows)}${asks ? " с force_reply" : ""}`,
        ]);
      }
      break;
    case "exit":
      if (
        !labels(last).some(
          (label) =>
            label === "Повторить" ||
            label === toLotLabel ||
            label.startsWith(backSign),
        )
      ) {
        found.push([
          "nav",
          `кадр отказа без выхода: последний ряд ${describeRow(last)}`,
        ]);
      }
      break;
    case "links": {
      // Кадр без доступа, которому есть куда уйти вне бота: ссылка не ведёт
      // по дереву, поэтому возврат здесь нарушение, как у `none`.
      // Пустая клавиатура — тоже нарушение: кадр без выхода — это `none`, и
      // потерянная ссылка иначе прошла бы молча.
      const stray = buttons.filter(
        (button) => button.url === undefined || !button.text.endsWith(linkSign),
      );
      if (buttons.length === 0 || stray.length > 0) {
        found.push([
          "nav",
          `здесь хотя бы одна кнопка и только ссылки со знаком «↗», а пришло ${describeRows(rows)}`,
        ]);
      }
      break;
    }
    case "none":
      if (buttons.length > 0) {
        found.push(["nav", `клавиатуры быть не должно: ${describeRows(rows)}`]);
      }
      break;
    case "free":
      break;
    default: {
      const _exhaustive: never = entry.nav;
      return _exhaustive;
    }
  }

  const maxRows = entry.maxRows ?? defaultMaxRows;
  if (rows.length > maxRows) {
    found.push(["rows", `рядов ${rows.length}, потолок ${maxRows}`]);
  }
  rows.forEach((row, index) => {
    // Шире двух — только ряд коротких заготовок вроде времени или листания.
    const short = row.every((button) => button.text.length <= 6);
    if (row.length > (short ? 4 : 2)) {
      found.push(["rows", `в ряду ${row.length} кнопок: ${describeRow(row)}`]);
      return;
    }
    // Две в ряду — только у пар, которые дизайн-код называет поимённо: ряд
    // навигации, разделы меню, листание и заготовки, пары дерева бота,
    // материал с «🗑 Убрать».
    const pair = labels(row).join("|");
    const allowed =
      short ||
      index === rows.length - 1 ||
      entry.nav === "root" ||
      config.namedPairs?.has(pair) === true ||
      config.namedPairs?.has(pair.replace(/\d+/g, "#")) === true ||
      row.some((button) => button.text === removeMaterialLabel);
    if (row.length === 2 && !allowed) {
      found.push(["rows", `пара вне дизайн-кода: ${describeRow(row)}`]);
    }
    // Бинарная пара выбора стоит одним рядом (решение владельца 10 октября
    // 2026 года): допуск — рядом с отказом или закрытием, а не над ним.
    if (row.some((button) => button.text === admitLabel) && row.length !== 2) {
      found.push([
        "rows",
        `«${admitLabel}» стоит одним рядом со своей парой: ${describeRow(row)}`,
      ]);
    }
  });

  // Цвет — по каталогу: красный только у «Да, …» подтверждения, после
  // которого обратного действия нет или тратятся деньги, и там он обязателен
  // (решение владельца 10 октября 2026 года). Других цветов нет.
  const final = entry.irreversible === true && entry.nav === "confirm";
  const yes = buttons.find((button) =>
    button.text.startsWith(confirmYesPrefix),
  );
  if (final && yes !== undefined && yes.style !== "danger") {
    found.push([
      "style",
      `«${yes.text}» подтверждает необратимое действие, а цвета danger у него нет`,
    ]);
  }
  for (const button of buttons) {
    const red = final && button === yes && button.style === "danger";
    if (button.style !== undefined && !red) {
      found.push([
        "style",
        `цвет ${button.style} у «${button.text}»: красится только «${confirmYesPrefix}…» необратимого подтверждения (danger)`,
      ]);
    }
    const sign = strayPictogram(button.text);
    if (sign !== undefined) {
      found.push(["emoji", `подпись «${button.text}»: ${sign}`]);
    }
    // Знак словаря в подписи слово не меняет: «✔️ Да, продолжить» тоже вне
    // словаря.
    const word = button.text.replace(/^\p{Extended_Pictographic}️?\s/u, "");
    if (retiredLabels.has(word) || /^\[[x ]\] /.test(button.text)) {
      found.push(["vocabulary", `подпись «${button.text}» вне словаря`]);
    }
    if (button.text === "Обновить" && entry.refresh !== true) {
      found.push([
        "vocabulary",
        "«Обновить» — только у экрана, чьи данные меняются без человека",
      ]);
    }
    if (
      button.text === "Отмена" &&
      entry.nav !== "question" &&
      entry.nav !== "choice"
    ) {
      found.push([
        "vocabulary",
        "«Отмена» — выход из вопроса или выбора даты, а не с экрана",
      ]);
    }
    if (button.text === "Открыть сходку" && entry.class !== "trace") {
      found.push([
        "vocabulary",
        "«Открыть сходку» — кнопка следа; экран возвращает «‹ Сходка»",
      ]);
    }
    if (
      button.callback_data !== undefined &&
      Buffer.byteLength(button.callback_data, "utf8") > callbackDataLimit
    ) {
      found.push([
        "callback-data",
        `данные «${button.text}» длиннее ${callbackDataLimit} байт`,
      ]);
    }
  }
  for (const line of textLines(call)) {
    const sign = strayPictogram(line);
    if (sign !== undefined) found.push(["emoji", `строка «${line}»: ${sign}`]);
  }
  for (const text of [
    ...buttons.map((button) => button.text),
    ...textLines(call),
  ]) {
    const word = forbiddenWord.exec(text)?.[0];
    if (word !== undefined) {
      found.push([
        "forbidden-word",
        `«${word}» в «${text}»: язык аукциона — «розыгрыш среди участников»`,
      ]);
    }
  }
  return found;
}

// Слова, которые превращают розыгрыш среди участников в азартную механику
// (RFC-007, инвариант 8; ADR-066): ни один экран обоих ботов их не несёт.
// Основа слова ловит и его формы: «шансы», «крутки», «донаты». Правило не
// снимается исключением: инвариант обязателен всегда. Линтер видит тексты
// шаблонов с данными тестов, поэтому название лота организатора его не
// задевает.
const forbiddenWord = /(?<!\p{L})(?:гач|крутк|шанс|донат)\p{L}*/iu;

// Знак в начале подписи или строки — «<эмодзи> <слово>» — слово бота, и
// эмодзи в нём только из закрытого словаря и только перед своим словом
// (дизайн-код, «Формат»; решение владельца 10 октября 2026 года). Текст
// организатора словарём не ограничен; линтер его не отличает и потому
// проверяет только знак, за которым идёт пробел, — так эмодзи ставит бот.
// Служебные знаки «‹», «↗», «←», «→», «·», «•» эмодзи не считаются.
const leadingSign = /^(\p{Extended_Pictographic}\uFE0F?)\s(.*)$/u;
const serviceSigns: ReadonlySet<string> = new Set([
  "‹",
  "↗",
  "←",
  "→",
  "·",
  "•",
]);
const signWords: Readonly<Record<string, readonly string[]>> = pictogramWords;

function strayPictogram(text: string): string | undefined {
  const match = leadingSign.exec(text);
  if (match === null) return undefined;
  const [, sign = "", rest = ""] = match;
  if (serviceSigns.has(sign)) return undefined;
  const words = signWords[sign];
  if (words === undefined) return `эмодзи «${sign}» вне словаря`;
  return words.some((word) => rest.startsWith(word))
    ? undefined
    : `«${sign}» стоит только перед ${words.map((word) => `«${word.trim()}»`).join(", ")}`;
}

// Строки текста вызова: обычный текст делится переносом, rich-карточка — ещё
// и блоками; разметка в начале строки снимается.
function textLines(call: Carried): string[] {
  const html =
    typeof call.rich_message?.html === "string"
      ? call.rich_message.html
      : textOf(call);
  if (html === undefined) return [];
  return html
    .split(/\n|<br\s*\/?>|<\/?(?:p|h1|li|ul|ol|blockquote)>/)
    .map((line) => line.replace(/^(?:<[^>]+>)+/, "").trim())
    .filter((line) => line !== "");
}

// Заголовок — первая жирная строка. Что над ним, проверяет правило тела.
function titleProblem(
  call: Carried,
  title: string | undefined,
): string | undefined {
  if (typeof call.rich_message?.html === "string") {
    return call.rich_message.html.includes("<h1>")
      ? undefined
      : "rich-экран без заголовка <h1>";
  }
  const text = textOf(call);
  if (text === undefined) return "экран без текста";
  const mode = call.parse_mode ?? call.media?.parse_mode;
  if (mode !== "HTML") return "экран без разметки: заголовок не выделен";
  const heading = text.split("\n").find((line) => line.startsWith("<b>"));
  if (heading === undefined) return "нет жирной строки заголовка";
  return title === undefined || heading.startsWith(`<b>${title}`)
    ? undefined
    : `заголовок «${heading}», а в каталоге «${title}»`;
}

// Текст вызова: правка фото несёт подпись внутри `media`, а не рядом с ним.
function textOf(call: Carried): string | undefined {
  return typeof call.text === "string"
    ? call.text
    : typeof call.caption === "string"
      ? call.caption
      : typeof call.media?.caption === "string"
        ? call.media.caption
        : undefined;
}

// Фото карточки над заголовком rich-экрана: одно фото или карусель фото.
const leadingPhotoBlock =
  /^(?:<img src="tg:\/\/photo\?id=[^"]*"\/>|<tg-slideshow>(?:<img src="tg:\/\/photo\?id=[^"]*"\/>)+<\/tg-slideshow>)/;

// Тело экрана (дизайн-код, «Формат»): заголовок первой строкой, после него
// пустая строка. Над заголовком ничего нет, кроме фото карточки: исход
// действия — свой экран, а не заметка над карточкой (PER-472). Кадр отказа держит жирное предложение и
// остальной текст в одной строке, и правило его не задевает. Чем заполнено тело, линтер не читает: это
// держат тесты каталога бота.
function bodyProblem(call: Carried): string | undefined {
  if (typeof call.rich_message?.html === "string") {
    const html = call.rich_message.html;
    const at = html.indexOf("<h1>");
    if (at < 0) return undefined;
    // После заголовка — блок, а не голый текст: он слился бы с заголовком.
    const after = html.slice(html.indexOf("</h1>", at) + "</h1>".length);
    if (after !== "" && !after.startsWith("<")) {
      return `после заголовка rich-экрана текст вне блока: «${after.slice(0, 20)}»`;
    }
    // Единственное, что стоит над заголовком, — фото карточки: одно `<img>`
    // или карусель (решение владельца 10 октября 2026 года).
    const above = html.slice(0, at).replace(leadingPhotoBlock, "");
    return above === ""
      ? undefined
      : `над заголовком rich-экрана текст: «${above.slice(0, 40)}»`;
  }
  const lines = textOf(call)?.split("\n");
  if (lines === undefined) return undefined;
  const at = lines.findIndex((line) => line.startsWith("<b>"));
  if (at < 0) return undefined;
  if (at > 0) {
    return `над заголовком текст: «${lines.slice(0, at).join(" ").slice(0, 40)}»`;
  }
  // Текст в строке заголовка — только у кадра отказа: там жирное первое
  // предложение, и оно кончается знаком конца предложения.
  const heading = lines[at] ?? "";
  const tail = heading.slice(heading.indexOf("</b>") + "</b>".length);
  if (tail !== "" && !/[.?!]<\/b>/.test(heading)) {
    return `текст в строке заголовка: «${heading}»`;
  }
  const next = lines[at + 1];
  return next === undefined || next === ""
    ? undefined
    : `после заголовка нет пустой строки: «${next}»`;
}

function backNamesOf(
  config: LintConfig,
  parent: string | undefined,
): readonly string[] {
  const group =
    parent === undefined ? undefined : config.parentGroups?.[parent];
  const parents = group ?? [parent];
  return parents.flatMap((id) => {
    const name = id === undefined ? undefined : config.catalog[id]?.backName;
    return name === undefined ? [] : [name];
  });
}

function describeRow(row: readonly Button[] | undefined): string {
  return row === undefined
    ? "(пусто)"
    : row.map((button) => `[${button.text}]`).join(" ");
}

function describeRows(rows: readonly (readonly Button[])[]): string {
  return rows.length === 0 ? "(пусто)" : rows.map(describeRow).join(" / ");
}

// Найденное копится между вызовами и снимается хуком набора либо пультом:
// трансформер не вправе бросать — отказ внутри вызова Bot API бот принял бы за
// отказ Telegram и ушёл бы в запасной путь, спрятав причину.
const found: ScreenViolation[] = [];

export function reportViolations(violations: readonly ScreenViolation[]): void {
  found.push(...violations);
}

export function takeViolations(): ScreenViolation[] {
  return found.splice(0, found.length);
}
