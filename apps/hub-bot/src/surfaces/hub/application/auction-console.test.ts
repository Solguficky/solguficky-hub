import { describe, expect, it } from "vitest";
import type { Money } from "../../../auction-ui/index.js";
import type {
  AdvanceAskResult,
  AuctionConsoles,
  AuctionWeekConfig,
  CloseLotResult,
  ConsoleReadResult,
  DiscardAuctionResult,
  DisplayNamesResult,
  FinalBidsResult,
  FinalistResult,
  FinalLotCommand,
  FreezeFinalLineupResult,
  LotStatisticsReadResult,
  ScheduleAuctionResult,
  StartFinalResult,
  StartNextLotResult,
  StartPrebiddingResult,
} from "../auction/port.js";
import {
  createAuctionConsole,
  lineupPrint,
  parseRaffle,
  parseWeek,
  parseWindow,
  windowLimit,
  windowPrint,
} from "./auction-console.js";
import type {
  AuctionConsoleView,
  ConsoleLot,
  Person,
  StepWindow,
} from "./types.js";

// Юзкейсы пульта аукциона (PER-320) без Telegram: разбор сроков недели и
// перевод ответов Auction в пульт с исходом. Auction подменён ответами по
// вызову; чтение пульта возвращает то, что задал тест, — так видно, что
// принятая команда накладывается на отстающее чтение.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const opId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa";
const admin: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "place-bids"],
};
const zone = "Europe/Moscow";
// Часы бота в тестах: 6 октября 2026 года, 12:00 по Москве.
const now = new Date("2026-10-06T09:00:00Z");
const noLotStatistics: LotStatisticsReadResult = { kind: "ok", lots: [] };
const week = {
  opensAt: "2026-10-20T15:00:00Z",
  closesAt: "2026-10-26T21:00:00Z",
  windows: [],
};

function view(
  status: AuctionConsoleView["status"],
  extra: Partial<AuctionConsoleView> = {},
): AuctionConsoleView {
  return { auctionId, status, lots: [], ...extra };
}

function fake(answers: {
  read?: ConsoleReadResult;
  statistics?: LotStatisticsReadResult;
  schedule?: ScheduleAuctionResult;
  start?: StartPrebiddingResult;
  mark?: FinalistResult;
  discard?: DiscardAuctionResult;
  freeze?: FreezeFinalLineupResult;
  startFinal?: StartFinalResult;
  nextLot?: StartNextLotResult;
  ask?: AdvanceAskResult;
  close?: CloseLotResult;
  bids?: FinalBidsResult;
  names?: DisplayNamesResult;
}) {
  const scheduled: AuctionWeekConfig[] = [];
  const asks: Money[] = [];
  const closes: FinalLotCommand[] = [];
  const freezes: (readonly string[])[] = [];
  const port: AuctionConsoles = {
    getAuctionConsole: async () =>
      answers.read ?? { kind: "ok", console: view("draft") },
    getAuctionLotStatistics: async () => {
      if (answers.statistics === undefined) {
        throw new Error("statistics response not configured by test");
      }
      return answers.statistics;
    },
    scheduleAuction: async (_person, config) => {
      scheduled.push(config);
      return answers.schedule ?? { kind: "ok" };
    },
    startPrebidding: async () => answers.start ?? { kind: "ok" },
    discardAuction: async () => answers.discard ?? { kind: "ok" },
    selectForFinal: async () => answers.mark ?? { kind: "ok" },
    deselectForFinal: async () => answers.mark ?? { kind: "ok" },
    freezeFinalLineup: async (_person, freeze) => {
      freezes.push(freeze.lotIds);
      return answers.freeze ?? { kind: "ok" };
    },
    startFinal: async () => answers.startFinal ?? { kind: "ok" },
    startNextLot: async () =>
      answers.nextLot ?? { kind: "ok", lotId: "not configured" },
    advanceAsk: async (_person, ask) => {
      asks.push(ask.newAsk);
      return answers.ask ?? { kind: "ok" };
    },
    closeLot: async (_person, close) => {
      closes.push(close);
      return answers.close ?? { kind: "ok", closure: { kind: "unsold" } };
    },
    recentBids: async () => answers.bids ?? { kind: "ok", bids: [], names: {} },
    displayNames: async () => answers.names ?? { kind: "ok", names: {} },
  };
  return {
    run: createAuctionConsole(port, zone, () => now),
    scheduled,
    asks,
    closes,
    freezes,
  };
}

describe("parseWeek", () => {
  it.each([
    "20.10.2026 18:00 — 27.10.2026 00:00",
    "20.10.2026 18:00 - 27.10.2026 00:00",
    "20.10.2026 18:00–27.10.2026 00:00",
    "  20.10.2026 18:00 27.10.2026 00:00 ",
  ])("reads «%s» in community time", (raw) => {
    expect(parseWeek(raw, zone, now)).toEqual({
      kind: "ok",
      opensAt: week.opensAt,
      closesAt: week.closesAt,
    });
  });

  it.each([
    ["no end", "20.10.2026 18:00"],
    ["no year", "20.10 18:00 — 27.10 00:00"],
    ["a day the calendar lacks", "31.11.2026 18:00 — 27.12.2026 00:00"],
    ["an hour past the day", "20.10.2026 24:00 — 27.10.2026 00:00"],
  ])("refuses %s as a format error", (_name, raw) => {
    expect(parseWeek(raw, zone, now)).toEqual({
      kind: "rejected",
      error: "week-format",
    });
  });

  it("refuses a time the clocks skipped and an end not after the start", () => {
    expect(
      parseWeek("29.03.2026 02:30 — 05.04.2026 00:00", "Europe/Berlin", now),
    ).toEqual({ kind: "rejected", error: "week-moment" });
    expect(parseWeek("20.10.2026 18:00 — 20.10.2026 18:00", zone, now)).toEqual(
      {
        kind: "rejected",
        error: "week-order",
      },
    );
  });

  it("requires a separator between the start and the end", () => {
    expect(parseWeek("20.10.2026 18:0027.10.2026 00:00", zone, now)).toEqual({
      kind: "rejected",
      error: "week-format",
    });
  });

  it("refuses an end that has already come by the clock of the bot", () => {
    expect(parseWeek("01.10.2026 18:00 — 06.10.2026 12:00", zone, now)).toEqual(
      { kind: "rejected", error: "week-ended" },
    );
    expect(
      parseWeek("01.10.2026 18:00 — 06.10.2026 12:01", zone, now),
    ).toMatchObject({ kind: "ok" });
  });
});

