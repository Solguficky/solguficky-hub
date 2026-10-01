import { describe, expect, it } from "vitest";
import {
  AuctionCallbackError,
  encodeAuctionCallback,
  parseAuctionCallback,
} from "./callback-data.js";

const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const LOT_TOKEN = "AZKbflwdej-OSy1snwobPA";

function reasonOf(raw: unknown): string {
  const parsed = parseAuctionCallback(raw);
  if (parsed.ok) throw new Error(`accepted ${String(raw)}`);
  expect(parsed.error).toBeInstanceOf(AuctionCallbackError);
  expect(parsed.error.name).toBe("AuctionCallbackError");
  return parsed.error.reason;
}

describe("auction callback_data", () => {
  it("encodes a lot in the hub format and parses it back", () => {
    const raw = encodeAuctionCallback({ kind: "lot", lotId: LOT_ID });
    expect(raw).toBe(`v1:auc:lot:${LOT_TOKEN}`);
    expect(parseAuctionCallback(raw)).toEqual({
      ok: true,
      intent: { kind: "lot", lotId: LOT_ID },
    });
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
    ["empty domain", `v1::lot:${LOT_TOKEN}`],
    ["missing action", "v1:auc"],
    ["unknown action", `v1:auc:bid:${LOT_TOKEN}`],
    ["missing argument", "v1:auc:lot"],
    ["empty argument", "v1:auc:lot:"],
    ["extra argument", `v1:auc:lot:${LOT_TOKEN}:1`],
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
      encodeAuctionCallback({ kind: "lot", lotId: "LOT-1" }),
    ).toThrow();
  });
});
