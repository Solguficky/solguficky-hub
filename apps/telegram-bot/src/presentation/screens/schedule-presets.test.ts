import type { InlineKeyboard } from "grammy";
import { describe, expect, it } from "vitest";
import {
  dayPresetKeyboard,
  type ScheduleQuestion,
  timePresetKeyboard,
  timePresetText,
} from "./schedule-presets.js";

// L0: заготовки вопроса о дате как данные. День закреплён: подписи и состав
// рядов зависят от дня недели, с которого начинается счёт.

const token = "AZLzpLXGfY6fChssPU5fYA";
const question: ScheduleQuestion = {
  token,
  mode: "c",
  cancelData: `v1:q:fc:${token}:schedule`,
};

function rows(keyboard: InlineKeyboard): string[][] {
  return keyboard.inline_keyboard.map((row) =>
    row.map((button) => button.text),
  );
}

function data(keyboard: InlineKeyboard): string[] {
  return keyboard.inline_keyboard
    .flat()
    .map((button) => ("callback_data" in button ? button.callback_data : ""));
}

describe("day presets", () => {
  it("offers the next four days and the weekends beyond them", () => {
    // 1 октября 2026 — четверг.
    const keyboard = dayPresetKeyboard(question, {
      year: 2026,
      month: 10,
      day: 1,
    });

    expect(rows(keyboard)).toEqual([
      ["чт 1", "пт 2", "сб 3", "вс 4"],
      ["сб 10", "вс 11"],
      ["Отмена"],
    ]);
    expect(data(keyboard)).toEqual([
      `v1:manage:when:${token}:c:01102026`,
      `v1:manage:when:${token}:c:02102026`,
      `v1:manage:when:${token}:c:03102026`,
      `v1:manage:when:${token}:c:04102026`,
      `v1:manage:when:${token}:c:10102026`,
      `v1:manage:when:${token}:c:11102026`,
      `v1:q:fc:${token}:schedule`,
    ]);
  });

  it("crosses the month and the year without losing a day", () => {
    // 30 декабря 2026 — среда.
    const keyboard = dayPresetKeyboard(question, {
      year: 2026,
      month: 12,
      day: 30,
    });

    expect(rows(keyboard)).toEqual([
      ["ср 30", "чт 31", "пт 1", "сб 2"],
      ["вс 3", "сб 9", "вс 10"],
      ["Отмена"],
    ]);
    expect(data(keyboard)[2]).toBe(`v1:manage:when:${token}:c:01012027`);
  });

  it("keeps every label short enough for four buttons in a row", () => {
    const keyboard = dayPresetKeyboard(question, {
      year: 2026,
      month: 10,
      day: 22,
    });

    for (const label of rows(keyboard).slice(0, -1).flat()) {
      expect(label.length).toBeLessThanOrEqual(6);
    }
    for (const value of data(keyboard)) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    }
  });
});

describe("time presets", () => {
  it("carries the whole moment in every button and a way back to the days", () => {
    const keyboard = timePresetKeyboard(
      { ...question, mode: "e", cancelData: `v1:q:fe:${token}:schedule` },
      "03102026",
    );

    expect(rows(keyboard)).toEqual([
      ["12:00", "15:00", "17:00", "18:00"],
      ["19:00", "19:30", "20:00", "21:00"],
      ["Другой день"],
      ["Отмена"],
    ]);
    expect(data(keyboard)).toEqual([
      `v1:manage:when:${token}:e:031020261200`,
      `v1:manage:when:${token}:e:031020261500`,
      `v1:manage:when:${token}:e:031020261700`,
      `v1:manage:when:${token}:e:031020261800`,
      `v1:manage:when:${token}:e:031020261900`,
      `v1:manage:when:${token}:e:031020261930`,
      `v1:manage:when:${token}:e:031020262000`,
      `v1:manage:when:${token}:e:031020262100`,
      `v1:manage:when:${token}:e`,
      `v1:q:fe:${token}:schedule`,
    ]);
    for (const value of data(keyboard)) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
    }
  });

  it("names the chosen day in words", () => {
    expect(
      timePresetText(
        { year: 2026, month: 10, day: 3 },
        { year: 2026, month: 10, day: 1 },
      ),
    ).toBe(
      "3 октября, сб — во сколько? Выбери время или напиши дату и время: ДД.ММ.ГГГГ ЧЧ:ММ",
    );
  });
});
