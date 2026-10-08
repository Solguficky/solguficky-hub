import { InlineKeyboard } from "grammy";
import type { CommunityDay } from "../../community-time.js";
import type { WhenMode } from "../parse-callback.js";
import {
  cancelLabel,
  escapeHtml,
  heading,
  nextRow,
  readableDay,
} from "./kit.js";
import type { ShownScreen } from "./show.js";

// Выбор даты кнопками (дизайн-код, «Дата и время»): сначала день, затем время.
// Это обычный экран без режима ответа: он правится на месте, а выбор кнопкой
// режим ответа за собой не оставляет. Дату, которой среди заготовок нет,
// человек пишет текстом — кнопка «Другая дата» задаёт для этого вопрос.

const weekdayFormat = new Intl.DateTimeFormat("ru-RU", {
  weekday: "short",
  timeZone: "UTC",
});

const nearDays = 4;
const weekendHorizon = 14;
const weekendLimit = 4;

const timePresets = [
  ["12:00", "15:00", "17:00", "18:00"],
  ["19:00", "19:30", "20:00", "21:00"],
] as const;

export const otherDateLabel = "Другая дата";
const otherDayLabel = "Другой день";

/** Вопрос о дате сходки текстом: его задаёт «Другая дата». */
export const scheduleTypePrompt =
  "Когда встречаемся? Напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ";

function addDays(day: CommunityDay, offset: number): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day + offset));
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

/** День цифрами `ДДММГГГГ` — в таком виде он едет в кнопке. */
function dayDigits(date: Date): string {
  return `${pad(date.getUTCDate())}${pad(date.getUTCMonth() + 1)}${date.getUTCFullYear()}`;
}

// «сб 3»: день недели и число. Месяц не нужен — заготовки не уходят дальше
// двух недель, — а короткая подпись позволяет ставить четыре кнопки в ряд.
function dayButtonLabel(date: Date): string {
  return `${weekdayFormat.format(date)} ${date.getUTCDate()}`;
}

/** Чью дату выбирают: из этого собираются данные кнопок. */
export type DatePicker = {
  token: string;
  /**
   * `c` — дата сходки в форме создания, `e` — в правке, `p` — момент
   * отложенной публикации из «Статуса», `d` — он же с черновика.
   */
  mode: WhenMode;
};

// Хвост данных: цифры дня или момента, `t` — «Другая дата», `x` — «Отмена».
function whenData(picker: DatePicker, tail?: string): string {
  const base = `v1:manage:when:${picker.token}:${picker.mode}`;
  return tail === undefined ? base : `${base}:${tail}`;
}

// «Отмена» здесь — возврат на экран, с которого дату открыли: режима ответа у
// выбора кнопками нет, и снимать нечего.
function withExit(
  keyboard: InlineKeyboard,
  picker: DatePicker,
): InlineKeyboard {
  nextRow(keyboard).text(otherDateLabel, whenData(picker, "t"));
  nextRow(keyboard).text(cancelLabel, whenData(picker, "x"));
  return keyboard;
}

/** Первый шаг: ближайшие дни и выходные двух недель, которых среди них нет. */
export function dayPresetKeyboard(
  picker: DatePicker,
  today: CommunityDay,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const near = Array.from({ length: nearDays }, (_, offset) =>
    addDays(today, offset),
  );
  for (const date of near) {
    keyboard.text(dayButtonLabel(date), whenData(picker, dayDigits(date)));
  }
  const weekends = Array.from(
    { length: weekendHorizon - nearDays },
    (_, index) => addDays(today, nearDays + index),
  )
    .filter((date) => date.getUTCDay() === 6 || date.getUTCDay() === 0)
    .slice(0, weekendLimit);
  nextRow(keyboard);
  for (const date of weekends) {
    keyboard.text(dayButtonLabel(date), whenData(picker, dayDigits(date)));
  }
  return withExit(keyboard, picker);
}

/** Второй шаг: время выбранного дня и возврат к выбору дня. */
export function timePresetKeyboard(
  picker: DatePicker,
  digits: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of timePresets) {
    nextRow(keyboard);
    for (const time of row) {
      keyboard.text(
        time,
        whenData(picker, `${digits}${time.replace(":", "")}`),
      );
    }
  }
  nextRow(keyboard).text(otherDayLabel, whenData(picker));
  return withExit(keyboard, picker);
}

/**
 * Экран выбора даты. `picked` — выбранный день: с ним экран спрашивает время.
 * `lead` — что стоит над вопросом: текущее значение или причина, по которой
 * прошлый выбор не принят; это текст, а не разметка.
 */
export function datePresetsScreen(view: {
  picker: DatePicker;
  today: CommunityDay;
  picked?: { digits: string; day: CommunityDay } | undefined;
  lead?: string | undefined;
}): ShownScreen {
  const { picker, today, picked, lead } = view;
  const publication = picker.mode === "p" || picker.mode === "d";
  const ask =
    picked !== undefined
      ? `${readableDay(picked.day, today)} — во сколько?`
      : publication
        ? "Когда опубликовать сходку? Выбери день. Время — по времени сообщества."
        : "Когда встречаемся? Выбери день.";
  return {
    id: "date-presets",
    text: [
      heading(publication ? "Публикация" : "Дата и время"),
      ...(lead === undefined || lead === "" ? [] : [escapeHtml(lead)]),
      ask,
    ].join("\n\n"),
    keyboard:
      picked === undefined
        ? dayPresetKeyboard(picker, today)
        : timePresetKeyboard(picker, picked.digits),
    format: "HTML",
  };
}
