import { describe, expect, it } from "vitest";
import {
  AuctionCallbackError,
  encodeAuctionCallback,
  MAX_FEED_PAGE,
  parseAuctionCallback,
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

  // Кнопка PER-305 без страницы ведёт на ту же карточку, а не в «устарело».
  it("reads a lot button without a page as the first page", () => {
    expect(parseAuctionCallback(`v1:auc:lot:${LOT_TOKEN}`)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId: LOT_ID, page: 0 },
    });
  });

  // Самая длинная кнопка пакета обязана пройти лимит Telegram.
  it("keeps the longest button within 64 bytes", () => {
    const raw = encodeAuctionCallback({
      kind: "feed",
      auctionId: AUCTION_ID,
      page: MAX_FEED_PAGE,
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
    ["extra argument", `v1:auc:lot:${LOT_TOKEN}:1:1`],
    ["feed without page", `v1:auc:feed:${AUCTION_TOKEN}`],
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