describe("auction console", () => {
  const call = { identity: admin, auctionId };

  it("schedules the first week with the final and shows it over a lagging read", async () => {
    const { run, scheduled } = fake({ statistics: noLotStatistics });

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
      statistics: noLotStatistics,
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
      statistics: noLotStatistics,
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
    const { run, scheduled } = fake({ statistics: noLotStatistics });

    await expect(
      run({ ...call, intent: "set-auction-final", final: false, opId }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-needed" });
    expect(scheduled).toEqual([]);
  });

  it("names a refused start by the state of the auction", async () => {
    const draft = fake({
      start: { kind: "not-scheduled" },
      statistics: noLotStatistics,
    });
    const opened = fake({
      start: { kind: "not-scheduled" },
      read: { kind: "ok", console: view("prebidding") },
      statistics: noLotStatistics,
    });

    await expect(
      draft.run({ ...call, intent: "start-auction-week", opId }),
    ).resolves.toMatchObject({ note: "week-not-scheduled" });
    await expect(
      opened.run({ ...call, intent: "start-auction-week", opId }),
    ).resolves.toMatchObject({ note: "week-already-open" });
  });

  it("names a start refused because another auction is trading on the console", async () => {
    const { run } = fake({
      start: {
        kind: "another-auction-active",
        auctionId: "0190f2a0-0000-7000-8000-000000000021",
      },
      read: { kind: "ok", console: view("scheduled") },
      statistics: noLotStatistics,
    });

    await expect(
      run({ ...call, intent: "start-auction-week", opId }),
    ).resolves.toMatchObject({
      kind: "auction-console",
      note: "another-auction-active",
    });
  });

  it("shows an accepted start over a read that has not seen it yet", async () => {
    const { run } = fake({
      read: { kind: "ok", console: view("scheduled") },
      statistics: noLotStatistics,
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
      statistics: noLotStatistics,
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
    const { run } = fake({
      read: { kind: "meetup-not-found" },
      statistics: { kind: "meetup-not-found" },
    });

    await expect(
      run({ ...call, intent: "view-auction-console" }),
    ).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "not-administrator",
    });
  });

  it("refuses the whole console when the statistics read is unavailable", async () => {
    const { run } = fake({
      statistics: { kind: "unavailable", cause: new Error("offline") },
    });

    await expect(
      run({ ...call, intent: "view-auction-console" }),
    ).resolves.toMatchObject({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
  });
});

describe("auction week start", () => {
  const call = { identity: admin, auctionId };
  const lot = (
    id: string,
    status: ConsoleLot["lot"]["status"],
  ): ConsoleLot => ({
    lot: { lotId: id, auctionId, version: 1, proxyEnabled: false, status },
    bidCount: 0,
    uniqueParticipantCount: 0,
    markedForFinal: false,
    overdue: false,
  });
  const priced = lot(lotId, {
    kind: "scheduled",
    startingPrice: { minorUnits: 50_000, currency: "RUB" },
  });
  const unpriced = lot("01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d", {
    kind: "draft",
  });
  const prepare = (console: AuctionConsoleView) =>
    fake({
      read: { kind: "ok", console },
      statistics: {
        kind: "ok",
        lots: console.lots.map((each) => ({
          lotId: each.lot.lotId,
          bidCount: each.bidCount,
          uniqueParticipantCount: each.uniqueParticipantCount,
        })),
      },
    }).run({
      ...call,
      intent: "prepare-auction-week-start",
      opId,
    });

  it("confirms the start with the number of lots that open and that stay without trading", async () => {
    await expect(
      prepare(
        view("scheduled", {
          week: { ...week, final: true },
          lots: [priced, unpriced],
        }),
      ),
    ).resolves.toMatchObject({
      kind: "auction-week-confirm",
      opId,
      opening: 1,
      idle: 1,
    });
  });

  it.each([
    [
      "an ended week",
      view("scheduled", {
        week: {
          opensAt: week.opensAt,
          closesAt: "2026-10-06T08:00:00Z",
          final: true,
          windows: [],
        },
        lots: [priced],
      }),
      "week-ended",
    ],
    [
      "a registry without priced lots",
      view("scheduled", { week: { ...week, final: true }, lots: [unpriced] }),
      "no-lots-to-open",
    ],
    ["a draft", view("draft"), "week-not-scheduled"],
    ["an opened week", view("prebidding"), "week-already-open"],
  ] as const)(
    "names the reason instead of a confirmation for %s",
    async (_name, console, note) => {
      await expect(prepare(console)).resolves.toMatchObject({
        kind: "auction-console",
        note,
      });
    },
  );

  it("asks the dates only while they can change", async () => {
    const draft = fake({ statistics: noLotStatistics });
    const opened = fake({
      read: { kind: "ok", console: view("prebidding") },
      statistics: noLotStatistics,
    });

    await expect(
      draft.run({ ...call, intent: "ask-auction-week" }),
    ).resolves.toEqual({ kind: "auction-week-ask", auctionId });
    await expect(
      opened.run({ ...call, intent: "ask-auction-week" }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-frozen" });
  });
});

describe("auction discard", () => {
  const call = { identity: admin, auctionId };

  it("confirms the discard with the number of lots while the week is not open", async () => {
    const { run } = fake({ statistics: noLotStatistics });

    await expect(
      run({ ...call, intent: "prepare-auction-discard", opId }),
    ).resolves.toEqual({
      kind: "auction-discard-confirm",
      auctionId,
      opId,
      lots: 0,
    });
  });

  it("names an opened week instead of a confirmation", async () => {
    const { run } = fake({
      read: { kind: "ok", console: view("prebidding") },
      statistics: noLotStatistics,
    });

    await expect(
      run({ ...call, intent: "prepare-auction-discard", opId }),
    ).resolves.toMatchObject({
      kind: "auction-console",
      note: "discard-too-late",
    });
  });

  it("answers a discarded auction and names a week that opened in between", async () => {
    const accepted = fake({});
    const late = fake({
      discard: { kind: "already-started" },
      read: { kind: "ok", console: view("prebidding") },
      statistics: noLotStatistics,
    });

    await expect(
      accepted.run({ ...call, intent: "discard-auction", opId }),
    ).resolves.toEqual({ kind: "auction-discarded", auctionId });
    await expect(
      late.run({ ...call, intent: "discard-auction", opId }),
    ).resolves.toMatchObject({ note: "discard-too-late" });
  });

  it("refuses the discard as the console when Auction does not take the person for the administrator or lacks the auction", async () => {
    const forbidden = fake({ discard: { kind: "not-administrator" } });
    const missing = fake({ discard: { kind: "auction-not-found" } });

    await expect(
      forbidden.run({ ...call, intent: "discard-auction", opId }),
    ).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "not-administrator",
    });
    await expect(
      missing.run({ ...call, intent: "discard-auction", opId }),
    ).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "auction-not-found",
    });
  });
});

describe("final of the auctioneer", () => {
  const call = { identity: admin, auctionId };
  const second = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
  const freshOpId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34bb";
  const sale = { kind: "sale" as const, minorUnits: 100_000 };
  const noSale = { kind: "no-sale" as const };
  const leaderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ee";
  const rub = (rubles: number): Money => ({
    minorUnits: rubles * 100,
    currency: "RUB",
  });
  const entry = (
    id: string,
    status: ConsoleLot["lot"]["status"],
    nextPrice?: Money,
  ): ConsoleLot => ({
    lot: {
      lotId: id,
      auctionId,
      version: 3,
      proxyEnabled: false,
      card: { title: id === lotId ? "Картина" : "Ваза", description: "" },
      ...(nextPrice === undefined ? {} : { nextPrice }),
      status,
    },
    bidCount: 2,
    uniqueParticipantCount: 2,
    markedForFinal: true,
    overdue: false,
  });
  const live = (leader?: string) =>
    entry(
      lotId,
      {
        kind: "trading",
        currentPrice: rub(1_000),
        ...(leader === undefined ? {} : { leaderId: leader }),
        phase: "live",
      },
      rub(1_100),
    );
  const held = entry(second, { kind: "held", currentPrice: rub(700) });
  const final = (lots: readonly ConsoleLot[], active?: string) =>
    view("final", {
      lineup: {
        order: [lotId, second],
        ...(active === undefined ? {} : { activeLotId: active }),
      },
      lots,
    });
  const statisticsOf = (console: AuctionConsoleView) => ({
    kind: "ok" as const,
    lots: console.lots.map((each) => ({
      lotId: each.lot.lotId,
      bidCount: each.bidCount,
      uniqueParticipantCount: each.uniqueParticipantCount,
    })),
  });
  const running = (
    console: AuctionConsoleView,
    answers: Parameters<typeof fake>[0] = {},
  ) =>
    fake({
      read: { kind: "ok", console },
      statistics: statisticsOf(console),
      ...answers,
    });

  it("shows the price, the leader and the latest bids of the active lot", async () => {
    const console = final([live(leaderId), held], lotId);
    const { run } = running(console, {
      bids: {
        kind: "ok",
        bids: [
          { amount: rub(1_000), participantId: leaderId },
          { amount: rub(900), participantId: "someone else" },
        ],
        names: { [leaderId]: "Бэтмен" },
      },
    });

    await expect(
      run({ ...call, intent: "view-auction-console" }),
    ).resolves.toEqual({
      kind: "auction-console",
      console: {
        ...console,
        trading: {
          lotId,
          bids: [{ amount: rub(1_000), name: "Бэтмен" }, { amount: rub(900) }],
          leaderName: "Бэтмен",
        },
      },
    });
  });

  it("starts the final and names a repeated start by the state", async () => {
    const frozen = view("lineup-frozen", {
      lineup: { order: [lotId, second] },
      lots: [held],
    });
    const accepted = running(frozen);
    const repeated = running(final([held]), {
      startFinal: { kind: "lineup-not-frozen" },
    });
    const early = running(view("break"), {
      startFinal: { kind: "lineup-not-frozen" },
    });

    await expect(
      accepted.run({ ...call, intent: "start-auction-final", opId }),
    ).resolves.toMatchObject({
      console: { status: "final" },
      note: "final-started",
    });
    await expect(
      repeated.run({ ...call, intent: "start-auction-final", opId }),
    ).resolves.toMatchObject({ note: "final-started" });
    await expect(
      early.run({ ...call, intent: "start-auction-final", opId }),
    ).resolves.toMatchObject({ note: "lineup-not-frozen" });
  });

  it("picks the lineup order lot by lot and confirms it once one lot is left", async () => {
    const first = entry(lotId, { kind: "held", currentPrice: rub(1_000) });
    const onBreak = view("break", { lots: [held, first] });
    const print = lineupPrint([first, held]);
    const { run } = running(onBreak);

    await expect(
      run({ ...call, intent: "order-final-lineup", page: 0 }),
    ).resolves.toMatchObject({
      kind: "lineup-order",
      held: [first, held],
      pick: { print, order: [] },
    });
    await expect(
      run({
        ...call,
        intent: "order-final-lineup",
        pick: { print, order: [1] },
        page: 0,
      }),
    ).resolves.toMatchObject({
      kind: "lineup-confirm",
      pick: { print, order: [1, 0] },
    });
    await expect(
      run({
        ...call,
        intent: "order-final-lineup",
        pick: { print: "zzzzz", order: [1] },
        page: 0,
      }),
    ).resolves.toMatchObject({
      kind: "lineup-order",
      pick: { print, order: [] },
      changed: true,
    });
  });

  it("announces the picked order and names a lineup announced already", async () => {
    const first = entry(lotId, { kind: "held", currentPrice: rub(1_000) });
    const onBreak = view("break", { lots: [held, first] });
    const pick = { print: lineupPrint([first, held]), order: [1, 0] };
    const accepted = running(onBreak);
    const late = running(onBreak, { freeze: { kind: "not-in-break" } });
    const frozen = running(
      view("lineup-frozen", {
        lots: [held, first],
        lineup: { order: [second, lotId] },
      }),
    );

    await expect(
      accepted.run({ ...call, intent: "freeze-final-lineup", pick, opId }),
    ).resolves.toMatchObject({ note: "lineup-frozen" });
    expect(accepted.freezes).toEqual([[second, lotId]]);
    await expect(
      late.run({ ...call, intent: "freeze-final-lineup", pick, opId }),
    ).resolves.toMatchObject({ note: "not-in-break" });
    await expect(
      frozen.run({ ...call, intent: "freeze-final-lineup", pick, opId }),
    ).resolves.toMatchObject({ note: "lineup-frozen" });
    expect(frozen.freezes).toEqual([]);
  });

  it("names a break without held lots and a lineup longer than a button holds", async () => {
    const many = Array.from({ length: 25 }, (_, at) =>
      entry(`01929b7e-5c1d-7a3f-8e4b-2d6c9f0a${String(at).padStart(4, "0")}`, {
        kind: "held",
        currentPrice: rub(100),
      }),
    );
    const empty = running(
      view("break", { lots: [{ ...held, markedForFinal: false }] }),
    );
    const long = running(view("break", { lots: many }));

    await expect(
      empty.run({ ...call, intent: "order-final-lineup", page: 0 }),
    ).resolves.toMatchObject({ note: "lineup-empty" });
    await expect(
      long.run({ ...call, intent: "order-final-lineup", page: 0 }),
    ).resolves.toMatchObject({ note: "lineup-too-long" });
  });

  it("opens the next lot over a lagging read and names a lot still trading", async () => {
    const accepted = running(final([live(), held]), {
      nextLot: { kind: "ok", lotId },
    });
    const busy = running(final([live(), held], lotId), {
      nextLot: { kind: "another-lot-active", lotId },
    });

    await expect(
      accepted.run({ ...call, intent: "start-final-lot", opId }),
    ).resolves.toMatchObject({
      kind: "auction-console",
      console: { lineup: { activeLotId: lotId } },
    });
    await expect(
      busy.run({ ...call, intent: "start-final-lot", opId }),
    ).resolves.toMatchObject({ note: "another-lot-active" });
  });

  it("asks the next price with the lot and its current next price", async () => {
    const { run } = running(final([live(), held], lotId));

    await expect(
      run({ ...call, intent: "ask-final-price", position: 0 }),
    ).resolves.toEqual({
      kind: "final-ask",
      auctionId,
      position: 0,
      title: "Картина",
      nextPrice: rub(1_100),
    });
  });

  it("raises the ask in the currency of the lot and shows it at once", async () => {
    const { run, asks } = running(final([live(), held], lotId));

    const result = await run({
      ...call,
      intent: "advance-final-ask",
      position: 0,
      value: "1 500",
      opId,
    });

    expect(asks).toEqual([rub(1_500)]);
    expect(result).toMatchObject({
      kind: "auction-console",
      console: { lots: [{ lot: { nextPrice: rub(1_500) } }, held] },
    });
    expect(result).not.toHaveProperty("note");
  });

  it("asks again with the threshold Auction named for an ask below the current price", async () => {
    const { run } = running(final([live(), held], lotId), {
      ask: { kind: "ask-below-current-price", mustExceed: rub(1_000) },
    });

    await expect(
      run({
        ...call,
        intent: "advance-final-ask",
        position: 0,
        value: "900",
        opId,
      }),
    ).resolves.toEqual({
      kind: "final-ask",
      auctionId,
      position: 0,
      title: "Картина",
      nextPrice: rub(1_100),
      error: "ask-below-current-price",
      mustExceed: rub(1_000),
    });
  });

  it("asks again without Auction for an amount that is not whole rubles", async () => {
    const { run, asks } = running(final([live(), held], lotId));

    await expect(
      run({
        ...call,
        intent: "advance-final-ask",
        position: 0,
        value: "1500,50",
        opId,
      }),
    ).resolves.toMatchObject({ kind: "final-ask", error: "amount-format" });
    expect(asks).toEqual([]);
  });

  it("confirms a sale to the leader at the current price and a close without bids", async () => {
    const sale = running(final([live(leaderId), held], lotId), {
      bids: { kind: "ok", bids: [], names: { [leaderId]: "Бэтмен" } },
    });
    const empty = running(final([live(), held], lotId));

    await expect(
      sale.run({ ...call, intent: "prepare-final-close", position: 0, opId }),
    ).resolves.toEqual({
      kind: "final-close-confirm",
      auctionId,
      position: 0,
      opId,
      title: "Картина",
      price: rub(1_000),
      leaderName: "Бэтмен",
    });
    await expect(
      empty.run({ ...call, intent: "prepare-final-close", position: 0, opId }),
    ).resolves.toEqual({
      kind: "final-close-confirm",
      auctionId,
      position: 0,
      opId,
      title: "Картина",
    });
  });

  it("sells the lot with the key of the confirmation and names the buyer", async () => {
    const { run, closes } = running(final([live(leaderId), held], lotId), {
      close: {
        kind: "ok",
        closure: { kind: "sold", winnerId: leaderId, price: rub(1_000) },
      },
      names: { kind: "ok", names: { [leaderId]: "Бэтмен" } },
    });

    const result = await run({
      ...call,
      intent: "close-final-lot",
      position: 0,
      opId,
      quote: sale,
      freshOpId,
    });

    expect(closes).toEqual([{ auctionId, lotId, opId }]);
    expect(result).toEqual({
      kind: "final-lot-closed",
      auctionId,
      title: "Картина",
      closure: { kind: "sold", price: rub(1_000), buyerName: "Бэтмен" },
    });
  });

  it("keeps the sale when the name of the buyer cannot be read", async () => {
    const { run } = running(final([live(leaderId), held], lotId), {
      close: {
        kind: "ok",
        closure: { kind: "sold", winnerId: leaderId, price: rub(1_000) },
      },
      names: { kind: "unavailable", cause: new Error("names down") },
    });

    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: sale,
        freshOpId,
      }),
    ).resolves.toEqual({
      kind: "final-lot-closed",
      auctionId,
      title: "Картина",
      closure: { kind: "sold", price: rub(1_000) },
    });
  });

  it("closes a lot without bids without a sale", async () => {
    const { run } = running(final([live(), held], lotId));

    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: noSale,
        freshOpId,
      }),
    ).resolves.toEqual({
      kind: "final-lot-closed",
      auctionId,
      title: "Картина",
      closure: { kind: "unsold" },
    });
  });

  it("names a lot closed by another key instead of a second sale", async () => {
    const { run } = running(final([live(), held]), {
      close: { kind: "lot-not-open" },
    });

    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: noSale,
        freshOpId,
      }),
    ).resolves.toMatchObject({ note: "final-lot-closed" });
  });

  it("trades the active lot while the lagging read still holds it", async () => {
    const opened = entry(second, {
      kind: "trading",
      currentPrice: rub(700),
      phase: "live",
    });
    const accepted = running(final([live(), held]), {
      nextLot: { kind: "ok", lotId: second },
    });
    const lagging = running(final([live(), held], second));

    await expect(
      accepted.run({ ...call, intent: "start-final-lot", opId }),
    ).resolves.toMatchObject({
      console: { lineup: { activeLotId: second }, lots: [live(), opened] },
    });
    await expect(
      lagging.run({
        ...call,
        intent: "prepare-final-close",
        position: 1,
        opId,
      }),
    ).resolves.toEqual({
      kind: "final-close-confirm",
      auctionId,
      position: 1,
      opId,
      title: "Ваза",
    });
  });

  it("keeps the console and its commands when the latest bids cannot be read", async () => {
    const { run } = running(final([live(leaderId), held], lotId), {
      bids: { kind: "unavailable", cause: new Error("history down") },
    });

    const result = await run({ ...call, intent: "view-auction-console" });

    expect(result).toMatchObject({ kind: "auction-console" });
    expect(result).not.toHaveProperty("console.trading");
    await expect(
      run({ ...call, intent: "prepare-final-close", position: 0, opId }),
    ).resolves.toMatchObject({
      kind: "final-close-confirm",
      price: rub(1_000),
    });
  });

  it("confirms again instead of selling when a bid came after the confirmation", async () => {
    const { run, closes } = running(final([live(leaderId), held], lotId), {
      names: { kind: "ok", names: { [leaderId]: "Бэтмен" } },
    });

    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: noSale,
        freshOpId,
      }),
    ).resolves.toEqual({
      kind: "final-close-confirm",
      auctionId,
      position: 0,
      opId: freshOpId,
      title: "Картина",
      price: rub(1_000),
      changed: true,
    });
    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: { kind: "sale", minorUnits: 90_000 },
        freshOpId,
      }),
    ).resolves.toMatchObject({ kind: "final-close-confirm", changed: true });
    expect(closes).toEqual([]);
  });

  it("names a finished final for a repeated sale of the last lot", async () => {
    const { run, closes } = running(view("finished", { lots: [held] }));

    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: noSale,
        freshOpId,
      }),
    ).resolves.toMatchObject({ note: "final-finished" });
    expect(closes).toEqual([]);
  });

  it("names a position outside the lineup as a lot not in the auction", async () => {
    const { run, closes } = running(final([live(), held], lotId));

    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 5,
        opId,
        quote: noSale,
        freshOpId,
      }),
    ).resolves.toMatchObject({ note: "lot-not-in-auction" });
    expect(closes).toEqual([]);
  });

  it("refuses the final commands as the console when Auction does not take the person for the administrator", async () => {
    const { run } = running(final([live(), held], lotId), {
      startFinal: { kind: "not-administrator" },
      nextLot: { kind: "not-administrator" },
      ask: { kind: "not-administrator" },
      close: { kind: "not-administrator" },
    });
    const refused = {
      kind: "auction-console-refused",
      reason: "not-administrator",
    };

    await expect(
      run({ ...call, intent: "start-auction-final", opId }),
    ).resolves.toEqual(refused);
    await expect(
      run({ ...call, intent: "start-final-lot", opId }),
    ).resolves.toEqual(refused);
    await expect(
      run({
        ...call,
        intent: "advance-final-ask",
        position: 0,
        value: "1500",
        opId,
      }),
    ).resolves.toEqual(refused);
    await expect(
      run({
        ...call,
        intent: "close-final-lot",
        position: 0,
        opId,
        quote: noSale,
        freshOpId,
      }),
    ).resolves.toEqual(refused);
  });
});

