import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import {
  AUCTION,
  CONTRACT_IDENTITY,
  CONTRACT_LOT,
  CONTRACT_OP_IDS,
  CONTRACT_USER,
  type PortCall,
  spyPorts,
} from "../../contract/check.js";
import { handleAuctionUpdate } from "../../gateway.js";

const press = (ports: ReturnType<typeof spyPorts>, data: string) =>
  handleAuctionUpdate(
    { kind: "auction", ports },
    {
      identity: CONTRACT_IDENTITY,
      user: CONTRACT_USER,
      input: { kind: "callback", data },
    },
  );

const commandCalls = (calls: readonly PortCall[]) =>
  calls.filter(
    (call) => call.method === "placeBid" || call.method === "setProxyLimit",
  );

describe("bid leaf commands", () => {
  // Повторное нажатие той же «Да» несёт тот же `op_id`: принятую команду
  // Auction узнаёт по нему и второй ставки не создаёт.
  it("sends the same op_id when the same confirmation is pressed twice", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(calls, {
      ...AUCTION,
      bids: [{ kind: "accepted" }, { kind: "accepted" }],
    });
    const confirm = await press(
      ports,
      encodeAuctionCallback({
        kind: "confirm",
        command: "bid",
        lotId: CONTRACT_LOT.lotId,
        amount: 125000,
        page: 0,
      }),
    );
    if (confirm.kind !== "screen") throw new Error("no confirmation");
    const yes = confirm.body.keyboard[0]?.[0];
    if (yes?.action !== "confirm.yes") throw new Error("no yes button");

    await press(ports, yes.callbackData);
    await press(ports, yes.callbackData);

    const opIds = commandCalls(calls).map((call) =>
      call.method === "placeBid" ? call.request.opId : undefined,
    );
    expect(opIds).toEqual([CONTRACT_OP_IDS[0], CONTRACT_OP_IDS[0]]);
  });

  // Два подтверждения — два намерения и два ключа.
  it("gives every confirmation its own op_id", async () => {
    const ports = spyPorts([], AUCTION);
    const data = encodeAuctionCallback({
      kind: "confirm",
      command: "proxy",
      lotId: CONTRACT_LOT.lotId,
      amount: 200000,
      page: 0,
    });
    const yesOf = async () => {
      const result = await press(ports, data);
      if (result.kind !== "screen") throw new Error("no confirmation");
      return result.body.keyboard[0]?.[0]?.callbackData;
    };
    expect(await yesOf()).not.toEqual(await yesOf());
  });

  // Именованный отказ окончателен: вызов один, даже когда за отказом
  // в очереди шпиона стоит принятие.
  it("does not repeat a command after a named refusal", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(calls, {
      ...AUCTION,
      limits: [
        { kind: "refused", refusal: { kind: "proxy-disabled" } },
        { kind: "accepted" },
      ],
    });
    await press(
      ports,
      encodeAuctionCallback({
        kind: "commit",
        command: "proxy",
        lotId: CONTRACT_LOT.lotId,
        opId: CONTRACT_OP_IDS[1],
        amount: 200000,
        page: 0,
      }),
    );
    expect(commandCalls(calls)).toHaveLength(1);
  });

  // Ответ на вопрос принимается только от того, кому вопрос задан.
  it("does not take an answer from someone else", async () => {
    const calls: PortCall[] = [];
    const result = await handleAuctionUpdate(
      { kind: "auction", ports: spyPorts(calls, AUCTION) },
      {
        identity: CONTRACT_IDENTITY,
        user: { telegramUserId: 7 },
        input: {
          kind: "reply",
          data: encodeAuctionCallback({
            kind: "question",
            question: "bid",
            lotId: CONTRACT_LOT.lotId,
            page: 0,
            addressee: CONTRACT_USER.telegramUserId,
          }),
          text: "1300",
        },
      },
    );
    expect(result.kind).toBe("unreadable");
    expect(calls).toEqual([]);
  });
});
