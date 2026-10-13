import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  LotActivityDigestSchema,
  LotActivityKind,
} from "../../../gen/notifications/v1/notifications_pb.js";
import {
  createLotNoticeRender,
  DIGEST_LOT_LIMIT,
  isLotNotice,
  type LotActivityLine,
  type LotNotice,
  logMissingTitle,
  lotNoticeOf,
  renderLotNotice,
} from "./lot-notice.js";

const nbsp = " ";
const rub = (whole: number) => ({ minorUnits: whole * 100, currency: "RUB" });
const lotOf = (index: number) =>
  `0198f2a4-7c1e-7d3a-9b21-${index.toString(16).padStart(12, "0")}`;

function digest(lines: LotActivityLine[]): LotNotice {
  return { kind: "lot-activity-digest", lines };
}

describe("lotNoticeOf", () => {
  // Вид строки из схемы новее этой сборки не роняет сводку: такая строка
  // пропускается, остальные доходят.
  it("skips a digest line of a kind this build does not know", () => {
    const value = create(LotActivityDigestSchema, {
      lines: [
        {
          lotId: lotOf(1),
          kind: 7 as LotActivityKind,
          currentPrice: { minorUnits: 100n, currency: "RUB" },
        },
        {
          lotId: lotOf(2),
          kind: LotActivityKind.OUTBID,
          currentPrice: { minorUnits: 100n, currency: "RUB" },
        },
      ],
    });
    expect(lotNoticeOf({ case: "lotActivityDigest", value })).toMatchObject({
      kind: "lot-activity-digest",
      lines: [{ lotId: lotOf(2), kind: "outbid" }],
    });
  });

  it("finds a digest with no line it knows malformed", () => {
    const value = create(LotActivityDigestSchema, {
      lines: [
        {
          lotId: lotOf(1),
          kind: LotActivityKind.UNSPECIFIED,
          currentPrice: { minorUnits: 100n, currency: "RUB" },
        },
      ],
    });
    expect(lotNoticeOf({ case: "lotActivityDigest", value })).toBeUndefined();
  });
});

describe("renderLotNotice", () => {
  // Лидерство в строке — на момент закрытия окна; «лот за тобой» верно и для
  // лидера, и для купившего: проданный в окне лот приходит с ценой продажи.
  it("names who holds each lot when the window closed", () => {
    const lotId = lotOf(1);
    const titles = new Map([[lotId, "Кружка"]]);
    const line = (
      kind: LotActivityLine["kind"],
      recipientLeads: boolean,
    ): string =>
      renderLotNotice(
        digest([{ lotId, kind, currentPrice: rub(950), recipientLeads }]),
        { titles, frequencyButton: false },
      ).text.split("\n")[2] ?? "";
    expect(line("outbid", false)).toBe(
      `• «Кружка» — перебили, цена 950${nbsp}₽`,
    );
    expect(line("outbid", true)).toBe(
      `• «Кружка» — перебивали, но лот за тобой: 950${nbsp}₽`,
    );
    expect(line("proxy-raised", true)).toBe(
      `• «Кружка» — автоставка подняла цену до 950${nbsp}₽, лот за тобой`,
    );
    expect(line("proxy-raised", false)).toBe(
      `• «Кружка» — автоставка отвечала, но тебя перебили: 950${nbsp}₽`,
    );
  });

  // Лот с перебитием и ответом автоставки — две строки, но одна кнопка.
  it("gives a lot with two lines one button", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      digest([
        { lotId, kind: "outbid", currentPrice: rub(900), recipientLeads: true },
        {
          lotId,
          kind: "proxy-raised",
          currentPrice: rub(900),
          recipientLeads: true,
        },
      ]),
      { titles: new Map([[lotId, "Кружка"]]), frequencyButton: true },
    );
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId, text: "Кружка" }],
      [{ kind: "frequency", text: "Частота уведомлений" }],
    ]);
  });

  // Сводка за час может набрать много лотов: текст и клавиатура держатся в
  // пределах Telegram, а лоты сверх предела называются числом. Предел — по
  // лотам: вторая строка показанного лота в «ещё» не уходит.
  it("caps a long digest by lots within the Telegram limits", () => {
    const lines = Array.from({ length: 40 }, (_, index) => ({
      lotId: lotOf(index),
      kind: "outbid" as const,
      currentPrice: rub(1_000_000),
      recipientLeads: false,
    }));
    lines.push({ ...lines[0], kind: "outbid" } as (typeof lines)[number]);
    const titles = new Map(
      lines.map((line) => [line.lotId, "Лот ".repeat(80)]),
    );
    const view = renderLotNotice(digest(lines), {
      titles,
      frequencyButton: true,
    });
    expect(view.text.length).toBeLessThanOrEqual(4096);
    expect(
      view.text.split("\n").filter((row) => row.startsWith("•")),
    ).toHaveLength(DIGEST_LOT_LIMIT + 1);
    expect(view.text.endsWith(`…и ещё лотов: ${40 - DIGEST_LOT_LIMIT}.`)).toBe(
      true,
    );
    expect(view.rows).toHaveLength(DIGEST_LOT_LIMIT + 1);
    for (const row of view.rows) {
      for (const button of row) expect(button.text.length).toBeLessThan(40);
    }
  });
});

