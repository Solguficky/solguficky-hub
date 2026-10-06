import { describe, expect, it } from "vitest";
import type {
  AuctionConsoles,
  AuctionWeekConfig,
  ConsoleReadResult,
  FinalistResult,
  ScheduleAuctionResult,
  StartPrebiddingResult,
} from "../auction/port.js";
import { createAuctionConsole, parseWeek } from "./auction-console.js";
import type { AuctionConsoleView, Person } from "./types.js";

// Юзкейсы пульта аукциона (PER-320) без Telegram: разбор сроков недели и
// перевод ответов Auction в пульт с исходом. Auction подменён ответами по
// вызову; чтение пульта возвращает то, что задал тест, — так видно, что
// принятая команда накладывается на отстающее чтение.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const opId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa";
const admin: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles: ["admin"],
};
const zone = "Europe/Moscow";
const week = {
  opensAt: "2026-10-20T15:00:00Z",
  closesAt: "2026-10-26T21:00:00Z",
};

function view(
  status: AuctionConsoleView["status"],
  extra: Partial<AuctionConsoleView> = {},
): AuctionConsoleView {
  return { auctionId, status, lots: [], ...extra };
}

function fake(answers: {
  read?: ConsoleReadResult;
  schedule?: ScheduleAuctionResult;
  start?: StartPrebiddingResult;
  mark?: FinalistResult;
}) {
  const scheduled: AuctionWeekConfig[] = [];
  const port: AuctionConsoles = {
    getAuctionConsole: async () =>
      answers.read ?? { kind: "ok", console: view("draft") },
    scheduleAuction: async (_person, config) => {
      scheduled.push(config);
      return answers.schedule ?? { kind: "ok" };
    },
    startPrebidding: async () => answers.start ?? { kind: "ok" },
    selectForFinal: async () => answers.mark ?? { kind: "ok" },
    deselectForFinal: async () => answers.mark ?? { kind: "ok" },
  };
  return { run: createAuctionConsole(port, zone), scheduled };
}

describe("parse week", () => {
  it.each([
    "20.10.2026 18:00 — 27.10.2026 00:00",
    "20.10.2026 18:00 - 27.10.2026 00:00",
    "20.10.2026 18:00–27.10.2026 00:00",
    "  20.10.2026 18:00 27.10.2026 00:00 ",
  ])("reads «%s» in community time", (raw) => {
    expect(parseWeek(raw, zone)).toEqual({ kind: "ok", ...week });
  });

  it.each([
    ["no end", "20.10.2026 18:00"],
    ["no year", "20.10 18:00 — 27.10 00:00"],
    ["a day the calendar lacks", "31.11.2026 18:00 — 27.12.2026 00:00"],
    ["an hour past the day", "20.10.2026 24:00 — 27.10.2026 00:00"],
  ])("refuses %s as a format error", (_name, raw) => {
    expect(parseWeek(raw, zone)).toEqual({
      kind: "rejected",
      error: "week-format",
    });
  });

  it("refuses a time the clocks skipped and an end not after the start", () => {
    expect(
      parseWeek("29.03.2026 02:30 — 05.04.2026 00:00", "Europe/Berlin"),
    ).toEqual({ kind: "rejected", error: "week-moment" });
    expect(parseWeek("20.10.2026 18:00 — 20.10.2026 18:00", zone)).toEqual({
      kind: "rejected",
      error: "week-order",
    });
  });
});

describe("auction console use cases", () => {
  const call = { identity: admin, auctionId };

  it("schedules the first week with the final and shows it over a lagging read", async () => {
    const { run, scheduled } = fake({});

    const result = await run({
      ...call,
      intent: "schedule-auction-week",
      value: "20.10.2026 18:00 — 27.10.2026 00:00",
      opId,
    });

    expect(scheduled).toEqual([{ auctionId, opId, ...week, final: true }]);
    expect(result).toEqual({
      kind: "auction-console",
      console: view("scheduled", { week: { ...week, final: true } }),
      note: "week-saved",
    });
  });

  it("asks the dates again with the reason and the current week, without a command", async () => {
    const current = view("scheduled", { week: { ...week, final: false } });
    const { run, scheduled } = fake({
      read: { kind: "ok", console: current },
    });

    await expect(
      run({ ...call, intent: "schedule-auction-week", value: "завтра", opId }),
    ).resolves.toEqual({
      kind: "auction-week-ask",
      auctionId,
      week: { ...week, final: false },
      error: "week-format",
    });
    expect(scheduled).toEqual([]);
  });

  it("does not change the dates of an opened week", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: view("prebidding") },
    });

    await expect(
      run({
        ...call,
        intent: "schedule-auction-week",
        value: "20.10.2026 18:00 — 27.10.2026 00:00",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-frozen" });
    expect(scheduled).toEqual([]);
  });

  it("asks for the dates before the final can be switched", async () => {
    const { run, scheduled } = fake({});

    await expect(
      run({ ...call, intent: "set-auction-final", final: false, opId }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-needed" });
    expect(scheduled).toEqual([]);
  });

  it("names a refused start by the state of the auction", async () => {
    const draft = fake({ start: { kind: "not-scheduled" } });
    const opened = fake({
      start: { kind: "not-scheduled" },
      read: { kind: "ok", console: view("prebidding") },
    });

    await expect(
      draft.run({ ...call, intent: "start-auction-week", opId }),
    ).resolves.toMatchObject({ note: "week-not-scheduled" });
    await expect(
      opened.run({ ...call, intent: "start-auction-week", opId }),
    ).resolves.toMatchObject({ note: "week-already-open" });
  });

  it("shows an accepted start over a read that has not seen it yet", async () => {
    const { run } = fake({
      read: { kind: "ok", console: view("scheduled") },
    });

    await expect(
      run({ ...call, intent: "start-auction-week", opId }),
    ).resolves.toMatchObject({
      kind: "auction-console",
      console: { status: "prebidding" },
      note: "week-opened",
    });
  });

  it("shows a refused mark as the line of the console", async () => {
    const { run } = fake({
      mark: { kind: "refused", reason: "deadline-passed" },
      read: { kind: "ok", console: view("prebidding") },
    });

    await expect(
      run({
        ...call,
        intent: "mark-auction-finalist",
        lotId,
        selected: true,
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "auction-console",
      note: "deadline-passed",
    });
  });

  it("refuses the console to someone Auction does not take for the administrator", async () => {
    const { run } = fake({ read: { kind: "meetup-not-found" } });

    await expect(
      run({ ...call, intent: "view-auction-console" }),
    ).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "not-administrator",
    });
  });
});
