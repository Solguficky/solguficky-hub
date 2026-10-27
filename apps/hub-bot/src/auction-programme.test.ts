import { describe, expect, it } from "vitest";
import {
  type AuctionWeekFacts,
  auctionStatusLine,
  programmeParagraph,
} from "./auction-programme.js";
import type { AuctionBlock, AuctionSummaryView } from "./auction-ui/index.js";

type RootBlock = Extract<AuctionBlock, { kind: "root" }>;

const auctionId = "01926f3c-8b7a-5cde-8f00-000000000001";
// Понедельник, 26 октября 2026 года, 15:00 по Москве.
const now = new Date("2026-10-26T12:00:00Z");
const options = {
  moment: (instant: string) => `[${instant}]`,
  timeZone: "Europe/Moscow",
  now,
};

const week: AuctionSummaryView = {
  auctionId,
  stage: "prebidding",
  opensAt: "2026-10-24T09:00:00Z",
  closesAt: "2026-10-30T18:00:00Z",
  final: true,
};

function root(
  auction: Partial<AuctionSummaryView>,
  raffleClosesAt?: string,
): RootBlock {
  return {
    kind: "root",
    auctionId,
    auction: { ...week, ...auction },
    ...(raffleClosesAt === undefined ? {} : { raffleClosesAt }),
  };
}

const window = (from: string, until: string, lots = 1) => ({
  from,
  until,
  lotIds: Array.from({ length: lots }, (_, index) => `lot-${index}`),
});

