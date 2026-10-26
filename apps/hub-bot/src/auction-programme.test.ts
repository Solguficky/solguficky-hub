import { describe, expect, it } from "vitest";
import { programmeParagraph } from "./auction-programme.js";
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
