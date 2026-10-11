import { describe, expect, it } from "vitest";
import type { Money } from "../../../auction-ui/index.js";
import type {
  AdvanceAskResult,
  AuctionConsoles,
  AuctionWeekConfig,
  CloseLotResult,
  ConsoleReadResult,
  DiscardAuctionResult,
  FinalBidsResult,
  FinalistResult,
  FinalLotCommand,
  LotStatisticsReadResult,
  ScheduleAuctionResult,
  StartFinalResult,
  StartNextLotResult,
  StartPrebiddingResult,
} from "../auction/port.js";
import { createAuctionConsole, parseWeek } from "./auction-console.js";
import type { AuctionConsoleView, ConsoleLot, Person } from "./types.js";

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
  startFinal?: StartFinalResult;
  nextLot?: StartNextLotResult;
  ask?: AdvanceAskResult;
  close?: CloseLotResult;
  bids?: FinalBidsResult;
}) {
  const scheduled: AuctionWeekConfig[] = [];
  const asks: Money[] = [];
  const closes: FinalLotCommand[] = [];
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
  };
  return {
    run: createAuctionConsole(port, zone, () => now),
    scheduled,
    asks,
    closes,
  };
}

describe("parseWeek", () => {
  it.each([
    "20.10.2026 18:00 — 27.10.2026 00:00",
    "20.10.2026 18:00 - 27.10.2026 00:00",
    "20.10.2026 18:00–27.10.2026 00:00",
    "  20.10.2026 18:00 27.10.2026 00:00 ",
  ])("reads «%s» in community time", (raw) => {
    expect(parseWeek(raw, zone, now)).toEqual({ kind: "ok", ...week });
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
      bids: { kind: "ok", bids: [], names: { [leaderId]: "Бэтмен" } },
    });

    const result = await run({
      ...call,
      intent: "close-final-lot",
      position: 0,
      opId,
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
    });

    await expect(
      run({ ...call, intent: "close-final-lot", position: 0, opId }),
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
      run({ ...call, intent: "close-final-lot", position: 0, opId }),
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
      run({ ...call, intent: "close-final-lot", position: 0, opId }),
    ).resolves.toMatchObject({ note: "final-lot-closed" });
  });

  it("names a position outside the lineup as a lot not in the auction", async () => {
    const { run, closes } = running(final([live(), held], lotId));

    await expect(
      run({ ...call, intent: "close-final-lot", position: 5, opId }),
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
      run({ ...call, intent: "close-final-lot", position: 0, opId }),
    ).resolves.toEqual(refused);
  });
});