describe("createLotNoticeRender", () => {
  it("reads each shown lot once and asks the right once", async () => {
    const reads = {
      holdsPlaceBids: vi.fn(async () => true),
      lotTitle: vi.fn(async () => "Кружка"),
    };
    const lines = Array.from({ length: 14 }, (_, index) => ({
      lotId: lotOf(index % 12),
      kind: "outbid" as const,
      currentPrice: rub(100),
      recipientLeads: false,
    }));
    const render = createLotNoticeRender({
      reads,
      onTitleMissing: () => {},
      frequencyButton: false,
    });
    await render(digest(lines), { recipientId: lotOf(99) });
    expect(reads.holdsPlaceBids).toHaveBeenCalledTimes(1);
    expect(reads.lotTitle).toHaveBeenCalledTimes(DIGEST_LOT_LIMIT);
  });

  // Лот, который Auction окончательно не отдаёт, остаётся строкой без
  // названия, но без кнопки: она упёрлась бы в тот же отказ.
  it("leaves out the button of a lot Auction refuses for good", async () => {
    const notFound = Object.assign(new Error("lot not found"), { code: 5 });
    const render = createLotNoticeRender({
      reads: {
        holdsPlaceBids: async () => true,
        lotTitle: async (_who, id) =>
          id === lotOf(1) ? Promise.reject(notFound) : "Плакат",
      },
      onTitleMissing: () => {},
      frequencyButton: false,
    });
    const rendered = await render(
      digest([
        {
          lotId: lotOf(1),
          kind: "outbid",
          currentPrice: rub(100),
          recipientLeads: false,
        },
        {
          lotId: lotOf(2),
          kind: "outbid",
          currentPrice: rub(100),
          recipientLeads: false,
        },
      ]),
      { recipientId: lotOf(99) },
    );
    if (rendered.kind !== "ready") throw new Error("the digest must render");
    expect(rendered.message.text).toContain("• Лот — перебили");
    expect(rendered.message.rows).toEqual([
      [{ kind: "lot", lotId: lotOf(2), text: "Плакат" }],
    ]);
  });

  // Бот без Auction: аукционный факт всё равно уходит — без названия и без
  // права, которое некому подтвердить.
  it("renders without titles when the bot has no reads", async () => {
    const render = createLotNoticeRender({
      reads: undefined,
      onTitleMissing: () => {},
      frequencyButton: false,
    });
    await expect(
      render(
        { kind: "lot-outbid", lotId: lotOf(1), currentPrice: rub(950) },
        { recipientId: lotOf(99) },
      ),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("на лот перебили") },
    });
  });
});

describe("logMissingTitle", () => {
  // Окончательный отказ по лоту — нарушение инварианта у соседа, а не его
  // недоступность: в логе они различимы.
  it("tells a refused lot from an unavailable Auction", () => {
    const warn = vi.fn();
    const log = logMissingTitle({ warn });
    log(Object.assign(new Error("not found"), { code: 5 }), "req-1");
    log(new Error("down"));
    expect(warn).toHaveBeenNthCalledWith(1, "lot title unavailable", {
      request_id: "req-1",
      error_category: "invariant",
      error: "not found",
    });
    expect(warn).toHaveBeenNthCalledWith(2, "lot title unavailable", {
      error_category: "dependency_unavailable",
      error: "down",
    });
  });
});

describe("isLotNotice", () => {
  it("tells a lot notice from other branches", () => {
    expect(isLotNotice({ kind: "lot-activity-digest" })).toBe(true);
    expect(isLotNotice({ kind: "lot-purchased" })).toBe(true);
    expect(isLotNotice({ kind: "access-granted" })).toBe(false);
  });
});