describe("week programme in the auction root", () => {
  it("names today's windows, the next one, the raffle, the deadline and the final", () => {
    const text = programmeParagraph(
      root(
        {
          finalAt: "2026-10-31T16:00:00Z",
          stepWindows: [
            // Прошло утром — выпадает.
            window("2026-10-26T06:00:00Z", "2026-10-26T07:00:00Z"),
            // Идёт сейчас.
            window("2026-10-26T11:00:00Z", "2026-10-26T13:00:00Z", 3),
            // Сегодня вечером.
            window("2026-10-26T16:00:00Z", "2026-10-26T18:00:00Z", 5),
            // Ближайшее после сегодняшних.
            window("2026-10-27T15:00:00Z", "2026-10-27T17:00:00Z", 2),
            window("2026-10-28T15:00:00Z", "2026-10-28T17:00:00Z"),
          ],
        },
        "2026-10-29T18:00:00Z",
      ),
      options,
    );

    expect(text).toBe(
      [
        "<b>Программа недели</b>",
        "Счастливые часы: сейчас, до 16:00 — 3 лота",
        "Счастливые часы: [2026-10-26T16:00:00Z]–21:00 — 5 лотов",
        "Счастливые часы: [2026-10-27T15:00:00Z]–20:00 — 2 лота",
        "Ещё счастливых часов на неделе: 1",
        "Розыгрыш: [2026-10-29T18:00:00Z]",
        "Онлайн-торги до [2026-10-30T18:00:00Z]",
        "Финал: ориентировочно [2026-10-31T16:00:00Z]",
      ].join("\n"),
    );
  });

  it("names only the nearest window when none is today", () => {
    const text = programmeParagraph(
      root({
        stepWindows: [
          window("2026-10-28T15:00:00Z", "2026-10-28T17:00:00Z"),
          window("2026-10-29T15:00:00Z", "2026-10-29T17:00:00Z"),
        ],
      }),
      options,
    );

    expect(text).toContain(
      "Счастливые часы: [2026-10-28T15:00:00Z]–20:00 — 1 лот",
    );
    expect(text).toContain("Ещё счастливых часов на неделе: 1");
  });

  it("names a window past midnight by both moments", () => {
    const text = programmeParagraph(
      root({
        stepWindows: [window("2026-10-27T19:00:00Z", "2026-10-27T22:00:00Z")],
      }),
      options,
    );

    expect(text).toContain(
      "Счастливые часы: [2026-10-27T19:00:00Z]–[2026-10-27T22:00:00Z] — 1 лот",
    );
  });

  it("names the end of a running window past midnight by its moment", () => {
    const text = programmeParagraph(
      root({
        stepWindows: [window("2026-10-26T11:00:00Z", "2026-10-26T22:00:00Z")],
      }),
      options,
    );

    expect(text).toContain(
      "Счастливые часы: сейчас, до [2026-10-26T22:00:00Z] — 1 лот",
    );
  });

  it("caps the windows of a busy day and counts the rest", () => {
    const hours = [13, 14, 15, 16];
    const text = programmeParagraph(
      root({
        stepWindows: hours.map((hour) =>
          window(`2026-10-26T${hour}:00:00Z`, `2026-10-26T${hour}:30:00Z`),
        ),
      }),
      options,
    );

    expect(text?.match(/Счастливые часы:/g)).toHaveLength(3);
    expect(text).toContain("Ещё счастливых часов на неделе: 1");
  });

  // Критерий PER-724: без окон и розыгрыша — только финал и дедлайн.
  it("tells only the deadline and the final without windows and raffle", () => {
    const text = programmeParagraph(
      root({ finalAt: "2026-10-31T16:00:00Z" }),
      options,
    );

    expect(text).toBe(
      [
        "<b>Программа недели</b>",
        "Онлайн-торги до [2026-10-30T18:00:00Z]",
        "Финал: ориентировочно [2026-10-31T16:00:00Z]",
      ].join("\n"),
    );
  });

  it("drops the raffle once registration has closed", () => {
    const text = programmeParagraph(root({}, "2026-10-26T11:00:00Z"), options);

    expect(text).not.toContain("Розыгрыш");
  });

  it("drops the final without an estimated time, once it is past and after it has begun", () => {
    expect(programmeParagraph(root({}), options)).not.toContain("Финал");
    // Финал задержался: прошедшее время не обещается.
    expect(
      programmeParagraph(
        root({ stage: "on-break", finalAt: "2026-10-26T11:00:00Z" }),
        options,
      ),
    ).toBeUndefined();
    expect(
      programmeParagraph(
        root({ stage: "in-final", finalAt: "2026-10-26T11:00:00Z" }),
        options,
      ),
    ).toBeUndefined();
  });

  it("says nothing once the online week and the final are over", () => {
    expect(
      programmeParagraph(
        root({
          stage: "finished",
          finalAt: "2026-10-25T16:00:00Z",
          stepWindows: [window("2026-10-27T15:00:00Z", "2026-10-27T17:00:00Z")],
        }),
        options,
      ),
    ).toBeUndefined();
  });

  it("says nothing about an auction Auction did not return", () => {
    expect(
      programmeParagraph({ kind: "root", auctionId }, options),
    ).toBeUndefined();
  });
});

// Четверг, 29 октября 2026 года, 19:00 по Москве: четвёртый день недели с
// понедельника 26.10 00:00 до понедельника 02.11 00:00.
const statusNow = new Date("2026-10-29T16:00:00Z");
const statusOptions = { timeZone: "Europe/Moscow", now: statusNow };

const statusWeek: AuctionWeekFacts = {
  stage: "prebidding",
  opensAt: "2026-10-25T21:00:00Z",
  closesAt: "2026-11-01T21:00:00Z",
};

const line = (facts: Partial<AuctionWeekFacts>) =>
  auctionStatusLine({ ...statusWeek, ...facts }, statusOptions);

