import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  AuctionFinalLineupSchema,
  AuctionFinalStartedSchema,
} from "../../../gen/notifications/v1/notifications_pb.js";
import { money } from "../format.js";
import {
  createFinalNoticeRender,
  type FinalNotice,
  finalNoticeOf,
  LINEUP_LOT_LIMIT,
  renderFinalNotice,
} from "./final-notice.js";

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

const lineup = (yourLotIds: string[] = []): FinalNotice => ({
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
  const titles = new Map([
    [lot(1), "Банка солёных грибов"],
    [lot(2), "Кружка"],
  ]);

  // Три экрана задачи: простой анонс, «твой лот в финале» и старт финала.
  it("lists the lineup with prices and no button for the plain announcement", () => {
    const view = renderFinalNotice(lineup(), { titles });
    expect(view.text).toBe(
      [
        "Объявлен состав финала аукциона:",
        "",
        `• «Банка солёных грибов» — ${p1}`,
        `• «Кружка» — ${p2}`,
      ].join("\n"),
    );
    expect(view.rows).toEqual([]);
  });

  it("marks the recipient's lot and gives a row to its card", () => {
    const view = renderFinalNotice(lineup([lot(2)]), { titles });
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
    const view = renderFinalNotice(lineup([lot(1), lot(2)]), { titles });
    expect(view.text.split("\n")[0]).toBe(
      "Твои лоты в финале аукциона. Состав финала:",
    );
    expect(view.rows).toHaveLength(2);
  });

  it("announces the started final without a button", () => {
    expect(
      renderFinalNotice({ kind: "final-started", auctionId }, { titles }),
    ).toEqual({ text: "Начался финал аукциона.", rows: [] });
  });

  // Без названия строка остаётся с ценой, а кнопка — «К лоту»; лот, который
  // Auction окончательно не отдал, кнопки не получает.
  it("keeps untitled lines and drops the button of a refused lot", () => {
    const view = renderFinalNotice(lineup([lot(1), lot(2)]), {
      titles: new Map(),
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
    const lines = renderFinalNotice(many, { titles: new Map() }).text.split(
      "\n",
    );
    expect(lines.filter((line) => line.startsWith("• "))).toHaveLength(
      LINEUP_LOT_LIMIT,
    );
    expect(lines.at(-1)).toBe("…и ещё лотов: 3.");
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
      titles: new Map([[beyond, "Кружка"]]),
    }).text.split("\n");
    expect(lines).toContain(`• «Кружка» — ${money(rub(100))}, лот за тобой`);
    expect(lines.at(-1)).toBe("…и ещё лотов: 2.");
  });
});

describe("createFinalNoticeRender", () => {
  const permanent = Object.assign(new Error("not found"), {
    code: 5,
  });

  it("reads the titles of the lineup under the recipient's right", async () => {
    const lotTitle = vi.fn(async (_: string, lotId: string) =>
      lotId === lot(1) ? "Банка" : "Кружка",
    );
    const render = createFinalNoticeRender({
      reads: { holdsPlaceBids: async () => true, lotTitle },
      onTitleMissing: () => {},
    });
    const result = await render(lineup([lot(2)]), context);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.message.text).toContain(`• «Кружка» — ${p2}, лот за тобой`);
    expect(lotTitle).toHaveBeenCalledWith(lot(42), lot(1), "r-1");
  });

  // Весть о торгах: без права `place-bids` она не уходит, как вести о лотах.
  it("withholds the announcement from a recipient without the right", async () => {
    const lotTitle = vi.fn();
    const render = createFinalNoticeRender({
      reads: { holdsPlaceBids: async () => false, lotTitle },
      onTitleMissing: () => {},
    });
    await expect(
      render({ kind: "final-started", auctionId }, context),
    ).resolves.toEqual({ kind: "ineligible" });
    await expect(render(lineup(), context)).resolves.toEqual({
      kind: "ineligible",
    });
    expect(lotTitle).not.toHaveBeenCalled();
  });

  it("keeps the line of a refused lot and logs the refusal", async () => {
    const onTitleMissing = vi.fn();
    const render = createFinalNoticeRender({
      reads: {
        holdsPlaceBids: async () => true,
        lotTitle: async (_, lotId) => {
          if (lotId === lot(2)) throw permanent;
          return "Банка";
        },
      },
      onTitleMissing,
    });
    const result = await render(lineup([lot(2)]), context);
    expect(result).toMatchObject({ kind: "ready", message: { rows: [] } });
    expect(onTitleMissing).toHaveBeenCalledWith(permanent, "r-1");
  });
});
