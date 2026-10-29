import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionFinalLineupSchema,
  AuctionFinalStartedSchema,
  AuctionLotSoldInFinalSchema,
  AuctionPrebiddingEndedSchema,
} from "../../../gen/notifications/v1/notifications_pb.js";
import { money } from "../format.js";
import {
  createFinalNoticeRender,
  type FinalNotice,
  finalNoticeOf,
  LINEUP_LOT_LIMIT,
  LINEUP_LOT_TTL_MS,
  renderFinalNotice,
} from "./final-notice.js";
import type { LotNoticeReads } from "./lot-notice.js";

const auctionId = "5f0c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b";
const lot = (n: number) =>
  `0198f2a4-7c1e-7d3a-9b21-${String(n).padStart(12, "0")}`;
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

const lineupFact = (yourLotIds: string[] = [], lots = [1, 2]) => ({
  case: "auctionFinalLineup" as const,
  value: create(AuctionFinalLineupSchema, {
    auctionId,
    meetupId: lot(99),
    lineup: lots.map((n) => ({
      lotId: lot(n),
      price: { minorUnits: BigInt(n * 100_000), currency: "RUB" },
    })),
    yourLotIds,
  }),
});

const lineup = (
  yourLotIds: string[] = [],
): Extract<FinalNotice, { kind: "final-lineup" }> => ({
  kind: "final-lineup",
  auctionId,
  lineup: [
    { lotId: lot(1), price: rub(1_000) },
    { lotId: lot(2), price: rub(2_000) },
  ],
  yourLotIds,
});

const p1 = money(rub(1_000));
const p2 = money(rub(2_000));

const context = { recipientId: lot(42), requestId: "r-1" };

describe("finalNoticeOf", () => {
  it("carries the lineup in final order with the prices and the recipient's lots", () => {
    expect(finalNoticeOf(lineupFact([lot(2)]))).toEqual({
      kind: "final-lineup",
      auctionId,
      lineup: [
        { lotId: lot(1), price: rub(1_000) },
        { lotId: lot(2), price: rub(2_000) },
      ],
      yourLotIds: [lot(2)],
    });
  });

  // Кнопки идут в порядке финала, а не провода.
  it("puts the recipient's lots in lineup order", () => {
    expect(finalNoticeOf(lineupFact([lot(2), lot(1)]))).toMatchObject({
      yourLotIds: [lot(1), lot(2)],
    });
  });

  it("carries the auction of a started final", () => {
    expect(
      finalNoticeOf({
        case: "auctionFinalStarted",
        value: create(AuctionFinalStartedSchema, {
          auctionId,
          meetupId: lot(99),
        }),
      }),
    ).toEqual({ kind: "final-started", auctionId });
  });

  // Дефекты издателя: из такого факта не собрать ни кнопку, ни правдивый текст.
  it.each([
    ["an empty lineup", lineupFact([], [])],
    ["a lot repeated in the lineup", lineupFact([], [1, 1])],
    ["an own lot outside the lineup", lineupFact([lot(3)])],
    [
      "a lot id not in canonical form",
      {
        case: "auctionFinalLineup" as const,
        value: create(AuctionFinalLineupSchema, {
          auctionId,
          lineup: [
            {
              lotId: lot(1).toUpperCase(),
              price: { minorUnits: 100n, currency: "RUB" },
            },
          ],
        }),
      },
    ],
    [
      "a price without a currency",
      {
        case: "auctionFinalLineup" as const,
        value: create(AuctionFinalLineupSchema, {
          auctionId,
          lineup: [{ lotId: lot(1), price: { minorUnits: 100n } }],
        }),
      },
    ],
    [
      "an auction id not in canonical form",
      {
        case: "auctionFinalStarted" as const,
        value: create(AuctionFinalStartedSchema, { auctionId: "auction" }),
      },
    ],
  ])("rejects %s", (_, value) => {
    expect(finalNoticeOf(value)).toBeUndefined();
  });
});