describe("parseWindow", () => {
  it("reads the span in community time and the step in whole rubles", () => {
    expect(
      parseWindow("21.10.2026 18:00 — 21.10.2026 21:00, 50", zone, now),
    ).toEqual({
      kind: "ok",
      from: "2026-10-21T15:00:00Z",
      until: "2026-10-21T18:00:00Z",
      step: { minorUnits: 5_000, currency: "RUB" },
    });
  });

  it.each([
    ["21.10.2026 18:00 — 21.10.2026 21:00", "window-format"],
    ["21.10.2026 21:00 — 21.10.2026 18:00, 50", "window-order"],
    ["05.10.2026 18:00 — 05.10.2026 21:00, 50", "window-ended"],
    ["21.10.2026 18:00 — 21.10.2026 21:00, 50.5", "amount-format"],
    ["21.10.2026 18:00 — 21.10.2026 21:00, 0", "amount-range"],
  ])("refuses «%s» as %s", (raw, error) => {
    expect(parseWindow(raw, zone, now)).toEqual({ kind: "rejected", error });
  });
});

describe("happy hours", () => {
  const call = { identity: admin, auctionId };
  const second = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
  const entry = (id: string): ConsoleLot => ({
    lot: {
      lotId: id,
      auctionId,
      version: 1,
      proxyEnabled: false,
      status: { kind: "draft" },
    },
    bidCount: 0,
    uniqueParticipantCount: 0,
    markedForFinal: false,
    overdue: false,
  });
  const lots = [entry(lotId), entry(second)];
  const statistics: LotStatisticsReadResult = {
    kind: "ok",
    lots: lots.map((each) => ({
      lotId: each.lot.lotId,
      bidCount: 0,
      uniqueParticipantCount: 0,
    })),
  };
  const evening: StepWindow = {
    from: "2026-10-21T15:00:00Z",
    until: "2026-10-21T18:00:00Z",
    step: { minorUnits: 5_000, currency: "RUB" },
    lotIds: [lotId, second],
  };
  const night: StepWindow = {
    ...evening,
    from: "2026-10-22T15:00:00Z",
    until: "2026-10-22T18:00:00Z",
  };
  const scheduledWith = (windows: readonly StepWindow[]) =>
    view("scheduled", { week: { ...week, final: true, windows }, lots });
  const ref = (window: StepWindow, index: number) => ({
    index,
    print: windowPrint(window),
  });

  it("prints a window by its span and step, not by its lots", () => {
    expect(windowPrint(evening)).toMatch(/^[0-9a-z]{5}$/);
    expect(windowPrint({ ...evening, lotIds: [lotId] })).toBe(
      windowPrint(evening),
    );
    expect(windowPrint(night)).not.toBe(windowPrint(evening));
  });

  it("keeps the windows when the dates and the final change", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith([evening]) },
      statistics,
    });

    await run({
      ...call,
      intent: "schedule-auction-week",
      value: "20.10.2026 18:00 — 28.10.2026 00:00",
      opId,
    });
    await run({ ...call, intent: "set-auction-final", final: false, opId });

    expect(scheduled.map((config) => config.windows)).toEqual([
      [evening],
      [evening],
    ]);
  });

  it("asks the dates again naming the window the new dates cut off", async () => {
    const { run } = fake({
      read: { kind: "ok", console: scheduledWith([evening, night]) },
      statistics,
      schedule: { kind: "window-outside-week", window: 1 },
    });

    await expect(
      run({
        ...call,
        intent: "schedule-auction-week",
        value: "20.10.2026 18:00 — 22.10.2026 00:00",
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "auction-week-ask",
      error: "week-cuts-window",
      window: 2,
    });
  });

  it("adds a window with every lot of the registry", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith([]) },
      statistics,
    });

    const result = await run({
      ...call,
      intent: "add-step-window",
      value: "21.10.2026 18:00 — 21.10.2026 21:00, 50",
      opId,
    });

    expect(scheduled).toEqual([
      { auctionId, opId, ...week, final: true, windows: [evening] },
    ]);
    expect(result).toEqual({
      kind: "step-windows",
      console: scheduledWith([evening]),
      note: { kind: "saved", window: 1 },
    });
  });

  it.each([
    [
      { kind: "window-outside-week", window: 1 } as const,
      { error: "window-outside-week" },
    ],
    [
      { kind: "windows-overlap", first: 0, second: 1 } as const,
      { error: "window-overlap", window: 1 },
    ],
    [
      { kind: "window-step-invalid", window: 1 } as const,
      { error: "window-step" },
    ],
  ])(
    "asks the window again when Auction refuses it: %o",
    async (refusal, asked) => {
      const { run } = fake({
        read: { kind: "ok", console: scheduledWith([evening]) },
        statistics,
        schedule: refusal,
      });

      await expect(
        run({
          ...call,
          intent: "add-step-window",
          value: "21.10.2026 19:00 — 21.10.2026 22:00, 50",
          opId,
        }),
      ).resolves.toEqual({
        kind: "step-window-ask",
        auctionId,
        week: { ...week, final: true, windows: [evening] },
        ...asked,
      });
    },
  );

  it("refuses a window over the limit of the console without a command", async () => {
    const full = Array.from({ length: windowLimit }, (_, day) => ({
      ...evening,
      from: `2026-10-2${day}T15:00:00Z`,
      until: `2026-10-2${day}T16:00:00Z`,
    }));
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith(full) },
      statistics,
    });

    await expect(
      run({ ...call, intent: "ask-step-window" }),
    ).resolves.toMatchObject({ note: { kind: "limit" } });
    await expect(
      run({
        ...call,
        intent: "add-step-window",
        value: "26.10.2026 18:00 — 26.10.2026 21:00, 50",
        opId,
      }),
    ).resolves.toMatchObject({ note: { kind: "limit" } });
    expect(scheduled).toEqual([]);
  });

  it("does not ask for a window without lots or without dates", async () => {
    const empty = fake({
      read: {
        kind: "ok",
        console: view("scheduled", {
          week: { ...week, final: true, windows: [] },
        }),
      },
      statistics: noLotStatistics,
    });
    const draft = fake({ statistics: noLotStatistics });

    await expect(
      empty.run({ ...call, intent: "ask-step-window" }),
    ).resolves.toMatchObject({ note: { kind: "no-lots" } });
    await expect(
      draft.run({ ...call, intent: "ask-step-window" }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-needed" });
  });

  it("takes a lot out of the window and shows its page with a toast", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith([evening]) },
      statistics,
    });

    const result = await run({
      ...call,
      intent: "set-step-window-lot",
      window: ref(evening, 0),
      lotId: second,
      selected: false,
      opId,
    });

    expect(scheduled.map((config) => config.windows)).toEqual([
      [{ ...evening, lotIds: [lotId] }],
    ]);
    expect(result).toEqual({
      kind: "step-window",
      console: scheduledWith([{ ...evening, lotIds: [lotId] }]),
      index: 0,
      at: { lotId: second },
      toggled: { selected: false },
    });
  });

  it("keeps the last lot of a window and a lot already in its target state without a command", async () => {
    const single = { ...evening, lotIds: [lotId] };
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith([single]) },
      statistics,
    });

    await expect(
      run({
        ...call,
        intent: "set-step-window-lot",
        window: ref(single, 0),
        lotId,
        selected: false,
        opId,
      }),
    ).resolves.toMatchObject({ note: { kind: "last-lot", window: 1 } });
    await expect(
      run({
        ...call,
        intent: "set-step-window-lot",
        window: ref(single, 0),
        lotId,
        selected: true,
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "step-window",
      toggled: { selected: true },
    });
    expect(scheduled).toEqual([]);
  });

  it("names the overlapping window when a lot joins a window that crosses another", async () => {
    const crossing = { ...night, from: evening.from, lotIds: [lotId] };
    const { run } = fake({
      read: {
        kind: "ok",
        console: scheduledWith([{ ...evening, lotIds: [second] }, crossing]),
      },
      statistics,
      schedule: { kind: "windows-overlap", first: 0, second: 1 },
    });

    await expect(
      run({
        ...call,
        intent: "set-step-window-lot",
        window: ref(evening, 0),
        lotId,
        selected: true,
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "step-windows",
      note: { kind: "overlap", window: 1, other: 2 },
    });
  });

  it("removes a window and refuses a button whose window has moved", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith([evening, night]) },
      statistics,
    });

    await expect(
      run({
        ...call,
        intent: "remove-step-window",
        window: ref(evening, 0),
        opId,
      }),
    ).resolves.toEqual({
      kind: "step-windows",
      console: scheduledWith([night]),
      note: { kind: "removed", window: 1 },
    });
    // Кнопка «Окно 2» со старого экрана, где вторым было вечернее окно.
    await expect(
      run({
        ...call,
        intent: "remove-step-window",
        window: ref(evening, 1),
        opId,
      }),
    ).resolves.toMatchObject({ note: { kind: "changed" } });
    expect(scheduled.map((config) => config.windows)).toEqual([[night]]);
  });

  it("does not change the windows of an opened week", async () => {
    const { run, scheduled } = fake({
      read: {
        kind: "ok",
        console: view("prebidding", {
          week: { ...week, final: true, windows: [evening] },
          lots,
        }),
      },
      statistics,
    });

    await expect(
      run({
        ...call,
        intent: "remove-step-window",
        window: ref(evening, 0),
        opId,
      }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-frozen" });
    expect(scheduled).toEqual([]);
  });
});

