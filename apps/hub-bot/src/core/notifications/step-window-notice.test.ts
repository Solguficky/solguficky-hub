import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { StepWindowStartedSchema } from "../../../gen/notifications/v1/notifications_pb.js";
import { money } from "../format.js";
import { DIGEST_LOT_LIMIT } from "./lot-notice.js";
import {
  createStepWindowNoticeRender,
  renderStepWindowNotice,
  type StepWindowNotice,
  stepWindowNoticeOf,
} from "./step-window-notice.js";

const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
const lot = (n: number) =>
  `0198f2a4-7c1e-7d3a-9b21-${String(n).padStart(12, "0")}`;
const until = "2026-10-21T21:00:00Z";
const startsAt = "2026-10-21T19:00:00Z";
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

// Один валидный образец, отличия — переопределением: отличие от нормы и есть
// суть теста (docs/standards/testing/testing-strategy.md).
type LotInit = {
  lotId: string;
  until: string;
  step?: { minorUnits: bigint; currency?: string };
};

const validLot = (n = 1): LotInit => ({
  lotId: lot(n),
  until,
  step: { minorUnits: BigInt(n * 50_000), currency: "RUB" },
});

const fact = (
  lots: LotInit[] = [validLot()],
  overrides: { auctionId?: string; startsAt?: string } = {},
) =>
  create(StepWindowStartedSchema, {
    auctionId: overrides.auctionId ?? auctionId,
    startsAt: overrides.startsAt ?? startsAt,
    lots,
  });

const notice = (lots = [1]): StepWindowNotice => ({
  kind: "step-window-started",
  auctionId,
  lots: lots.map((n) => ({
    lotId: lot(n),
    until,
    step: rub(n * 500),
  })),
});

const context = { recipientId: lot(42), requestId: "r-1" };

describe("stepWindowNoticeOf", () => {
  it("carries the lots of the window with the step and the end of each", () => {
    expect(stepWindowNoticeOf(fact([validLot(1), validLot(2)]))).toEqual({
      kind: "step-window-started",
      auctionId,
      lots: [
        { lotId: lot(1), until, step: rub(500) },
        { lotId: lot(2), until, step: rub(1_000) },
      ],
    });
  });

  // Дефекты издателя: из такого факта не собрать ни кнопку, ни правдивый текст.
  it.each([
    ["no lots at all", fact([])],
    [
      "an auction id not in canonical form",
      fact([validLot()], { auctionId: "auction" }),
    ],
    [
      "a lot id not in canonical form",
      fact([{ ...validLot(), lotId: lot(1).toUpperCase() }]),
    ],
    [
      "a step without a currency",
      fact([{ lotId: lot(1), until, step: { minorUnits: 1n } }]),
    ],
    [
      "an end of the window that is not a moment",
      fact([{ ...validLot(), until: "вечером" }]),
    ],
    [
      "a date without a time as the end of the window",
      fact([{ ...validLot(), until: "2026-10-21" }]),
    ],
    [
      "a start of the window that is not a moment",
      fact([validLot()], { startsAt: "вечером" }),
    ],
    [
      "an end of the window before its start",
      fact([{ ...validLot(), until: "2026-10-21T18:00:00Z" }]),
    ],
    ["the same lot twice", fact([validLot(), validLot()])],
  ])("rejects %s", (_, value) => {
    expect(stepWindowNoticeOf(value)).toBeUndefined();
  });
});

describe("renderStepWindowNotice", () => {
  const lots = new Map([
    [lot(1), { title: "Кружка" }],
    [lot(2), { title: "Банка солёных грибов" }],
  ]);

  // Текст вести — исключение из «одной фразы», по образцу анонса состава и
  // сводки: первая строка, пустая строка и строки по лоту.
  it("names the window, its step, its end and the lot", () => {
    const view = renderStepWindowNotice(notice(), { lots, timeZone: "UTC" });
    expect(view.text).toBe(
      [
        "Счастливые часы начались:",
        "",
        `• «Кружка» — шаг ${money(rub(500))} до 21:00`,
      ].join("\n"),
    );
  });

  it("gives a row to the card of every lot of the window", () => {
    const view = renderStepWindowNotice(notice([1, 2]), {
      lots,
      timeZone: "UTC",
    });
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId: lot(1), text: "Кружка" }],
      [{ kind: "lot", lotId: lot(2), text: "Банка солёных грибов" }],
    ]);
  });

  // Кнопки частоты под вестью нет: повод выключается снятием отметки.
  it("has no frequency button under the notice", () => {
    const view = renderStepWindowNotice(notice(), { lots, timeZone: "UTC" });
    expect(view.rows.flat().map((button) => button.kind)).toEqual(["lot"]);
  });

  // Без названия строка остаётся с шагом и концом окна, а кнопка — «К лоту»;
  // лот, который Auction окончательно не отдал, кнопки не получает.
  it("keeps untitled lines and drops the button of a refused lot", () => {
    const view = renderStepWindowNotice(notice([1, 2]), {
      lots: new Map(),
      refused: new Set([lot(1)]),
      timeZone: "UTC",
    });
    expect(view.text).toContain(`• Лот — шаг ${money(rub(500))} до 21:00`);
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId: lot(2), text: "К лоту" }],
    ]);
  });

  it("names the lots beyond the limit by number", () => {
    const many = notice(
      Array.from({ length: DIGEST_LOT_LIMIT + 3 }, (_, n) => n + 1),
    );
    const lines = renderStepWindowNotice(many, {
      lots: new Map(),
      timeZone: "UTC",
    }).text.split("\n");
    expect(lines.filter((line) => line.startsWith("• "))).toHaveLength(
      DIGEST_LOT_LIMIT,
    );
    expect(lines.at(-1)).toBe("…и ещё лотов: 3.");
  });

  // Конец окна читается по часам сообщества, а не по часам сервера.
  it("names the end of the window in the community time zone", () => {
    const view = renderStepWindowNotice(notice(), {
      lots,
      timeZone: "Europe/Moscow",
    });
    expect(view.text).toContain("до 00:00");
  });
});