describe("renderFinalNotice", () => {
  const lots = new Map([
    [lot(1), { title: "Банка солёных грибов" }],
    [lot(2), { title: "Кружка" }],
  ]);

  // Три экрана задачи: простой анонс, «твой лот в финале» и старт финала.
  it("lists the lineup with prices and no button for the plain announcement", () => {
    const view = renderFinalNotice(lineup(), { lots });
    expect(view.text).toBe(
      [
        "Объявлен состав финала аукциона:",
        "",
        `• «Банка солёных грибов» — ${p1}`,
        `• «Кружка» — ${p2}`,
        "",
        "Раунд 2 прогнозов открыт — он закроется, когда начнётся финал.",
      ].join("\n"),
    );
    expect(view.rows).toEqual([]);
  });

  it("marks the recipient's lot and gives a row to its card", () => {
    const view = renderFinalNotice(lineup([lot(2)]), { lots });
    expect(view.text.split("\n")[0]).toBe(
      "Твой лот в финале аукциона. Состав финала:",
    );
    expect(view.text).toContain(`• «Кружка» — ${p2}, лот за тобой`);
    expect(view.text).not.toContain(`грибов» — ${p1}, лот за тобой`);
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId: lot(2), text: "Кружка" }],
    ]);
  });

  it("speaks of several lots of the recipient in plural", () => {
    const view = renderFinalNotice(lineup([lot(1), lot(2)]), { lots });
    expect(view.text.split("\n")[0]).toBe(
      "Твои лоты в финале аукциона. Состав финала:",
    );
    expect(view.rows).toHaveLength(2);
  });

  it("announces the started final without a button", () => {
    expect(
      renderFinalNotice({ kind: "final-started", auctionId }, { lots }),
    ).toEqual({ text: "Начался финал аукциона.", rows: [] });
  });

  // Без названия строка остаётся с ценой, а кнопка — «К лоту»; лот, который
  // Auction окончательно не отдал, кнопки не получает.
  it("keeps untitled lines and drops the button of a refused lot", () => {
    const view = renderFinalNotice(lineup([lot(1), lot(2)]), {
      lots: new Map(),
      refused: new Set([lot(1)]),
    });
    expect(view.text).toContain(`• Лот — ${p2}, лот за тобой`);
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId: lot(2), text: "К лоту" }],
    ]);
  });

  it("names the lots beyond the limit by number", () => {
    const many: FinalNotice = {
      kind: "final-lineup",
      auctionId,
      lineup: Array.from({ length: LINEUP_LOT_LIMIT + 3 }, (_, n) => ({
        lotId: lot(n + 1),
        price: rub(100),
      })),
      yourLotIds: [],
    };
    const lines = renderFinalNotice(many, { lots: new Map() }).text.split("\n");
    expect(lines.filter((line) => line.startsWith("• "))).toHaveLength(
      LINEUP_LOT_LIMIT,
    );
    expect(lines.at(-3)).toBe("…и ещё лотов: 3.");
  });

  // Первая строка обещает свой лот: он стоит строкой и за пределом.
  it("shows an own lot beyond the limit as a line", () => {
    const beyond = lot(LINEUP_LOT_LIMIT + 2);
    const many: FinalNotice = {
      kind: "final-lineup",
      auctionId,
      lineup: Array.from({ length: LINEUP_LOT_LIMIT + 3 }, (_, n) => ({
        lotId: lot(n + 1),
        price: rub(100),
      })),
      yourLotIds: [beyond],
    };
    const lines = renderFinalNotice(many, {
      lots: new Map([[beyond, { title: "Кружка" }]]),
    }).text.split("\n");
    expect(lines).toContain(`• «Кружка» — ${money(rub(100))}, лот за тобой`);
    expect(lines.at(-3)).toBe("…и ещё лотов: 2.");
  });
});

