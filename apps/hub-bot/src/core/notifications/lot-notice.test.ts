import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  LotSaleSchema,
  MoneySchema,
} from "../../../gen/auction/v1/auction_pb.js";
import {
  LotCardSchema,
  LotSnapshotSchema,
} from "../../../gen/auction/v1/auction_service_pb.js";
import {
  AuctionFinalLotNextSchema,
  LotActivityDigestSchema,
  LotActivityKind,
  LotDeadlineCloseSchema,
  LotLeadRestoredSchema,
  LotReminderSchema,
} from "../../../gen/notifications/v1/notifications_pb.js";
import {
  createLotNoticeRender,
  DIGEST_LOT_LIMIT,
  isLotNotice,
  type LotActivityLine,
  type LotInfo,
  type LotNotice,
  logMissingTitle,
  lotInfoOf,
  lotNoticeOf,
  renderLotNotice,
} from "./lot-notice.js";

const nbsp = "\u00a0";
const rub = (whole: number) => ({ minorUnits: whole * 100, currency: "RUB" });
const lotOf = (index: number) =>
  `0198f2a4-7c1e-7d3a-9b21-${index.toString(16).padStart(12, "0")}`;
const timeZone = "Europe/Moscow";
// Дедлайн по времени сервера: в московском поясе это 22:45.
const deadline = "2026-10-20T19:45:00Z";
const lot = (title: string, info: Partial<LotInfo> = {}): LotInfo => ({
  title,
  ...info,
});

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

  // Напоминание о дедлайне (PER-496) несёт только лот: имени, цены и самого
  // дедлайна у продюсера нет.
  it("carries a reminder as its lot id alone", () => {
    const value = create(LotReminderSchema, { lotId: lotOf(3) });
    expect(lotNoticeOf({ case: "lotReminder", value })).toEqual({
      kind: "lot-reminder",
      lotId: lotOf(3),
    });
  });

  // Второй момент напоминания (ADR-063, дополнение 2026-10-20) несёт тот же
  // лот и ничего сверх него.
  it("carries the close reminder as its lot id alone", () => {
    const value = create(LotDeadlineCloseSchema, { lotId: lotOf(4) });
    expect(lotNoticeOf({ case: "lotDeadlineClose", value })).toEqual({
      kind: "lot-deadline-close",
      lotId: lotOf(4),
    });
  });

  // Следующий лот финала несёт лот и оценку его длительности.
  it("carries the next lot of the final with its estimate", () => {
    const value = create(AuctionFinalLotNextSchema, {
      lotId: lotOf(5),
      estimatedMinutes: 7,
    });
    expect(lotNoticeOf({ case: "auctionFinalLotNext", value })).toEqual({
      kind: "lot-final-next",
      lotId: lotOf(5),
      estimatedMinutes: 7,
    });
  });

  // Оценка без лота — дефект издателя: сообщение без лота нечего открывать.
  it("finds a next lot without a lot id malformed", () => {
    const value = create(AuctionFinalLotNextSchema, {
      lotId: "",
      estimatedMinutes: 7,
    });
    expect(lotNoticeOf({ case: "auctionFinalLotNext", value })).toBeUndefined();
  });

  // Ведение лота вернулось: снятие участника оставило лот новому лидеру
  // (ADR-072, п. 5). Сообщение несёт лот и текущую цену.
  it("carries the restored lead with its price", () => {
    const value = create(LotLeadRestoredSchema, {
      lotId: lotOf(6),
      currentPrice: create(MoneySchema, {
        minorUnits: 95_000n,
        currency: "RUB",
      }),
    });
    expect(lotNoticeOf({ case: "lotLeadRestored", value })).toEqual({
      kind: "lot-lead-restored",
      lotId: lotOf(6),
      currentPrice: rub(950),
    });
  });

  // Лот без идентификатора открыть нечем — это дефект издателя.
  it("finds a restored lead without a lot id malformed", () => {
    const value = create(LotLeadRestoredSchema, {
      lotId: "",
      currentPrice: create(MoneySchema, {
        minorUnits: 95_000n,
        currency: "RUB",
      }),
    });
    expect(lotNoticeOf({ case: "lotLeadRestored", value })).toBeUndefined();
  });
});

