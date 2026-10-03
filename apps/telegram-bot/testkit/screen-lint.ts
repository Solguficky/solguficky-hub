import {
  meetupListParent,
  meetupLists,
  type ScreenEntry,
  screenCatalog,
} from "../src/presentation/screens/catalog.js";
import { screenTag } from "../src/presentation/screens/show.js";

// Линтер экрана: сверяет каждый вызов Bot API, который несёт клавиатуру, с
// каталогом и правилами дизайн-кода (docs/design/bot/design-code.md). Его зовёт
// записывающий трансформер харнесса, поэтому правило проверяется в каждом тесте
// L0 и L2, который вообще что-то отправил, а не в отдельном наборе.

export type ScreenViolation = {
  /** Запись каталога либо «—», если вызов её не назвал. */
  screen: string;
  method: string;
  rule: string;
  detail: string;
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
  rich_message?: { html?: unknown };
  reply_markup?: { force_reply?: unknown; inline_keyboard?: Button[][] };
  [screenTag]?: unknown;
};

const carryingMethods: ReadonlySet<string> = new Set([
  "sendMessage",
  "sendRichMessage",
  "sendDocument",
  "sendPhoto",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
]);

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
  "Да, продолжить",
]);

// Пары, названные поимённо. «Отписаться» рядом с «Уведомлениями сходки» —
// пара, которой в дизайн-коде нет: подписка живёт в карточке по решению
// PER-402, и отдельным рядом она вывела бы карточку за пять рядов.
const namedPairs: ReadonlySet<string> = new Set([
  "Изменить|Статус",
  "Отписаться|Уведомления сходки",
]);

type Catalog = Readonly<Record<string, ScreenEntry>>;

/** Каталог передаётся только в тестах самого линтера; в работе он один. */
export function inspectCall(
  method: string,
  payload: unknown,
  catalog: Catalog = screenCatalog,
): ScreenViolation[] {
  if (!carryingMethods.has(method)) return [];
  // Запись трансформера — объект параметров вызова; поля, которых у метода
  // нет, просто отсутствуют.
  const call = payload as Carried;
  const rows = call.reply_markup?.inline_keyboard ?? [];
  const asks = call.reply_markup?.force_reply === true;
  const tag = call[screenTag];
  const at = (screen: string, rule: string, detail: string) => ({
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
  const entry = typeof tag === "string" ? catalog[tag] : undefined;
  if (typeof tag !== "string" || entry === undefined) {
    return [at(String(tag), "unknown-screen", "такой записи в каталоге нет")];
  }
  const found = checkRules(entry, catalog, method, call, rows, asks).map(
    ([rule, detail]) => at(tag, rule, detail),
  );
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

function checkRules(
  entry: ScreenEntry,
  catalog: Catalog,
  method: string,
  call: Carried,
  rows: readonly (readonly Button[])[],
  asks: boolean,
): [rule: string, detail: string][] {
  const found: [string, string][] = [];
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
      const parents = backNamesOf(entry.parent, catalog);
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
    // навигации, разделы меню, листание и заготовки, «Изменить» со «Статусом»,
    // материал с «Убрать».
    const pair = labels(row).join("|");
    const allowed =
      short ||
      index === rows.length - 1 ||
      entry.nav === "root" ||
      namedPairs.has(pair) ||
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
      found.push(["vocabulary", "«Обновить» есть только у состава сообщества"]);
    }
    if (button.text === "Отмена" && entry.nav !== "question") {
      found.push(["vocabulary", "«Отмена» — выход из вопроса, а не с экрана"]);
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
  const text =
    typeof call.text === "string"
      ? call.text
      : typeof call.caption === "string"
        ? call.caption
        : undefined;
  if (text === undefined) return "экран без текста";
  if (call.parse_mode !== "HTML")
    return "экран без разметки: заголовок не выделен";
  const heading = text.split("\n").find((line) => line.startsWith("<b>"));
  if (heading === undefined) return "нет жирной строки заголовка";
  return title === undefined || heading.startsWith(`<b>${title}`)
    ? undefined
    : `заголовок «${heading}», а в каталоге «${title}»`;
}

function backNamesOf(
  parent: string | undefined,
  catalog: Catalog,
): readonly string[] {
  const parents = parent === meetupListParent ? meetupLists : [parent];
  return parents.flatMap((id) => {
    const name = id === undefined ? undefined : catalog[id]?.backName;
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