describe("createFinalNoticeRender", () => {
  const permanent = Object.assign(new Error("not found"), {
    code: 5,
  });

  it("reads the titles of the lineup under the recipient's right", async () => {
    const lotInfo = vi.fn(async (_: string, lotId: string) => ({
      title: lotId === lot(1) ? "Банка" : "Кружка",
    }));
    const render = createFinalNoticeRender({
      reads: { holdsPlaceBids: async () => true, lotInfo },
      onTitleMissing: () => {},
    });
    const result = await render(lineup([lot(2)]), context);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.message.text).toContain(`• «Кружка» — ${p2}, лот за тобой`);
    expect(lotInfo).toHaveBeenCalledWith(lot(42), lot(1), "r-1");
  });

  // Весть о торгах: без права `place-bids` она не уходит, как вести о лотах.
  it("withholds the announcement from a recipient without the right", async () => {
    const lotInfo = vi.fn();
    const render = createFinalNoticeRender({
      reads: { holdsPlaceBids: async () => false, lotInfo },
      onTitleMissing: () => {},
    });
    await expect(
      render({ kind: "final-started", auctionId }, context),
    ).resolves.toEqual({ kind: "ineligible" });
    await expect(render(lineup(), context)).resolves.toEqual({
      kind: "ineligible",
    });
    expect(lotInfo).not.toHaveBeenCalled();
  });

  // Лоты состава одни на всех (PER-704): рассылка читает каждый лот один раз,
  // а не на каждого получателя. Право спрашивается у каждого.
  const ofThree = (yourLotIds: string[] = []): FinalNotice => ({
    ...lineup(yourLotIds),
    lineup: [1, 2, 3].map((n) => ({ lotId: lot(n), price: rub(n * 1_000) })),
  });
  const recipients = Array.from({ length: 10 }, (_, n) => lot(100 + n));
  const broadcast = (lotInfo: LotNoticeReads["lotInfo"]) => {
    let clock = 0;
    const holdsPlaceBids = vi.fn(async () => true);
    const render = createFinalNoticeRender({
      reads: { holdsPlaceBids, lotInfo },
      onTitleMissing: () => {},
      now: () => clock,
    });
    return {
      render,
      holdsPlaceBids,
      tick: (ms: number) => {
        clock += ms;
      },
    };
  };
  const textOf = async (result: Promise<unknown>) => {
    const settled = (await result) as {
      kind: string;
      message?: { text: string };
    };
    if (settled.kind !== "ready" || settled.message === undefined) {
      throw new Error(`not ready: ${settled.kind}`);
    }
    return settled.message.text;
  };

  it("reads each lot of the lineup once for ten recipients", async () => {
    const lotInfo = vi.fn(async () => ({ title: "Банка" }));
    const { render, holdsPlaceBids } = broadcast(lotInfo);

    for (const recipientId of recipients) {
      await render(ofThree([lot(2)]), { recipientId, requestId: "r" });
    }

    expect(lotInfo).toHaveBeenCalledTimes(3);
    expect(holdsPlaceBids).toHaveBeenCalledTimes(10);
  });

  it("reads a renamed lot again once the broadcast is over", async () => {
    let title = "Банка";
    const lotInfo = vi.fn(async () => ({ title }));
    const { render, tick } = broadcast(lotInfo);
    await render(ofThree(), context);

    title = "Кружка";
    tick(LINEUP_LOT_TTL_MS);
    const text = await textOf(render(ofThree(), context));

    expect(lotInfo).toHaveBeenCalledTimes(6);
    expect(text).toContain("«Кружка»");
    expect(text).not.toContain("«Банка»");
  });

  // Отказ и лот без названия — карточка ещё не в read model — не
  // запоминаются: следующий получатель читает лот сам.
  it("does not remember a refused read or a lot without a title", async () => {
    let answer: "refuse" | "untitled" | "titled" = "refuse";
    const lotInfo = vi.fn(async () => {
      if (answer === "refuse") throw permanent;
      return { title: answer === "untitled" ? "" : "Банка" };
    });
    const { render } = broadcast(lotInfo);
    await render(lineup(), context);
    answer = "untitled";
    await render(lineup(), context);

    answer = "titled";
    const text = await textOf(render(lineup(), context));

    expect(lotInfo).toHaveBeenCalledTimes(6);
    expect(text).toContain("«Банка»");
  });

  it("keeps the line of a refused lot and logs the refusal", async () => {
    const onTitleMissing = vi.fn();
    const render = createFinalNoticeRender({
      reads: {
        holdsPlaceBids: async () => true,
        lotInfo: async (_, lotId) => {
          if (lotId === lot(2)) throw permanent;
          return { title: "Банка" };
        },
      },
      onTitleMissing,
    });
    const result = await render(lineup([lot(2)]), context);
    expect(result).toMatchObject({ kind: "ready", message: { rows: [] } });
    expect(onTitleMissing).toHaveBeenCalledWith(permanent, "r-1");
  });
});

