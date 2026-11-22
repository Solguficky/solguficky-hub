import { truncate } from "../../../core/format.js";
import { unescapeHtml } from "./description-markup.js";
import { escapeHtml } from "./screens/kit.js";

// Вопросы точечной правки полей сходки (PER-911). Мастер создания не меняется:
// его строки живут в `formPrompts` оболочки, а здесь — только правка непустого
// и пустого поля. Дата и время правятся экраном заготовок и сюда не входят.

export type EditableMeetupField = "title" | "venue" | "description";

const filledPrompts: Record<EditableMeetupField, string> = {
  title: "Новое название сходки?",
  venue: "Новое место встречи?",
  description: "Новое описание сходки?",
};

const emptyPrompts: Record<EditableMeetupField, string> = {
  title: "Добавь название сходки?",
  venue: "Добавь место встречи?",
  description: "Добавь короткое описание сходки.",
};

// Клиент Telegram копирует содержимое `<code>` и `<pre>` одним нажатием; этот
// же приём уже несёт черновик объявления (auction-announcement.ts) и список
// билетов (auction-raffle-winner.ts).
const copyHint = "нажми, чтобы скопировать:";

// Bot API принимает текст сообщения до 4096 знаков после разбора разметки
// (entry-screen.ts). Считаем по итоговой HTML-строке — это запас и под сущности,
// которые Telegram разберёт, и под клавиатуру вопроса.
const questionMessageLimit = 4096;

export type MeetupFieldQuestion = {
  text: string;
  // Только непустое поле: подсказка держит показанный исходник, чтобы ответ
  // «как есть» прошёл без экранирования. Для описания это канонический
  // HTML Telegram из `plainDescription`.
  source?: string;
  format?: "HTML";
};

/**
 * Текст вопроса правки поля. Пустое поле получает только «Добавь …», без блока
 * значения; непустое — копируемый блок `<code>` для названия и места и `<pre>`
 * для описания. `source` — неэкранированный исходник, показанный человеку.
 */
export function meetupFieldEditQuestion(
  field: EditableMeetupField,
  value: string,
  source: string,
): MeetupFieldQuestion {
  if (value === "") return { text: emptyPrompts[field] };
  const tag = field === "description" ? "pre" : "code";
  const prefix = `${escapeHtml(filledPrompts[field])}\n${escapeHtml(copyHint)}\n<${tag}>`;
  const suffix = `</${tag}>`;
  const budget = questionMessageLimit - prefix.length - suffix.length;
  const shown = truncate(escapeHtml(source), budget);
  return {
    text: `${prefix}${shown}${suffix}`,
    // Исходник совпадает с тем, что человек увидит и скопирует, включая
    // обрезку: иначе вставка усечённого блока не примется как «без правок».
    source: unescapeHtml(shown),
    format: "HTML",
  };
}
