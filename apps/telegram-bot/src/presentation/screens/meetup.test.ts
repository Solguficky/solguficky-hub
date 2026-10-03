import { describe, expect, it } from "vitest";
import type {
  ArchivedMeetupSummary,
  MeetupSnapshot,
  MeetupSummary,
} from "../../meetups/port.js";
import {
  archiveScreen,
  cardScreen,
  hiddenScreen,
  materialsScreen,
  meetupParent,
  statusScreen,
  upcomingScreen,
} from "./meetup.js";

// L0: сборщики экранов сходки на данных, без бота и Telegram. Что экран
// проходит правила дизайн-кода, держит линтер test kit; здесь — то, чего он не
// видит: что именно попало на страницу и куда ведёт возврат.

const today = { year: 2026, month: 8, day: 1 };

function meetup(overrides: Partial<MeetupSnapshot> = {}): MeetupSnapshot {
  return {
    id: "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60",
    author: "0192f0a0-0000-7000-8000-00000000a001",
    title: "Настолки",
    description: "Берём свои игры",
    venue: "Циферблат",
    schedule: { year: 2026, month: 8, day: 15, hours: 19, minutes: 0 },
    lifecycle: "planned",
    visibility: "visible",
    version: 1,
    materials: [],
    ...overrides,
  };
}

function summaries(count: number): MeetupSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `0198f2a4-7c1e-7d3a-9b21-${(index + 1).toString(16).padStart(12, "0")}`,
    title: `Сходка ${index + 1}`,
    schedule: { year: 2026, month: 8, day: index + 1 },
    visibility: "visible" as const,
  }));
}

const rows = (screen: {
  keyboard: { inline_keyboard: { text: string }[][] };
}) =>
  screen.keyboard.inline_keyboard.map((row) =>
    row.map((button) => button.text),
  );

describe("meetupParent", () => {
  it("returns a planned visible meetup to the upcoming list", () => {
    expect(meetupParent(meetup(), today).name).toBe("Ближайшие");
  });

  it("returns a hidden planned meetup to the hidden section", () => {
    expect(meetupParent(meetup({ visibility: "hidden" }), today).name).toBe(
      "Скрытые",
    );
  });

  it("returns a cancelled, held or past meetup to the archive even when hidden", () => {
    expect(meetupParent(meetup({ lifecycle: "cancelled" }), today).name).toBe(
      "Архив",
    );
    expect(
      meetupParent(meetup({ lifecycle: "held", visibility: "hidden" }), today)
        .name,
    ).toBe("Архив");
    expect(
      meetupParent(
        meetup({
          schedule: { year: 2026, month: 7, day: 31, hours: 19, minutes: 0 },
        }),
        today,
      ).name,
    ).toBe("Архив");
  });

  it("keeps a meetup of today in the upcoming list", () => {
    expect(
      meetupParent(
        meetup({
          schedule: { year: 2026, month: 8, day: 1, hours: 0, minutes: 0 },
        }),
        today,
      ).name,
    ).toBe("Ближайшие");
  });
});

describe("upcomingScreen", () => {
  it("cuts the list into pages of eight with a pager and the page in the title", () => {
    const first = upcomingScreen(summaries(17), 0, today);
    const last = upcomingScreen(summaries(17), 2, today);

    expect(first.text).toContain("<b>Ближайшие сходки · 1 из 3</b>");
    expect(rows(first)).toHaveLength(8 + 2);
    expect(rows(first).at(-2)).toEqual(["→"]);
    expect(first.keyboard.inline_keyboard.at(-2)?.[0]).toMatchObject({
      callback_data: "v1:nav:hub:1",
    });
    expect(last.text).toContain("· 3 из 3");
    expect(rows(last)).toEqual([["17 августа · Сходка 17"], ["←"], ["‹ Меню"]]);
  });

  it("opens the last page for a page beyond the list", () => {
    expect(upcomingScreen(summaries(9), 7, today).text).toContain("· 2 из 2");
  });

  it("names the year of a date outside the current one", () => {
    const next = upcomingScreen(
      [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-000000000001",
          title: "Новогодняя",
          schedule: { year: 2027, month: 1, day: 3 },
          visibility: "visible",
        },
      ],
      0,
      today,
    );

    expect(next.text).toContain("• 3 января 2027, вс — Новогодняя");
    expect(rows(next)[0]).toEqual(["3 января 2027 · Новогодняя"]);
  });

  it("escapes a title in the text and leaves it as is on the button", () => {
    const screen = upcomingScreen(
      [
        {
          id: "0198f2a4-7c1e-7d3a-9b21-000000000001",
          title: "<b>Жирная</b>",
          visibility: "visible",
        },
      ],
      0,
      today,
    );

    expect(screen.text).toContain("• &lt;b&gt;Жирная&lt;/b&gt;");
    expect(rows(screen)[0]).toEqual(["<b>Жирная</b>"]);
  });
});

describe("archiveScreen", () => {
  it("names how each meetup ended and returns to the menu", () => {
    const archived: ArchivedMeetupSummary[] = [
      { ...summaries(1)[0], status: "held" } as ArchivedMeetupSummary,
    ];
    const screen = archiveScreen(archived, 0, today);

    expect(screen.text).toBe(
      "<b>Архив</b>\n\n• 1 августа, сб — Сходка 1 (состоялась)",
    );
    expect(rows(screen).at(-1)).toEqual(["‹ Меню"]);
  });
});

