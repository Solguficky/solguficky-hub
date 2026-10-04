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
  /** Пары кнопок в одном ряду, которые дерево бота называет поимённо. */
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
const menuLabel = "Меню";
const backSign = "‹ ";
const confirmPrefix = "Да, ";
const callbackDataLimit = 64;
const defaultMaxRows = 12;

// Слова, которые дизайн-код заменил: возврат называет родителя, подтверждение —
// действие, состояние переключателя пишется словом.
const retiredLabels: ReadonlySet<string> = new Set([
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
  }

  switch (entry.nav) {
    case "root":
      if (buttons.some((button) => button.text.startsWith(backSign))) {
        found.push(["nav", "у корня дерева возврата нет"]);
      }
      break;
    case "tree": {
      const parents = backNamesOf(config, entry.parent);
      const [back, menu, ...rest] = labels(last);
      const toMenu = entry.parent === "menu";
      const backOk =
        back !== undefined &&
        parents.some((name) => back === `${backSign}${name}`);
      const tailOk = toMenu
        ? menu === undefined
        : menu === menuLabel && rest.length === 0;
      if (!backOk || !tailOk) {
        found.push([
          "nav",
          `последний ряд ${describeRow(last)}, а нужен [${backSign}${parents.join(" | ")}]${toMenu ? "" : ` [${menuLabel}]`}`,
        ]);
      }
      break;
    }
    case "confirm": {
      const [yes] = labels(rows.at(-2));
      const [no] = labels(last);
      const pairOk =
        rows.at(-2)?.length === 1 &&
        last?.length === 1 &&
        yes?.startsWith(confirmPrefix) === true &&
        no === "Нет";
      const leadOk = rows
        .slice(0, -2)
        .every((row) => row.every((button) => button.url !== undefined));
      if (!pairOk || !leadOk) {
        found.push([
          "nav",
          `подтверждение — ряды [${confirmPrefix}<глагол>] и [Нет], а пришло ${describeRows(rows)}`,
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
            label === menuLabel ||
            label.startsWith(backSign),
        )
      ) {
        found.push([
          "nav",
          `кадр отказа без выхода: последний ряд ${describeRow(last)}`,
        ]);
      }
      break;
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
    // материал с «Убрать».
    const pair = labels(row).join("|");
    const allowed =
      short ||
      index === rows.length - 1 ||
      entry.nav === "root" ||
      config.namedPairs?.has(pair) === true ||
      row.some((button) => button.text === "Убрать");
    if (row.length === 2 && !allowed) {
      found.push(["rows", `пара вне дизайн-кода: ${describeRow(row)}`]);
    }
  });

  for (const button of buttons) {
    if (
      button.style !== undefined &&
      (button.style !== "danger" || !button.text.startsWith(confirmPrefix))
    ) {
      found.push([
        "style",
        `цвет ${button.style} у «${button.text}»: красится только «${confirmPrefix}…» и только danger`,
      ]);
    }
    if (retiredLabels.has(button.text) || /^\[[x ]\] /.test(button.text)) {
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
  return found;
}

// Заголовок — первая жирная строка. Перед ним может стоять только заметка:
// ответ на вопрос приносит экран с заметкой в первой строке.
function titleProblem(
  call: Carried,
  title: string | undefined,
): string | undefined {
  if (typeof call.rich_message?.html === "string") {
    return call.rich_message.html.includes("<h1>")
      ? undefined
      : "rich-экран без заголовка <h1>";
  }
  // Правка фото несёт подпись внутри `media`, а не рядом с ним.
  const text =
    typeof call.text === "string"
      ? call.text
      : typeof call.caption === "string"
        ? call.caption
        : typeof call.media?.caption === "string"
          ? call.media.caption
          : undefined;
  if (text === undefined) return "экран без текста";
  const mode = call.parse_mode ?? call.media?.parse_mode;
  if (mode !== "HTML") return "экран без разметки: заголовок не выделен";
  const heading = text.split("\n").find((line) => line.startsWith("<b>"));
  if (heading === undefined) return "нет жирной строки заголовка";
  return title === undefined || heading.startsWith(`<b>${title}`)
    ? undefined
    : `заголовок «${heading}», а в каталоге «${title}»`;
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
