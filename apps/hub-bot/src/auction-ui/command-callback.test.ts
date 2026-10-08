import { describe, expect, it } from "vitest";
import {
  type AuctionIntent,
  encodeAuctionCallback,
  isAuctionQuestion,
  MAX_COMMAND_AMOUNT,
  MAX_FEED_PAGE,
  parseAuctionCallback,
} from "./callback-data.js";

// Кнопки листа ставки (PER-317): каждая едет туда и обратно, держит 64 байта
// на худшем случае и не принимает чужого написания.

const LOT_ID = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const OP_ID = "01929b7e-5c1d-7a3f-8e4b-ffffffffffff";
const ADDRESSEE = Number.MAX_SAFE_INTEGER;

const WORST: readonly AuctionIntent[] = [
  {
    kind: "confirm",
    command: "bid",
    lotId: LOT_ID,
    amount: MAX_COMMAND_AMOUNT,
    page: MAX_FEED_PAGE,
  },
  {
    kind: "commit",
    command: "bid",
    lotId: LOT_ID,
    opId: OP_ID,
    amount: MAX_COMMAND_AMOUNT,
    page: MAX_FEED_PAGE,
  },
  {
    kind: "commit",
    command: "proxy",
    lotId: LOT_ID,
    opId: OP_ID,
    amount: MAX_COMMAND_AMOUNT,
    page: MAX_FEED_PAGE,
  },
  { kind: "ask", question: "bid", lotId: LOT_ID, page: MAX_FEED_PAGE },
  { kind: "ask", question: "proxy", lotId: LOT_ID, page: MAX_FEED_PAGE },
  {
    kind: "ask",
    question: "alias",
    lotId: LOT_ID,
    page: MAX_FEED_PAGE,
    pending: { command: "proxy", amount: MAX_COMMAND_AMOUNT },
  },
  {
    kind: "question",
    question: "bid",
    lotId: LOT_ID,
    page: MAX_FEED_PAGE,
    addressee: ADDRESSEE,
  },
  {
    kind: "question",
    question: "alias",
    lotId: LOT_ID,
    page: MAX_FEED_PAGE,
    addressee: ADDRESSEE,
    pending: { command: "bid", amount: MAX_COMMAND_AMOUNT },
  },
  {
    kind: "username",
    lotId: LOT_ID,
    page: MAX_FEED_PAGE,
    pending: { command: "bid", amount: MAX_COMMAND_AMOUNT },
  },
];

describe("bid leaf callback_data", () => {
  it.each(WORST.map((intent) => [intent.kind, intent] as const))(
    "round-trips %s within 64 bytes on the worst case",
    (_, intent) => {
      const raw = encodeAuctionCallback(intent);
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(64);
      expect(parseAuctionCallback(raw)).toEqual({ ok: true, intent });
    },
  );

  it("writes the amount in base36 and the commit with the op_id token", () => {
    expect(
      encodeAuctionCallback({
        kind: "commit",
        command: "bid",
        lotId: LOT_ID,
        opId: OP_ID,
        amount: 125000,
        page: 3,
      }),
    ).toBe("v1:auc:b:AZKbflwdej-OSy1snwobPA:AZKbflwdej-OS________w:2og8:3");
  });

  it("refuses to encode an amount the button cannot carry", () => {
    for (const amount of [0, -1, 1.5, MAX_COMMAND_AMOUNT + 1]) {
      expect(() =>
        encodeAuctionCallback({
          kind: "confirm",
          command: "bid",
          lotId: LOT_ID,
          amount,
          page: 0,
        }),
      ).toThrow(RangeError);
    }
  });

  it.each([
    ["an amount with a leading zero", "v1:auc:cb:AZKbflwdej-OSy1snwobPA:0x:0"],
    ["an amount longer than five", "v1:auc:cb:AZKbflwdej-OSy1snwobPA:100000:0"],
    ["an upper-case amount", "v1:auc:cb:AZKbflwdej-OSy1snwobPA:2OHO:0"],
    ["a commit without op_id", "v1:auc:b:AZKbflwdej-OSy1snwobPA:2oho:0"],
    ["a question without addressee", "v1:auc:qb:AZKbflwdej-OSy1snwobPA:0"],
    ["an addressee with a zero", "v1:auc:qb:AZKbflwdej-OSy1snwobPA:0:042"],
    ["an alias question without command", "v1:auc:aa:AZKbflwdej-OSy1snwobPA:0"],
    ["a bid question with a command", "v1:auc:ab:AZKbflwdej-OSy1snwobPA:0:b1"],
    ["an unknown pending command", "v1:auc:nu:AZKbflwdej-OSy1snwobPA:0:z1"],
  ])("refuses %s", (_, raw) => {
    const parsed = parseAuctionCallback(raw);
    expect(parsed.ok).toBe(false);
  });

  it("tells a question step from other buttons", () => {
    expect(
      isAuctionQuestion(
        encodeAuctionCallback({
          kind: "question",
          question: "bid",
          lotId: LOT_ID,
          page: 0,
          addressee: 42,
        }),
      ),
    ).toBe(true);
    expect(
      isAuctionQuestion(
        encodeAuctionCallback({
          kind: "ask",
          question: "bid",
          lotId: LOT_ID,
          page: 0,
        }),
      ),
    ).toBe(false);
    expect(isAuctionQuestion("v1:mt:open:x")).toBe(false);
  });
});