describe("lotInfoOf", () => {
  // Проданный лот несёт цену продажи и победителя: по ним сводка говорит
  // «продан за» или «твой лот» (№102 прогона 14 октября 2026 года).
  it("carries the sale of a sold lot", () => {
    const winnerId = lotOf(7);
    const snapshot = create(LotSnapshotSchema, {
      card: create(LotCardSchema, { title: "Футболка" }),
      status: {
        case: "sold",
        value: create(LotSaleSchema, {
          winnerId,
          price: create(MoneySchema, { minorUnits: 210_000n, currency: "RUB" }),
        }),
      },
    });
    expect(lotInfoOf(snapshot)).toEqual({
      title: "Футболка",
      sold: { price: rub(2100), winnerId },
    });
  });
});

describe("renderLotNotice", () => {
  // Лидерство в строке — на момент закрытия окна; «лот за тобой» верно и для
  // лидера, и для купившего, пока снимок Auction не сказал о продаже.
  // Название — жирным, без кавычек (№71 прогона 14 октября 2026 года).
  it("names who holds each lot when the window closed", () => {
    const lotId = lotOf(1);
    const lots = new Map([[lotId, lot("Кружка")]]);
    const line = (
      kind: LotActivityLine["kind"],
      recipientLeads: boolean,
    ): string =>
      renderLotNotice(
        digest([{ lotId, kind, currentPrice: rub(950), recipientLeads }]),
        { lots, frequencyButton: false, timeZone },
      ).text.split("\n")[2] ?? "";
    expect(line("outbid", false)).toBe(
      `• <b>Кружка</b> — перебили, цена 950${nbsp}₽`,
    );
    expect(line("outbid", true)).toBe(
      `• <b>Кружка</b> — перебивали, но лот за тобой: 950${nbsp}₽`,
    );
    expect(line("proxy-raised", true)).toBe(
      `• <b>Кружка</b> — автоставка подняла цену до 950${nbsp}₽, лот за тобой`,
    );
    expect(line("proxy-raised", false)).toBe(
      `• <b>Кружка</b> — перебили, цена 950${nbsp}₽, автоставка отвечала`,
    );
  });

  // Перебитие и ответ автоставки одного лота — одна строка с итоговой ценой и
  // пометкой об автоставке (№79 прогона 14 октября 2026 года).
  it("folds the lines of one lot into one", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      digest([
        {
          lotId,
          kind: "proxy-raised",
          currentPrice: rub(900),
          recipientLeads: false,
        },
        {
          lotId,
          kind: "outbid",
          currentPrice: rub(900),
          recipientLeads: false,
        },
      ]),
      {
        lots: new Map([[lotId, lot("Кружка")]]),
        frequencyButton: false,
        timeZone,
      },
    );
    expect(view.text).toBe(
      [
        "Сводка по твоим ставкам:",
        "",
        `• <b>Кружка</b> — перебили, цена 900${nbsp}₽, автоставка отвечала`,
      ].join("\n"),
    );
    expect(view.format).toBe("HTML");
  });

  // Лот, который продан к моменту сводки, — «продан за», а не «перебили»:
  // Auction знает о продаже раньше, чем окно частоты (№102 прогона
  // 14 октября 2026 года). Купленный получателем — «твой лот».
  it("names a lot sold by the time of the digest", () => {
    const lotId = lotOf(1);
    const me = lotOf(99);
    const line = (winnerId: string) =>
      renderLotNotice(
        digest([
          {
            lotId,
            kind: "outbid",
            currentPrice: rub(2100),
            recipientLeads: false,
          },
        ]),
        {
          lots: new Map([
            [lotId, lot("Футболка", { sold: { price: rub(2100), winnerId } })],
          ]),
          frequencyButton: false,
          timeZone,
          recipientId: me,
        },
      ).text.split("\n")[2];
    expect(line(lotOf(7))).toBe(
      `• <b>Футболка</b> — продан за 2${nbsp}100${nbsp}₽`,
    );
    expect(line(me)).toBe(
      `• <b>Футболка</b> — ✅ твой лот за 2${nbsp}100${nbsp}₽`,
    );
  });

  // Название — чужой текст: разметку из него Telegram не читает.
  it("escapes the title of the lot", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      { kind: "lot-outbid", lotId, currentPrice: rub(950) },
      {
        lots: new Map([[lotId, lot("<i>Кружка</i> & ложка")]]),
        frequencyButton: false,
        timeZone,
      },
    );
    expect(view.text).toBe(
      `Твою ставку перебили: <b>&lt;i&gt;Кружка&lt;/i&gt; &amp; ложка</b>, цена 950${nbsp}₽.`,
    );
    expect(view.format).toBe("HTML");
  });

  // Перебитие лота, который успели продать, называет цену продажи: торга уже
  // нет, и дедлайна тоже (№102).
  it("names the sale of an outbid lot already sold", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      { kind: "lot-outbid", lotId, currentPrice: rub(2000) },
      {
        lots: new Map([
          [
            lotId,
            lot("Футболка", { sold: { price: rub(2100), winnerId: lotOf(7) } }),
          ],
        ]),
        frequencyButton: false,
        timeZone,
      },
    );
    expect(view.text).toBe(
      `Твою ставку перебили: <b>Футболка</b>, лот продан за 2${nbsp}100${nbsp}₽.`,
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
      {
        lots: new Map([[lotId, lot("Кружка")]]),
        frequencyButton: true,
        timeZone,
      },
    );
    expect(view.rows).toEqual([
      [{ kind: "lot", lotId, text: "Кружка" }],
      [{ kind: "frequency", text: "Частота уведомлений" }],
    ]);
  });

  // Перебитие называет время, до которого идёт торг: человек решает, успеет
  // ли он ответить.
  it("names the deadline of the outbid lot", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      { kind: "lot-outbid", lotId, currentPrice: rub(950) },
      {
        lots: new Map([[lotId, lot("Кружка", { deadline })]]),
        frequencyButton: false,
        timeZone,
      },
    );
    expect(view.text).toBe(
      `Твою ставку перебили: <b>Кружка</b>, цена 950${nbsp}₽. Торг до 22:45.`,
    );
  });

  // Продление анти-снайпом двигает дедлайн, и сообщение говорит об этом.
  it("names the extended deadline of the outbid lot", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      { kind: "lot-outbid", lotId, currentPrice: rub(950) },
      {
        lots: new Map([
          [lotId, lot("Кружка", { deadline, extensionsUsed: 1 })],
        ]),
        frequencyButton: false,
        timeZone,
      },
    );
    expect(view.text).toContain("Дедлайн продлён до 22:45.");
  });

  // Ответ автоставки — тоже торг: время до конца названо и здесь.
  it("names the deadline of the proxy answer", () => {
    const lotId = lotOf(1);
    const view = renderLotNotice(
      { kind: "lot-proxy-raised", lotId, currentPrice: rub(950) },
      {
        lots: new Map([[lotId, lot("Кружка", { deadline })]]),
        frequencyButton: false,
        timeZone,
      },
    );
    expect(view.text).toContain("Торг до 22:45.");
  });

  // Ведение лота вернулось: сообщение называет цену и кнопку лота, а кнопки
  // частоты под ним нет — получатель ставку не делал, частота перебитий его не
  // касается (ADR-072, п. 5).
  it("names the lot whose lead came back and offers only its button", () => {
    const lotId = lotOf(6);
    const view = renderLotNotice(
      { kind: "lot-lead-restored", lotId, currentPrice: rub(950) },
      {
        lots: new Map([[lotId, lot("Кружка", { deadline })]]),
        frequencyButton: true,
        timeZone,
      },
    );
    expect(view.text).toBe(
      `Ты снова ведёшь <b>Кружка</b>. Текущая цена — 950${nbsp}₽. Торг до 22:45.`,
    );
    expect(view.rows).toEqual([[{ kind: "lot", lotId, text: "К лоту" }]]);
  });

  // Напоминание о дедлайне выключается снятием отметки (ADR-063, п.5), а не
  // частотой перебитий: кнопка частоты под ним не ставится.
  it("names the followed lot and offers only its button", () => {
    const lotId = lotOf(3);
    const view = renderLotNotice(
      { kind: "lot-reminder", lotId },
      {
        lots: new Map([[lotId, lot("Кружка", { deadline })]]),
        frequencyButton: true,
        timeZone,
      },
    );
    expect(view.text).toBe(
      "Скоро дедлайн у избранного лота <b>Кружка</b> — до 22:45. Успей сделать ставку.",
    );
    expect(view.rows).toEqual([[{ kind: "lot", lotId, text: "К лоту" }]]);
  });

  // Второй момент того же напоминания говорит о времени прямо: «скоро» здесь
  // было бы пустым словом.
  it("names the deadline of the close reminder", () => {
    const lotId = lotOf(3);
    const view = renderLotNotice(
      { kind: "lot-deadline-close", lotId },
      {
        lots: new Map([[lotId, lot("Кружка", { deadline })]]),
        frequencyButton: true,
        timeZone,
      },
    );
    expect(view.text).toBe(
      "Дедлайн избранного лота <b>Кружка</b> — до 22:45. Успей сделать ставку.",
    );
    expect(view.rows).toEqual([[{ kind: "lot", lotId, text: "К лоту" }]]);
  });

  // Следующий лот финала: оценка длительности — по уже прошедшим лотам.
  it("names the next lot of the final with its estimate", () => {
    const lotId = lotOf(5);
    const view = renderLotNotice(
      { kind: "lot-final-next", lotId, estimatedMinutes: 7 },
      {
        lots: new Map([[lotId, lot("Кружка")]]),
        frequencyButton: true,
        timeZone,
      },
    );
    expect(view.text).toBe(
      "Твой лот следующий: <b>Кружка</b>. Примерно через 7 минут.",
    );
    expect(view.rows).toEqual([[{ kind: "lot", lotId, text: "К лоту" }]]);
  });

  // Сводка за час может набрать много лотов: текст и клавиатура держатся в
  // пределах Telegram, а лоты сверх предела называются числом. Предел — по
  // лотам: вторая строка показанного лота сворачивается в его строку, а не
  // уходит в «ещё».
  it("caps a long digest by lots within the Telegram limits", () => {
    const lines = Array.from({ length: 40 }, (_, index) => ({
      lotId: lotOf(index),
      kind: "outbid" as const,
      currentPrice: rub(1_000_000),
      recipientLeads: false,
    }));
    lines.push({ ...lines[0], kind: "outbid" } as (typeof lines)[number]);
    const lots = new Map(
      lines.map((line) => [line.lotId, lot("Лот ".repeat(80))]),
    );
    const view = renderLotNotice(digest(lines), {
      lots,
      frequencyButton: true,
      timeZone,
    });
    expect(view.text.length).toBeLessThanOrEqual(4096);
    expect(
      view.text.split("\n").filter((row) => row.startsWith("•")),
    ).toHaveLength(DIGEST_LOT_LIMIT);
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
      lotInfo: vi.fn(async () => lot("Кружка")),
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
      timeZone,
    });
    await render(digest(lines), { recipientId: lotOf(99) });
    expect(reads.holdsPlaceBids).toHaveBeenCalledTimes(1);
    expect(reads.lotInfo).toHaveBeenCalledTimes(DIGEST_LOT_LIMIT);
  });

  // Лот, который Auction окончательно не отдаёт, остаётся строкой без
  // названия, но без кнопки: она упёрлась бы в тот же отказ.
  it("leaves out the button of a lot Auction refuses for good", async () => {
    const notFound = Object.assign(new Error("lot not found"), { code: 5 });
    const render = createLotNoticeRender({
      reads: {
        holdsPlaceBids: async () => true,
        lotInfo: async (_who, id) =>
          id === lotOf(1) ? Promise.reject(notFound) : lot("Плакат"),
      },
      onTitleMissing: () => {},
      frequencyButton: false,
      timeZone,
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
      timeZone,
    });
    await expect(
      render(
        { kind: "lot-outbid", lotId: lotOf(1), currentPrice: rub(950) },
        { recipientId: lotOf(99) },
      ),
    ).resolves.toMatchObject({
      kind: "ready",
      message: { text: expect.stringContaining("Твою ставку перебили, цена") },
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
    expect(isLotNotice({ kind: "lot-reminder" })).toBe(true);
    expect(isLotNotice({ kind: "lot-deadline-close" })).toBe(true);
    expect(isLotNotice({ kind: "lot-final-next" })).toBe(true);
    expect(isLotNotice({ kind: "access-granted" })).toBe(false);
  });
});
