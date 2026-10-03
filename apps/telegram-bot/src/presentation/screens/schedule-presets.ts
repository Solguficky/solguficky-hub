import { InlineKeyboard } from "grammy";
import type { CommunityDay } from "../../community-time.js";
import { cancelLabel, nextRow, readableDay } from "./kit.js";

// Кнопки-заготовки вопроса о дате (дизайн-код, «Дата и время»): сначала день,
// затем время. Они стоят в клавиатуре самого вопроса над «Отменой», а ответ
// текстом остаётся запасным путём для даты, которой среди заготовок нет.

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

export const schedulePrompt =
  "Когда встречаемся? Выбери день или напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ";

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

/** Кому и в каком режиме задан вопрос: из этого собираются данные кнопок. */
export type ScheduleQuestion = {
  token: string;
  /** `c` — форма создания, `e` — правка; как у кнопки прошедшей даты. */
  mode: "c" | "e";
  /** Данные кнопки «Отмена»: шаг вопроса. */
  cancelData: string;
};

function whenData(question: ScheduleQuestion, digits?: string): string {
  const base = `v1:manage:when:${question.token}:${question.mode}`;
  return digits === undefined ? base : `${base}:${digits}`;
}

/** Первый шаг: ближайшие дни и выходные двух недель, которых среди них нет. */
export function dayPresetKeyboard(
  question: ScheduleQuestion,
  today: CommunityDay,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const near = Array.from({ length: nearDays }, (_, offset) =>
    addDays(today, offset),
  );
  for (const date of near) {
    keyboard.text(dayButtonLabel(date), whenData(question, dayDigits(date)));
  }
  const weekends = Array.from(
    { length: weekendHorizon - nearDays },
    (_, index) => addDays(today, nearDays + index),
  )
    .filter((date) => date.getUTCDay() === 6 || date.getUTCDay() === 0)
    .slice(0, weekendLimit);
  nextRow(keyboard);
  for (const date of weekends) {
    keyboard.text(dayButtonLabel(date), whenData(question, dayDigits(date)));
  }
  nextRow(keyboard).text(cancelLabel, question.cancelData);
  return keyboard;
}

/** Второй шаг: время выбранного дня и возврат к выбору дня. */
export function timePresetKeyboard(
  question: ScheduleQuestion,
  digits: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of timePresets) {
    nextRow(keyboard);
    for (const time of row) {
      keyboard.text(
        time,
        whenData(question, `${digits}${time.replace(":", "")}`),
      );
    }
  }
  nextRow(keyboard).text("Другой день", whenData(question));
  nextRow(keyboard).text(cancelLabel, question.cancelData);
  return keyboard;
}

export function timePresetText(day: CommunityDay, today: CommunityDay): string {
  return `${readableDay(day, today)} — во сколько? Выбери время или напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ`;
}