describe("createStepWindowNoticeRender", () => {
  const permanent = Object.assign(new Error("not found"), { code: 5 });

  it("reads the titles of the lots under the recipient's right", async () => {
    const lotInfo = vi.fn(async (_: string, lotId: string) => ({
      title: lotId === lot(1) ? "Кружка" : "Банка",
    }));
    const render = createStepWindowNoticeRender({
      reads: { holdsPlaceBids: async () => true, lotInfo },
      onTitleMissing: () => {},
      timeZone: "UTC",
    });
    const result = await render(notice([1]), context);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.message.text).toContain("«Кружка»");
    expect(lotInfo).toHaveBeenCalledWith(lot(42), lot(1), "r-1");
  });

  // Названия читаются только у показанных лотов: окно может накрыть больше,
  // чем помещается в сообщение, а лишние чтения — это лишние вызовы Auction.
  it("reads the titles of the shown lots only", async () => {
    const lotInfo = vi.fn(async () => ({ title: "Кружка" }));
    const render = createStepWindowNoticeRender({
      reads: { holdsPlaceBids: async () => true, lotInfo },
      onTitleMissing: () => {},
      timeZone: "UTC",
    });
    const many = notice(
      Array.from({ length: DIGEST_LOT_LIMIT + 3 }, (_, n) => n + 1),
    );
    const result = await render(many, context);
    expect(result.kind).toBe("ready");
    expect(lotInfo).toHaveBeenCalledTimes(DIGEST_LOT_LIMIT);
  });

  // Весть о торгах: без права `place-bids` она не уходит, как вести о лотах.
  it("withholds the notice from a recipient without the right", async () => {
    const lotInfo = vi.fn();
    const render = createStepWindowNoticeRender({
      reads: { holdsPlaceBids: async () => false, lotInfo },
      onTitleMissing: () => {},
      timeZone: "UTC",
    });
    await expect(render(notice(), context)).resolves.toEqual({
      kind: "ineligible",
    });
    expect(lotInfo).not.toHaveBeenCalled();
  });

  // Лот, которого уже нет, остальные строки не роняет: строка уходит без
  // названия и без кнопки, а отказ пишется в лог.
  it("keeps the line of a refused lot and logs the refusal", async () => {
    const onTitleMissing = vi.fn();
    const render = createStepWindowNoticeRender({
      reads: {
        holdsPlaceBids: async () => true,
        lotInfo: async (_, lotId) => {
          if (lotId === lot(1)) throw permanent;
          return { title: "Банка" };
        },
      },
      onTitleMissing,
      timeZone: "UTC",
    });
    const result = await render(notice([1, 2]), context);
    expect(result).toMatchObject({
      kind: "ready",
      message: { rows: [[{ kind: "lot", lotId: lot(2), text: "Банка" }]] },
    });
    expect(result.kind === "ready" && result.message.text).toContain("• Лот —");
    expect(onTitleMissing).toHaveBeenCalledWith(permanent, "r-1");
  });

  // Недоступный Auction названий не роняет: весть ценна вовремя.
  it("keeps the notice without titles when Auction is unavailable", async () => {
    const onTitleMissing = vi.fn();
    const render = createStepWindowNoticeRender({
      reads: {
        holdsPlaceBids: async () => true,
        lotInfo: async () => {
          throw new Error("auction unavailable");
        },
      },
      onTitleMissing,
      timeZone: "UTC",
    });
    const result = await render(notice(), context);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.message.text).toContain("• Лот —");
    expect(onTitleMissing).toHaveBeenCalled();
  });

  // Бота без Auction названия не читает: весть уходит без них.
  it("keeps the notice without titles when there are no reads", async () => {
    const render = createStepWindowNoticeRender({
      reads: undefined,
      onTitleMissing: () => {},
      timeZone: "UTC",
    });
    const result = await render(notice(), context);
    expect(result).toMatchObject({ kind: "ready" });
    if (result.kind !== "ready") return;
    expect(result.message.text).toContain("• Лот —");
  });
});