// Вести конца торгов и продажи лота в финале (PER-812).
describe("end of online trading and a lot sold in the final", () => {
  const ended = (soldCount: number, heldCount: number) => ({
    case: "auctionPrebiddingEnded" as const,
    value: create(AuctionPrebiddingEndedSchema, {
      auctionId,
      meetupId: lot(99),
      soldCount,
      heldCount,
    }),
  });

  it("reads the counts of the end of trading", () => {
    expect(finalNoticeOf(ended(4, 2))).toEqual({
      kind: "prebidding-ended",
      auctionId,
      soldCount: 4,
      heldCount: 2,
    });
  });

  it("reads a lot sold in the final and rejects a broken one", () => {
    const sold = (lotId: string, currency: string) => ({
      case: "auctionLotSoldInFinal" as const,
      value: create(AuctionLotSoldInFinalSchema, {
        lotId,
        price: { minorUnits: 90_000n, currency },
      }),
    });
    expect(finalNoticeOf(sold(lot(5), "RUB"))).toEqual({
      kind: "lot-sold-in-final",
      lotId: lot(5),
      price: rub(900),
    });
    expect(finalNoticeOf(sold("nope", "RUB"))).toBeUndefined();
    expect(finalNoticeOf(sold(lot(5), ""))).toBeUndefined();
  });

  it("tells the counts, the final time and what comes next", () => {
    const view = renderFinalNotice(
      { kind: "prebidding-ended", auctionId, soldCount: 4, heldCount: 2 },
      {
        lots: new Map(),
        timeZone: "Europe/Moscow",
        finalAt: "2026-10-31T17:00:00Z",
      },
    );
    expect(view.text).toBe(
      [
        "Онлайн-торги закончились. Продано лотов: 4. В финал идут: 2.",
        "",
        "Финал ориентировочно 31.10 в 20:00.",
        "Состав финала объявят отдельным сообщением, тогда же откроется раунд 2 прогнозов.",
      ].join("\n"),
    );
    expect(view.rows).toEqual([]);
  });

  it("leaves the final time out when it is not set", () => {
    const view = renderFinalNotice(
      { kind: "prebidding-ended", auctionId, soldCount: 1, heldCount: 3 },
      { lots: new Map() },
    );
    expect(view.text).not.toContain("ориентировочно");
  });

  it("says there is no final when no lot is held", () => {
    const view = renderFinalNotice(
      { kind: "prebidding-ended", auctionId, soldCount: 5, heldCount: 0 },
      { lots: new Map() },
    );
    expect(view.text).toBe(
      [
        "Онлайн-торги закончились. Продано лотов: 5.",
        "",
        "Финала не будет: итоги аукциона смотри в боте.",
      ].join("\n"),
    );
  });

  it("names the lot sold in the final and leads to it", () => {
    const view = renderFinalNotice(
      { kind: "lot-sold-in-final", lotId: lot(5), price: rub(900) },
      { lots: new Map([[lot(5), { title: "Кружка" }]]) },
    );
    expect(view.text).toBe(
      `Лот «Кружка» продан в финале за ${money(rub(900))}. Ты на него ставил.`,
    );
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId: lot(5), text: "К лоту" }],
    ]);
  });

  it("reads the final time as the recipient and survives a failed read", async () => {
    const auctionFinalAt = vi
      .fn()
      .mockResolvedValueOnce("2026-10-31T17:00:00Z")
      .mockRejectedValueOnce(new Error("down"));
    const reads: LotNoticeReads = {
      holdsPlaceBids: async () => true,
      lotInfo: async () => ({ title: "" }),
      auctionFinalAt,
    };
    const onTitleMissing = vi.fn();
    const render = createFinalNoticeRender({
      reads,
      onTitleMissing,
      timeZone: "Europe/Moscow",
    });
    const notice: FinalNotice = {
      kind: "prebidding-ended",
      auctionId,
      soldCount: 1,
      heldCount: 1,
    };

    const first = await render(notice, context);
    const second = await render(notice, context);

    expect(first).toMatchObject({ kind: "ready" });
    expect(JSON.stringify(first)).toContain("31.10 в 20:00");
    expect(auctionFinalAt).toHaveBeenCalledWith(
      context.recipientId,
      auctionId,
      context.requestId,
    );
    // Недоступное чтение времени не теряет весть.
    expect(second).toMatchObject({ kind: "ready" });
    expect(JSON.stringify(second)).not.toContain("ориентировочно");
    expect(onTitleMissing).toHaveBeenCalledTimes(1);
  });

  it("names the second round of predictions in the lineup", () => {
    const view = renderFinalNotice(lineup(), { lots: new Map() });
    expect(view.text).toContain(
      "Раунд 2 прогнозов открыт — он закроется, когда начнётся финал.",
    );
  });
});