describe("auctionStatusLine", () => {
  it("names the day of the week, the running window and the raffle", () => {
    expect(
      line({
        stepWindows: [window("2026-10-29T15:00:00Z", "2026-10-29T19:00:00Z")],
        raffleClosesAt: "2026-10-30T18:00:00Z",
      }),
    ).toBe(
      "день 4 из 7 · 🔥 Счастливые часы до 22:00 · розыгрыш: регистрация до 30.10",
    );
  });

  it("names the nearest window later today or on its own day", () => {
    expect(
      line({
        stepWindows: [
          window("2026-10-31T15:00:00Z", "2026-10-31T19:00:00Z"),
          window("2026-10-29T17:00:00Z", "2026-10-29T19:00:00Z"),
        ],
      }),
    ).toBe("день 4 из 7 · 🔥 Счастливые часы сегодня с 20:00");
    expect(
      line({
        stepWindows: [window("2026-10-31T15:00:00Z", "2026-10-31T19:00:00Z")],
      }),
    ).toBe("день 4 из 7 · 🔥 Счастливые часы 31.10 с 18:00");
  });

  it("dates the end of a running window that ends after midnight", () => {
    expect(
      line({
        stepWindows: [window("2026-10-29T15:00:00Z", "2026-10-29T23:00:00Z")],
      }),
    ).toBe("день 4 из 7 · 🔥 Счастливые часы до 30.10 02:00");
  });

  it("drops the windows that are over and keeps the day alone", () => {
    expect(
      line({
        stepWindows: [window("2026-10-27T15:00:00Z", "2026-10-27T19:00:00Z")],
      }),
    ).toBe("день 4 из 7");
    expect(line({})).toBe("день 4 из 7");
  });

  it("drops the raffle once its registration is closed", () => {
    expect(line({ raffleClosesAt: "2026-10-29T15:00:00Z" })).toBe(
      "день 4 из 7",
    );
  });

  it("names the closing hour of a raffle that closes today", () => {
    expect(line({ raffleClosesAt: "2026-10-29T18:00:00Z" })).toBe(
      "день 4 из 7 · розыгрыш: регистрация до 21:00",
    );
  });

  // До торгов дня недели нет, а регистрация ещё не открыта: остаётся только
  // ближайшее окно, если оно объявлено.
  it("keeps only the nearest window before the trading", () => {
    const before = {
      stage: "scheduled" as const,
      opensAt: "2026-11-01T21:00:00Z",
      closesAt: "2026-11-08T21:00:00Z",
      raffleClosesAt: "2026-11-06T18:00:00Z",
    };
    expect(line(before)).toBeUndefined();
    expect(
      line({
        ...before,
        stepWindows: [window("2026-11-03T15:00:00Z", "2026-11-03T19:00:00Z")],
      }),
    ).toBe("🔥 Счастливые часы 03.11 с 18:00");
  });

  it("says nothing from the settling of the online week to the end", () => {
    for (const stage of [
      "settling",
      "on-break",
      "lineup-frozen",
      "in-final",
      "finished",
      "cancelled",
    ] as const) {
      expect(
        line({
          stage,
          stepWindows: [window("2026-10-29T15:00:00Z", "2026-10-29T19:00:00Z")],
          raffleClosesAt: "2026-10-30T18:00:00Z",
        }),
        stage,
      ).toBeUndefined();
    }
  });

  // Сутки идут от открытия торгов: неделя не с полуночи — тоже семь дней.
  it("counts the days of a week that opens in the evening", () => {
    const evening = {
      opensAt: "2026-10-26T15:00:00Z",
      closesAt: "2026-11-02T15:00:00Z",
    };
    expect(line(evening)).toBe("день 4 из 7");
    expect(
      auctionStatusLine(
        { ...statusWeek, ...evening },
        { ...statusOptions, now: new Date("2026-10-26T14:00:00Z") },
      ),
    ).toBeUndefined();
  });

  it("counts the first and the last day of the week", () => {
    expect(
      auctionStatusLine(statusWeek, {
        ...statusOptions,
        now: new Date("2026-10-25T21:00:00Z"),
      }),
    ).toBe("день 1 из 7");
    expect(
      auctionStatusLine(statusWeek, {
        ...statusOptions,
        now: new Date("2026-11-01T20:59:00Z"),
      }),
    ).toBe("день 7 из 7");
  });
});
