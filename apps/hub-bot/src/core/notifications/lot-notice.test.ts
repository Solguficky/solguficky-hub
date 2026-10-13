import { describe, expect, it, vi } from "vitest";
import {
  createLotNoticeRender,
  DIGEST_LINE_LIMIT,
  isLotNotice,
  type LotActivityLine,
  type LotNotice,
  renderLotNotice,
} from "./lot-notice.js";

const nbsp = " ";
const rub = (whole: number) => ({ minorUnits: whole * 100, currency: "RUB" });
const lotOf = (index: number) =>
  `0198f2a4-7c1e-7d3a-9b21-${index.toString(16).padStart(12, "0")}`;

function digest(lines: LotActivityLine[]): LotNotice {
  return { kind: "lot-activity-digest", lines };
}

describe("renderLotNotice", () => {
  // Лидерство в строке — на момент закрытия окна: перебитие с вернувшимся
  // лидерством и ответ автоставки, который потом перебили, говорят разное.
  it("names who leads each lot when the window closed", () => {
    const lotId = lotOf(1);
    const titles = new Map([[lotId, "Кружка"]]);
    const line = (
      kind: LotActivityLine["kind"],
      recipientLeads: boolean,
    ): string =>
      renderLotNotice(
        digest([{ lotId, kind, currentPrice: rub(950), recipientLeads }]),
        titles,
        false,
      ).text.split("\n")[2] ?? "";
    expect(line("outbid", false)).toBe(
      `• «Кружка» — перебили, цена 950${nbsp}₽`,
    );
    expect(line("outbid", true)).toBe(
      `• «Кружка» — перебивали, но лидируешь ты: 950${nbsp}₽`,
    );
    expect(line("proxy-raised", true)).toBe(
      `• «Кружка» — автоставка подняла цену до 950${nbsp}₽, лидируешь ты`,
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
      new Map([[lotId, "Кружка"]]),
      true,
    );
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId, text: "Кружка" }],
      [{ kind: "frequency", text: "Частота уведомлений" }],
    ]);
  });

  // Сводка за час может набрать много лотов: текст и клавиатура держатся в
  // пределах Telegram, остальное называется числом.
  it("caps a long digest within the Telegram limits", () => {
    const lines = Array.from({ length: 40 }, (_, index) => ({
      lotId: lotOf(index),
      kind: "outbid" as const,
      currentPrice: rub(1_000_000),
      recipientLeads: false,
    }));
    const titles = new Map(
      lines.map((line) => [line.lotId, "Лот ".repeat(80)]),
    );
    const view = renderLotNotice(digest(lines), titles, true);
    expect(view.text.length).toBeLessThanOrEqual(4096);
    expect(view.text.endsWith(`…и ещё ${40 - DIGEST_LINE_LIMIT}.`)).toBe(true);
    expect(view.rows).toHaveLength(DIGEST_LINE_LIMIT + 1);
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
    const lines = Array.from({ length: 12 }, (_, index) => ({
      lotId: lotOf(index % 11),
      kind: "outbid" as const,
      currentPrice: rub(100),
      recipientLeads: false,
    }));
    const render = createLotNoticeRender(reads, () => {}, false);
    await render(digest(lines), { recipientId: lotOf(99) });
    expect(reads.holdsPlaceBids).toHaveBeenCalledTimes(1);
    expect(reads.lotTitle).toHaveBeenCalledTimes(DIGEST_LINE_LIMIT);
  });

  // Бот без Auction: аукционный факт всё равно уходит — без названия и без
  // права, которое некому подтвердить.
  it("renders without titles when the bot has no reads", async () => {
    const render = createLotNoticeRender(undefined, () => {}, false);
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

describe("isLotNotice", () => {
  it("tells a lot notice from other branches", () => {
    expect(isLotNotice({ kind: "lot-activity-digest" })).toBe(true);
    expect(isLotNotice({ kind: "lot-purchased" })).toBe(true);
    expect(isLotNotice({ kind: "access-granted" })).toBe(false);
  });
});
