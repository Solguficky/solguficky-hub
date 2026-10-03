import type { InlineKeyboard } from "grammy";
import { describe, expect, it } from "vitest";
import { parseCallback } from "../parse-callback.js";
import {
  type DatePicker,
  datePresetsScreen,
  dayPresetKeyboard,
  timePresetKeyboard,
} from "./schedule-presets.js";

// L0: экран выбора даты как данные. День закреплён: подписи и состав рядов
// зависят от дня недели, с которого начинается счёт.

const token = "AZLzpLXGfY6fChssPU5fYA";
const picker: DatePicker = { token, mode: "c" };

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
  it("offers the next four days, the weekends beyond them, another date and a way out", () => {
    // 1 октября 2026 — четверг.
    const keyboard = dayPresetKeyboard(picker, {
      year: 2026,
      month: 10,
      day: 1,
    });

    expect(rows(keyboard)).toEqual([
      ["чт 1", "пт 2", "сб 3", "вс 4"],
      ["сб 10", "вс 11"],
      ["Другая дата"],
      ["Отмена"],
    ]);
    expect(data(keyboard)).toEqual([
      `v1:manage:when:${token}:c:01102026`,
      `v1:manage:when:${token}:c:02102026`,
      `v1:manage:when:${token}:c:03102026`,
      `v1:manage:when:${token}:c:04102026`,
      `v1:manage:when:${token}:c:10102026`,
      `v1:manage:when:${token}:c:11102026`,
      `v1:manage:when:${token}:c:t`,
      `v1:manage:when:${token}:c:x`,
    ]);
  });

  it("crosses the month and the year without losing a day", () => {
    // 30 декабря 2026 — среда.
    const keyboard = dayPresetKeyboard(picker, {
      year: 2026,
      month: 12,
      day: 30,
    });

    expect(rows(keyboard).slice(0, 2)).toEqual([
      ["ср 30", "чт 31", "пт 1", "сб 2"],
      ["вс 3", "сб 9", "вс 10"],
    ]);
    expect(data(keyboard)[2]).toBe(`v1:manage:when:${token}:c:01012027`);
  });

  it("keeps every day label short enough for four buttons in a row", () => {
    const keyboard = dayPresetKeyboard(picker, {
      year: 2026,
      month: 10,
      day: 22,
    });

    for (const label of rows(keyboard).slice(0, 2).flat()) {
      expect(label.length).toBeLessThanOrEqual(6);
    }
  });
});

describe("time presets", () => {
  it("carries the whole moment in every button, a way back to the days and the exits", () => {
    const keyboard = timePresetKeyboard({ token, mode: "e" }, "03102026");

    expect(rows(keyboard)).toEqual([
      ["12:00", "15:00", "17:00", "18:00"],
      ["19:00", "19:30", "20:00", "21:00"],
      ["Другой день"],
      ["Другая дата"],
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
      `v1:manage:when:${token}:e:t`,
      `v1:manage:when:${token}:e:x`,
    ]);
  });

  it("fits every button of every mode into the callback budget and parses it back", () => {
    for (const mode of ["c", "e", "p", "d"] as const) {
      const buttons = [
        ...data(
          dayPresetKeyboard({ token, mode }, { year: 2026, month: 10, day: 1 }),
        ),
        ...data(timePresetKeyboard({ token, mode }, "03102026")),
      ];
      for (const value of buttons) {
        expect(Buffer.byteLength(value)).toBeLessThanOrEqual(64);
        expect(parseCallback(value).kind).not.toBe("malformed");
      }
    }
  });
});

describe("date presets screen", () => {
  const today = { year: 2026, month: 10, day: 1 };

  it("asks for the day of a meetup under its own title", () => {
    const screen = datePresetsScreen({ picker, today });

    expect(screen.id).toBe("date-presets");
    expect(screen.format).toBe("HTML");
    expect(screen.text).toBe(
      "<b>Дата и время</b>\n\nКогда встречаемся? Выбери день.",
    );
  });

  it("names the chosen day in words when it asks for the time", () => {
    const screen = datePresetsScreen({
      picker,
      today,
      picked: { digits: "03102026", day: { year: 2026, month: 10, day: 3 } },
    });

    expect(screen.text).toBe(
      "<b>Дата и время</b>\n\n3 октября, сб — во сколько?",
    );
    expect(rows(screen.keyboard)[2]).toEqual(["Другой день"]);
  });

  it("asks for the publication moment and puts the lead above the question as text", () => {
    const screen = datePresetsScreen({
      picker: { token, mode: "d" },
      today,
      lead: "Сейчас назначено: <завтра>",
    });

    expect(screen.text).toBe(
      "<b>Публикация</b>\n\nСейчас назначено: &lt;завтра&gt;\n\nКогда опубликовать сходку? Выбери день. Время — по времени сообщества.",
    );
    expect(data(screen.keyboard).at(-1)).toBe(`v1:manage:when:${token}:d:x`);
  });
});