describe("hiddenScreen", () => {
  it("lists only hidden meetups and returns to management", () => {
    const screen = hiddenScreen(
      [
        { ...summaries(1)[0], visibility: "hidden" } as MeetupSummary,
        ...summaries(3).slice(1),
      ],
      0,
      today,
    );

    expect(screen.text).toBe(
      "<b>Скрытые сходки</b>\n\n• 1 августа, сб — Сходка 1",
    );
    expect(rows(screen)).toEqual([
      ["1 августа · Сходка 1"],
      ["‹ Управление", "Меню"],
    ]);
  });
});

describe("cardScreen", () => {
  const view = { manageable: true, presentation: "plain" as const, today };

  it("fits an organizer's card into five rows", () => {
    const screen = cardScreen({ ...view, meetup: meetup(), subscribed: true });

    expect(rows(screen)).toEqual([
      ["Изменить", "Статус"],
      ["Материалы (0)"],
      ["Написать подписчикам"],
      ["Отписаться", "Уведомления сходки"],
      ["‹ Ближайшие", "Меню"],
    ]);
  });

  it("shows a participant the subscription and materials only when there are any", () => {
    const participant = { ...view, manageable: false, subscribed: false };

    expect(rows(cardScreen({ ...participant, meetup: meetup() }))).toEqual([
      ["Подписаться на сходку"],
      ["‹ Ближайшие", "Меню"],
    ]);
    expect(
      rows(
        cardScreen({
          ...participant,
          meetup: meetup({
            materials: [
              {
                id: "0199c0de-0000-7000-8000-000000000002",
                title: "Афиша",
                source: { kind: "file", fileId: "bot-file-id" },
              },
            ],
          }),
        }),
      ),
    ).toEqual([
      ["Материалы (1)"],
      ["Подписаться на сходку"],
      ["‹ Ближайшие", "Меню"],
    ]);
  });

  it("puts the note above the title and the subscription hint below the card", () => {
    const noted = cardScreen({
      ...view,
      meetup: meetup(),
      subscribed: false,
      note: "Изменение сохранено.",
    });
    const hinted = cardScreen({ ...view, meetup: meetup(), subscribed: false });

    expect(
      noted.text.startsWith("Изменение сохранено.\n\n<b>Настолки</b>"),
    ).toBe(true);
    expect(noted.text).not.toContain("Подпишись");
    expect(hinted.text.endsWith("сообщения организатора этой сходки.")).toBe(
      true,
    );
  });

  it("reads the date in words and addresses the author informally", () => {
    const screen = cardScreen({
      ...view,
      meetup: meetup(),
      author: { kind: "self" },
    });

    expect(screen.text).toContain("Когда: 15 августа, сб, 19:00");
    expect(screen.text).toContain("Ты автор этой сходки");
  });

  it("keeps a cancelled meetup readable but not editable", () => {
    const screen = cardScreen({
      ...view,
      meetup: meetup({ lifecycle: "cancelled" }),
    });

    expect(rows(screen)).toEqual([
      ["Написать подписчикам"],
      ["Уведомления сходки"],
      ["‹ Архив", "Меню"],
    ]);
  });
});

describe("statusScreen", () => {
  it("keeps every state action of a planned hidden meetup with a moment", () => {
    const screen = statusScreen(
      meetup({
        visibility: "hidden",
        publishAt: { year: 2026, month: 8, day: 10, hours: 9, minutes: 30 },
      }),
      undefined,
      today,
    );

    expect(rows(screen)).toEqual([
      ["Опубликовать"],
      ["Перенести публикацию"],
      ["Отменить отложенную публикацию"],
      ["Отметить состоявшейся"],
      ["Отменить сходку"],
      ["‹ Сходка", "Меню"],
    ]);
    expect(screen.text).toContain(
      "Публикация назначена на 10 августа, пн, 09:30",
    );
  });
});

describe("materialsScreen", () => {
  const materials = Array.from({ length: 9 }, (_, index) => ({
    id: `0199c0de-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    title: `Материал ${index + 1}`,
    source:
      index === 0
        ? { kind: "file" as const, fileId: "bot-file-id" }
        : { kind: "message-link" as const, url: `https://t.me/c/1/${index}` },
  }));

  it("opens a file by a button and marks a link, with removal for the organizer", () => {
    const screen = materialsScreen(meetup({ materials }), true, 0);

    expect(rows(screen)[0]).toEqual(["Материал 1", "Убрать"]);
    expect(rows(screen)[1]).toEqual(["Материал 2 ↗", "Убрать"]);
    expect(rows(screen).slice(-3)).toEqual([
      ["→"],
      ["Прикрепить материал"],
      ["‹ Сходка", "Меню"],
    ]);
  });

  it("shows a participant the materials without management", () => {
    const screen = materialsScreen(meetup({ materials }), false, 1);

    expect(rows(screen)).toEqual([
      ["Материал 9 ↗"],
      ["←"],
      ["‹ Сходка", "Меню"],
    ]);
    expect(screen.text).toContain("<b>Материалы · 2 из 2</b>");
  });
});
