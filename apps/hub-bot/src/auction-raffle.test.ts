import { describe, expect, it } from "vitest";
import { raffleParagraphs } from "./auction-raffle.js";
import type { RaffleView } from "./auction-ui/index.js";

// Тексты экрана розыгрыша общие у двух поверхностей (ADR-066, п. 11): строку
// момента им даёт оболочка, поэтому здесь проверяется только «есть или нет» и
// место абзаца (PER-641). Пояс и год — дело оболочек и их тестов.

const base: RaffleView = {
  auctionId: "daef05c7-cd68-5048-b03d-cb4860e8dc73",
  status: "open",
  closesAt: "2026-10-13T18:00:00Z",
  commitment: "ab".repeat(32),
  beaconRound: 12_345_678,
  registered: true,
  tickets: [{ number: 1, displayName: "@owl" }],
  myTicket: 1,
};

const drawnRaffle = (extra: Partial<RaffleView> = {}): RaffleView => ({
  ...base,
  status: "drawn",
  reveal: {
    seed: "cd".repeat(32),
    randomness: "ef".repeat(32),
    value: "12".repeat(32),
    winningTicket: 1,
  },
  ...extra,
});

const moment = () => "14 октября, ср, 03:51";

const momentLines = (paragraphs: readonly string[]): string[] =>
  paragraphs.filter((line) => line.startsWith("Жеребьёвка: "));

describe("shared raffle result text", () => {
  it("shows the draw moment right after the winner", () => {
    expect(
      raffleParagraphs(drawnRaffle({ drawnAt: "2026-10-13T22:51:00Z" }), {
        moment,
      }),
    ).toEqual([
      "<b>Выиграл билет №1 — @owl.</b> Это твой билет.",
      "Жеребьёвка: 14 октября, ср, 03:51",
      "Билетов: 1\nТвой билет: №1",
      "• №1 — @owl",
    ]);
  });

  it("shows no draw moment before the draw", () => {
    for (const status of [
      "open",
      "closing",
      "awaiting-beacon",
      "no-tickets",
      "not-held",
    ] as const) {
      expect(
        momentLines(raffleParagraphs({ ...base, status }, { moment })),
      ).toEqual([]);
    }
  });

  // Выкладка соседа отстала: у итога момента нет — строки тоже нет.
  it("shows no moment line when the neighbour sends none", () => {
    expect(momentLines(raffleParagraphs(drawnRaffle(), { moment }))).toEqual(
      [],
    );
  });

  it("escapes the moment the shell hands over", () => {
    expect(
      raffleParagraphs(drawnRaffle({ drawnAt: "2026-10-13T22:51:00Z" }), {
        moment: () => "<b>14 октября",
      }),
    ).toContain("Жеребьёвка: &lt;b&gt;14 октября");
  });
});