// Розыгрыш (PER-593): момент закрытия регистрации задаётся своим вопросом на
// пульте, лежит строго внутри недели и едет в каждой команде над
// конфигурацией — без него Auction стёр бы розыгрыш молча.
describe("parseRaffle", () => {
  const span = { opensAt: week.opensAt, closesAt: week.closesAt };

  it("reads the moment in community time inside the week", () => {
    expect(parseRaffle(" 22.10.2026 18:00 ", span, zone, now)).toEqual({
      kind: "ok",
      raffleClosesAt: "2026-10-22T15:00:00Z",
    });
  });

  it.each([
    ["в среду вечером", "raffle-format"],
    ["31.10.2026 24:00", "raffle-format"],
    ["30.02.2026 18:00", "raffle-format"],
    ["20.10.2026 18:00", "raffle-not-after-opens"],
    ["27.10.2026 00:00", "raffle-not-before-closes"],
  ] as const)("refuses %s as %s", (raw, error) => {
    expect(parseRaffle(raw, span, zone, now)).toEqual({
      kind: "rejected",
      error,
    });
  });

  it("refuses a time the clocks skipped and a moment that has already come", () => {
    expect(
      parseRaffle(
        "29.03.2026 02:30",
        { opensAt: "2026-03-28T00:00:00Z", closesAt: "2026-04-05T00:00:00Z" },
        "Europe/Berlin",
        new Date("2026-03-01T00:00:00Z"),
      ),
    ).toEqual({ kind: "rejected", error: "raffle-moment" });
    expect(
      parseRaffle(
        "06.10.2026 11:00",
        { opensAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-10T00:00:00Z" },
        zone,
        now,
      ),
    ).toEqual({ kind: "rejected", error: "raffle-ended" });
  });
});

describe("raffle of the week", () => {
  const call = { identity: admin, auctionId };
  const moment = "2026-10-22T15:00:00Z";
  const evening: StepWindow = {
    from: "2026-10-21T15:00:00Z",
    until: "2026-10-21T18:00:00Z",
    step: { minorUnits: 5_000, currency: "RUB" },
    lotIds: [lotId],
  };
  const lot: ConsoleLot = {
    lot: {
      lotId,
      auctionId,
      version: 1,
      proxyEnabled: false,
      status: { kind: "draft" },
    },
    bidCount: 0,
    uniqueParticipantCount: 0,
    markedForFinal: false,
    overdue: false,
  };
  const statistics: LotStatisticsReadResult = {
    kind: "ok",
    lots: [{ lotId, bidCount: 0, uniqueParticipantCount: 0 }],
  };
  const scheduledWith = (raffleClosesAt?: string) =>
    view("scheduled", {
      week: {
        ...week,
        final: true,
        windows: [evening],
        ...(raffleClosesAt === undefined ? {} : { raffleClosesAt }),
      },
      lots: [lot],
    });

  it("asks the moment naming the week only while the dates are set and can change", async () => {
    await expect(
      fake({
        read: { kind: "ok", console: scheduledWith(moment) },
        statistics,
      }).run({ ...call, intent: "ask-auction-raffle" }),
    ).resolves.toEqual({
      kind: "auction-raffle-ask",
      auctionId,
      week: {
        ...week,
        final: true,
        windows: [evening],
        raffleClosesAt: moment,
      },
    });
    await expect(
      fake({
        read: { kind: "ok", console: view("draft") },
        statistics: noLotStatistics,
      }).run({ ...call, intent: "ask-auction-raffle" }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-needed" });
    await expect(
      fake({
        read: {
          kind: "ok",
          console: view("prebidding", {
            week: { ...week, final: true, raffleClosesAt: moment },
          }),
        },
        statistics: noLotStatistics,
      }).run({ ...call, intent: "ask-auction-raffle" }),
    ).resolves.toMatchObject({ kind: "auction-console", note: "week-frozen" });
  });

  it("schedules the moment with the dates, the final and the windows and shows it over a lagging read", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith() },
      statistics,
    });

    const result = await run({
      ...call,
      intent: "set-auction-raffle",
      value: "22.10.2026 18:00",
      opId,
    });

    expect(scheduled).toEqual([
      {
        auctionId,
        opId,
        ...week,
        final: true,
        windows: [evening],
        raffleClosesAt: moment,
      },
    ]);
    expect(result).toMatchObject({
      kind: "auction-console",
      note: "raffle-saved",
      console: { week: { raffleClosesAt: moment } },
    });
  });

  it("asks again without a command for a moment outside the week and with Auction's refusal after a move of the dates", async () => {
    const outside = fake({
      read: { kind: "ok", console: scheduledWith() },
      statistics,
    });
    await expect(
      outside.run({
        ...call,
        intent: "set-auction-raffle",
        value: "28.10.2026 18:00",
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "auction-raffle-ask",
      error: "raffle-not-before-closes",
    });
    expect(outside.scheduled).toEqual([]);

    // Сроки сдвинул второй администратор: чтение их не видело, Auction —
    // видит, и его отказ — тот же ответ.
    await expect(
      fake({
        read: { kind: "ok", console: scheduledWith() },
        statistics,
        schedule: { kind: "raffle-not-after-opens" },
      }).run({
        ...call,
        intent: "set-auction-raffle",
        value: "22.10.2026 18:00",
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "auction-raffle-ask",
      error: "raffle-not-after-opens",
    });
  });

  it("removes the moment, and a moment already gone takes no command", async () => {
    const set = fake({
      read: { kind: "ok", console: scheduledWith(moment) },
      statistics,
    });
    const removed = await set.run({
      ...call,
      intent: "remove-auction-raffle",
      opId,
    });
    expect(set.scheduled).toEqual([
      {
        auctionId,
        opId,
        ...week,
        final: true,
        windows: [evening],
        raffleClosesAt: undefined,
      },
    ]);
    expect(removed).toMatchObject({
      kind: "auction-console",
      note: "raffle-removed",
    });
    expect(
      removed.kind === "auction-console" && removed.console.week,
    ).not.toHaveProperty("raffleClosesAt");

    const gone = fake({
      read: { kind: "ok", console: scheduledWith() },
      statistics,
    });
    await expect(
      gone.run({ ...call, intent: "remove-auction-raffle", opId }),
    ).resolves.toMatchObject({
      kind: "auction-console",
      note: "raffle-removed",
    });
    expect(gone.scheduled).toEqual([]);
  });

  it("keeps the moment when the dates, the final and the windows change", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith(moment) },
      statistics,
    });

    await run({
      ...call,
      intent: "schedule-auction-week",
      value: "20.10.2026 18:00 — 28.10.2026 00:00",
      opId,
    });
    await run({ ...call, intent: "set-auction-final", final: false, opId });
    await run({
      ...call,
      intent: "remove-step-window",
      window: { index: 0, print: windowPrint(evening) },
      opId,
    });

    expect(scheduled.map((config) => config.raffleClosesAt)).toEqual([
      moment,
      moment,
      moment,
    ]);
  });

  it("asks the dates again when the new dates cut the moment off instead of dropping it", async () => {
    const { run, scheduled } = fake({
      read: { kind: "ok", console: scheduledWith(moment) },
      statistics,
      schedule: { kind: "raffle-not-after-opens" },
    });

    await expect(
      run({
        ...call,
        intent: "schedule-auction-week",
        value: "23.10.2026 18:00 — 28.10.2026 00:00",
        opId,
      }),
    ).resolves.toMatchObject({
      kind: "auction-week-ask",
      error: "week-cuts-raffle",
    });
    expect(scheduled.map((config) => config.raffleClosesAt)).toEqual([moment]);
  });
});
