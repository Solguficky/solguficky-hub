import { describe, expect, it } from "vitest";
import {
  AuctionCallbackError,
  encodeAuctionCallback,
  isAuctionQuestion,
  MAX_FEED_PAGE,
  parseAuctionCallback,
  replacesAuctionQuestion,
} from "./callback-data.js";

const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const LOT_TOKEN = "AZKbflwdej-OSy1snwobPA";
const AUCTION_ID = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const AUCTION_TOKEN = "AZKbflwdej-OSwAAAAAAoQ";

function reasonOf(raw: unknown): string {
  const parsed = parseAuctionCallback(raw);
  if (parsed.ok) throw new Error(`accepted ${String(raw)}`);
  expect(parsed.error).toBeInstanceOf(AuctionCallbackError);
  expect(parsed.error.name).toBe("AuctionCallbackError");
  return parsed.error.reason;
}

describe("auction callback_data", () => {
  it("encodes a lot with its feed page and parses it back", () => {
    const raw = encodeAuctionCallback({ kind: "lot", lotId: LOT_ID, page: 3 });
    expect(raw).toBe(`v1:auc:lot:${LOT_TOKEN}:3`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId: LOT_ID, page: 3 },
    });
  });

  // «К лоту» после принятой команды несёт версию лота в base36 (PER-470).
  it("encodes a lot with the version to read it at and parses it back", () => {
    const raw = encodeAuctionCallback({
      kind: "lot",
      lotId: LOT_ID,
      page: 3,
      atLeastVersion: 1295,
    });
    expect(raw).toBe(`v1:auc:lot:${LOT_TOKEN}:3:zz`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId: LOT_ID, page: 3, atLeastVersion: 1295 },
    });
  });

  // Экран сета (ADR-073, п. 7): открывается с карточки лота сета, поэтому
  // несёт его и страницу ленты.
  it("encodes the set of a lot and parses it back", () => {
    const raw = encodeAuctionCallback({
      kind: "set",
      lotId: LOT_ID,
      page: 3,
    });
    expect(raw).toBe(`v1:auc:st:${LOT_TOKEN}:3`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: { kind: "set", lotId: LOT_ID, page: 3 },
    });
  });

  it("fits the largest version with the largest page into 64 bytes", () => {
    const raw = encodeAuctionCallback({
      kind: "lot",
      lotId: LOT_ID,
      page: MAX_FEED_PAGE,
      atLeastVersion: Number.MAX_SAFE_INTEGER,
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64);
    expect(parseAuctionCallback(raw)).toMatchObject({ ok: true });
  });

  it("refuses a lot version that is not one canonical positive number", () => {
    for (const tail of ["0", "0a", "-1", "Z", "1:2", "zzzzzzzzzzzz"]) {
      expect(reasonOf(`v1:auc:lot:${LOT_TOKEN}:3:${tail}`)).toBe("malformed");
    }
    expect(() =>
      encodeAuctionCallback({
        kind: "lot",
        lotId: LOT_ID,
        page: 0,
        atLeastVersion: 0,
      }),
    ).toThrow(RangeError);
  });

  it("encodes a feed page and parses it back", () => {
    const raw = encodeAuctionCallback({
      kind: "feed",
      auctionId: AUCTION_ID,
      page: 0,
    });
    expect(raw).toBe(`v1:auc:feed:${AUCTION_TOKEN}:0`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: { kind: "feed", auctionId: AUCTION_ID, page: 0 },
    });
  });

  // Раздел ленты (PER-719): аукцион, номер раздела и страница.
  it("encodes a section of the feed and parses it back", () => {
    const raw = encodeAuctionCallback({
      kind: "section",
      auctionId: AUCTION_ID,
      sectionId: 12,
      page: 1,
    });
    expect(raw).toBe(`v1:auc:sec:${AUCTION_TOKEN}:12:1`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: {
        kind: "section",
        auctionId: AUCTION_ID,
        sectionId: 12,
        page: 1,
      },
    });
  });

  it("refuses a section of the feed without a valid number or with an extra argument", () => {
    expect(reasonOf(`v1:auc:sec:${AUCTION_TOKEN}:0:0`)).toBe("malformed");
    expect(reasonOf(`v1:auc:sec:${AUCTION_TOKEN}:01:0`)).toBe("malformed");
    expect(reasonOf(`v1:auc:sec:${AUCTION_TOKEN}:1`)).toBe("malformed");
    expect(reasonOf(`v1:auc:sec:${AUCTION_TOKEN}:1:0:0`)).toBe("malformed");
    expect(() =>
      encodeAuctionCallback({
        kind: "section",
        auctionId: AUCTION_ID,
        sectionId: 0,
        page: 0,
      }),
    ).toThrow(RangeError);
  });

  // Кнопка PER-305 без страницы ведёт на ту же карточку, а не в «устарело».
  it("reads a lot button without a page as the first page", () => {
    expect(parseAuctionCallback(`v1:auc:lot:${LOT_TOKEN}`)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId: LOT_ID, page: 0 },
    });
  });

  // Хронология несёт страницу ленты для возврата и свою страницу.
  it("encodes the history of a lot with both pages and parses it back", () => {
    const raw = encodeAuctionCallback({
      kind: "history",
      lotId: LOT_ID,
      page: 3,
      historyPage: 12,
    });
    expect(raw).toBe(`v1:auc:hist:${LOT_TOKEN}:3:12`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: { kind: "history", lotId: LOT_ID, page: 3, historyPage: 12 },
    });
  });

  // Избранное (PER-495): отметка и снятие несут страницу ленты, как кнопка
  // лота, а список — свою страницу и ленту, в которую ведёт возврат.
  it("encodes following, unfollowing and the favorites list and parses them back", () => {
    const cases = [
      [
        { kind: "follow" as const, lotId: LOT_ID, page: 3 },
        `v1:auc:fo:${LOT_TOKEN}:3`,
      ],
      [
        { kind: "unfollow" as const, lotId: LOT_ID, page: 0 },
        `v1:auc:uf:${LOT_TOKEN}:0`,
      ],
      [{ kind: "favorites" as const, page: 2 }, "v1:auc:fav:2"],
      [
        { kind: "favorites" as const, page: 0, auctionId: AUCTION_ID },
        `v1:auc:fav:0:${AUCTION_TOKEN}`,
      ],
    ] as const;
    for (const [intent, raw] of cases) {
      expect(encodeAuctionCallback(intent)).toBe(raw);
      expect(parseAuctionCallback(raw)).toEqual({ ok: true, intent });
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  // «Как это работает» (PER-517) задаёт вопрос лимита заново: шагом вопроса
  // она не является, иначе ответ нашёл бы её вместо «Отмены».
  it("encodes how it works under the limit question and parses it back", () => {
    const intent = { kind: "explain" as const, lotId: LOT_ID, page: 4 };
    const raw = `v1:auc:xe:${LOT_TOKEN}:4`;

    expect(encodeAuctionCallback(intent)).toBe(raw);
    expect(parseAuctionCallback(raw)).toEqual({ ok: true, intent });
    expect(replacesAuctionQuestion(raw)).toBe(true);
    expect(isAuctionQuestion(raw)).toBe(false);
    expect(replacesAuctionQuestion(`v1:auc:lot:${LOT_TOKEN}:4`)).toBe(false);
    for (const malformed of [
      `v1:auc:xe:${LOT_TOKEN}`,
      `v1:auc:xe:${LOT_TOKEN}:4:1`,
      "v1:auc:xe:not-a-token:4",
    ]) {
      expect(reasonOf(malformed)).toBe("malformed");
    }
  });

  it("refuses a favorites button that no encoder writes", () => {
    for (const raw of [
      "v1:auc:fav",
      "v1:auc:fav:01",
      `v1:auc:fav:0:${AUCTION_TOKEN}:1`,
      "v1:auc:fav:0:not-a-token",
      `v1:auc:fo:${LOT_TOKEN}`,
      `v1:auc:uf:${LOT_TOKEN}:1:2`,
    ]) {
      expect(reasonOf(raw)).toBe("malformed");
    }
  });

  it("encodes the raffle actions and parses them back", () => {
    const cases = [
      [{ kind: "prediction-results" as const, auctionId: AUCTION_ID }, "pi"],
      [{ kind: "raffle" as const, auctionId: AUCTION_ID }, "rf"],
      [{ kind: "raffle-register" as const, auctionId: AUCTION_ID }, "rr"],
      [{ kind: "raffle-cancel" as const, auctionId: AUCTION_ID }, "rc"],
      [{ kind: "raffle-username" as const, auctionId: AUCTION_ID }, "ru"],
      [{ kind: "raffle-ask-alias" as const, auctionId: AUCTION_ID }, "ra"],
    ] as const;
    for (const [intent, action] of cases) {
      const raw = `v1:auc:${action}:${AUCTION_TOKEN}`;
      expect(encodeAuctionCallback(intent)).toBe(raw);
      expect(parseAuctionCallback(raw)).toEqual({ ok: true, intent });
    }
    // Шаг вопроса несёт адресата: Telegram id в 52 битах — самая длинная
    // кнопка розыгрыша.
    const question = {
      kind: "raffle-question" as const,
      auctionId: AUCTION_ID,
      addressee: Number.MAX_SAFE_INTEGER,
    };
    const raw = encodeAuctionCallback(question);
    expect(raw).toBe(`v1:auc:rq:${AUCTION_TOKEN}:${Number.MAX_SAFE_INTEGER}`);
    expect(parseAuctionCallback(raw)).toEqual({ ok: true, intent: question });
    expect(isAuctionQuestion(raw)).toBe(true);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64);
  });

  it("refuses a raffle button that no encoder writes", () => {
    for (const raw of [
      "v1:auc:rf",
      "v1:auc:rf:not-a-token",
      `v1:auc:rf:${AUCTION_TOKEN}:1`,
      `v1:auc:rq:${AUCTION_TOKEN}`,
      `v1:auc:rq:${AUCTION_TOKEN}:0`,
      `v1:auc:rq:${AUCTION_TOKEN}:42:1`,
    ]) {
      expect(reasonOf(raw)).toBe("malformed");
    }
  });

  // Самая длинная кнопка пакета обязана пройти лимит Telegram.
  it("keeps the longest button within 64 bytes", () => {
    const raw = encodeAuctionCallback({
      kind: "history",
      lotId: LOT_ID,
      page: MAX_FEED_PAGE,
      historyPage: MAX_FEED_PAGE,
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64);
    expect(parseAuctionCallback(raw).ok).toBe(true);
  });

  // Настоящие кнопки бота хаба: их домен не аукционный, и разбор отдаёт их
  // обратно хабу, а не называет повреждёнными.
  it.each([
    "v1:nav:start",
    "v1:nav:hub",
    "v1:view:AZLzpLXGfY6fChssPU5fYA",
    "v1:meetup:view:AZLzpLXGfY6fChssPU5fYA",
    "v1:manage:menu",
    "v1:mm:ca:AZLzpLXGfY6fChssPU5fYA:AZLzpLXGfY6fChssPU5fYA:12",
    "v1:notify:global",
    "v1:bc:no",
    "v1:community:list",
    "v1:auction:lot:AZKbflwdej-OSy1snwobPA",
    // Чужая кнопка другой версии остаётся чужой, а не устаревшей своей.
    "v2:nav:hub",
    "v0:meetup:view:AZLzpLXGfY6fChssPU5fYA",
  ])("rejects foreign %s", (raw) => {
    expect(reasonOf(raw)).toBe("foreign");
  });

  it.each([
    `v2:auc:lot:${LOT_TOKEN}`,
    `v0:auc:lot:${LOT_TOKEN}`,
    "v12:auc:anything",
  ])("rejects another version %s as outdated", (raw) => {
    expect(reasonOf(raw)).toBe("outdated");
  });

  it.each([
    ["not a string", 42],
    ["undefined", undefined],
    ["empty", ""],
    ["no version", `auc:lot:${LOT_TOKEN}`],
    ["upper-case version", `V1:auc:lot:${LOT_TOKEN}`],
    ["missing domain", "v1"],
    ["missing domain of another version", "v2"],
    ["empty domain", `v1::lot:${LOT_TOKEN}`],
    ["missing action", "v1:auc"],
    ["unknown action", `v1:auc:bid:${LOT_TOKEN}`],
    ["missing argument", "v1:auc:lot"],
    ["empty argument", "v1:auc:lot:"],
    // Третий аргумент лота — версия (PER-470); четвёртого у него нет.
    ["extra argument", `v1:auc:lot:${LOT_TOKEN}:1:1:1`],
    ["feed without page", `v1:auc:feed:${AUCTION_TOKEN}`],
    ["history without its page", `v1:auc:hist:${LOT_TOKEN}:3`],
    ["history with an extra argument", `v1:auc:hist:${LOT_TOKEN}:3:1:1`],
    ["history page over the limit", `v1:auc:hist:${LOT_TOKEN}:3:1000`],
    ["feed with a history page", `v1:auc:feed:${AUCTION_TOKEN}:0:0`],
    ["empty page", `v1:auc:feed:${AUCTION_TOKEN}:`],
    ["page with a leading zero", `v1:auc:feed:${AUCTION_TOKEN}:01`],
    ["negative page", `v1:auc:feed:${AUCTION_TOKEN}:-1`],
    ["page over the limit", `v1:auc:feed:${AUCTION_TOKEN}:1000`],
    ["page that is not a number", `v1:auc:lot:${LOT_TOKEN}:x`],
    ["short token", "v1:auc:lot:AZKbflwdej-OSy1snwobP"],
    ["foreign alphabet", "v1:auc:lot:AZKbflwdej+OSy1snwobPA"],
    // Те же 16 байт, но последний символ несёт ненулевые лишние биты.
    ["non-canonical token", "v1:auc:lot:AZKbflwdej-OSy1snwobPB"],
    ["surrounding spaces", ` v1:auc:lot:${LOT_TOKEN}`],
    ["over 64 bytes", `v1:auc:lot:${LOT_TOKEN}:${"x".repeat(32)}`],
    // 63 символа, но больше 64 байт: Telegram считает байты.
    ["multibyte over 64 bytes", `v1:auc:lot:${"я".repeat(52)}`],
  ])("rejects %s as malformed", (_name, raw) => {
    expect(reasonOf(raw)).toBe("malformed");
  });

  it("refuses to encode an id that is not a canonical UUID", () => {
    expect(() =>
      encodeAuctionCallback({ kind: "lot", lotId: "LOT-1", page: 0 }),
    ).toThrow();
  });

  it.each([-1, 1.5, MAX_FEED_PAGE + 1])(
    "refuses to encode feed page %s",
    (page) => {
      expect(() =>
        encodeAuctionCallback({ kind: "feed", auctionId: AUCTION_ID, page }),
      ).toThrow(RangeError);
    },
  );
});
