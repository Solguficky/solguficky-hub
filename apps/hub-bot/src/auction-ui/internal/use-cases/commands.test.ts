import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "../../callback-data.js";
import {
  AUCTION,
  CONTRACT_LOT,
  CONTRACT_OP_IDS,
  CONTRACT_USER,
  type ContractAuction,
  contractIdentity,
  contractViewer,
  type PortCall,
  spyPorts,
} from "../../contract/check.js";
import { AUCTION_SURFACES } from "../../contract/surfaces.js";
import { handleAuctionUpdate } from "../../gateway.js";
import type { LotView, TelegramUser } from "../../ports.js";
import type { AuctionScreenBody } from "../../screen.js";

const press = (ports: ReturnType<typeof spyPorts>, data: string) =>
  handleAuctionUpdate(
    { kind: "auction", ports },
    {
      identity: contractIdentity("auction"),
      user: CONTRACT_USER,
      input: { kind: "callback", data },
    },
  );

const commandCalls = (calls: readonly PortCall[]) =>
  calls.filter(
    (call) => call.method === "placeBid" || call.method === "setProxyLimit",
  );

describe("bid leaf commands", () => {
  // Лот без ставок: порог — стартовая цена (П-01), и автоставка с лимитом,
  // равным ей, сразу ставит её. Подтверждение это называет.
  it("names the first bid in the proxy confirmation of a lot without bids", async () => {
    const unled = {
      ...CONTRACT_LOT,
      nextPrice: { minorUnits: 120000, currency: "RUB" },
      status: {
        kind: "trading" as const,
        currentPrice: { minorUnits: 120000, currency: "RUB" },
        deadline: "2026-10-10T18:00:00Z",
        phase: "online" as const,
      },
    };
    const confirmOf = async (lot: typeof CONTRACT_LOT, amount: number) => {
      const ports = spyPorts([], { ...AUCTION, lots: [lot] });
      const result = await press(
        ports,
        encodeAuctionCallback({
          kind: "confirm",
          command: "proxy",
          lotId: lot.lotId,
          amount,
          page: 0,
        }),
      );
      if (result.kind !== "screen") throw new Error("no confirmation");
      const block = result.body.blocks[0];
      if (block?.kind !== "confirm") throw new Error("no confirm block");
      return block;
    };

    expect((await confirmOf(unled, 120000)).firstBid).toEqual({
      minorUnits: 120000,
      currency: "RUB",
    });
    // С лидером первой ставки нет: лимит перебивает по шагу.
    expect((await confirmOf(CONTRACT_LOT, 200000)).firstBid).toBeUndefined();
  });

  // Повторное нажатие той же «Да» несёт тот же `op_id`: принятую команду
  // Auction узнаёт по нему и второй ставки не создаёт.
  it("sends the same op_id when the same confirmation is pressed twice", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(calls, {
      ...AUCTION,
      bids: [
        { kind: "accepted", lotVersion: 0 },
        { kind: "accepted", lotVersion: 0 },
      ],
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
        { kind: "accepted", lotVersion: 0 },
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

  // Устаревшее «Да»: лот ушёл в живой финал, и ставка финала — не этот лист.
  // Команда не уходит, экран исхода называет отказ.
  it("does not send a stale confirmation once the lot left online trading", async () => {
    const calls: PortCall[] = [];
    const live = {
      ...CONTRACT_LOT,
      status: {
        kind: "trading" as const,
        currentPrice: { minorUnits: 120_000, currency: "RUB" },
        phase: "live" as const,
      },
    };
    const result = await press(
      spyPorts(calls, { ...AUCTION, lots: [live] }),
      encodeAuctionCallback({
        kind: "commit",
        command: "bid",
        lotId: CONTRACT_LOT.lotId,
        opId: CONTRACT_OP_IDS[0],
        amount: 125000,
        page: 0,
      }),
    );
    expect(commandCalls(calls)).toEqual([]);
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toEqual({
      kind: "result",
      result: {
        command: "bid",
        kind: "refused",
        refusal: { kind: "lot-not-open" },
      },
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_LOT.auctionId,
      title: "Кружка с совой",
    });
  });

  // Ответа не было: исход «неизвестен» — свой экран по снимку до команды, а
  // лот перечитывает кнопка «К лоту», поэтому бюджет на второе чтение не
  // тратится.
  it("shows the unknown outcome without reading the lot again", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(calls, {
      ...AUCTION,
      bids: [{ kind: "unanswered" }, { kind: "unanswered" }],
    });
    let reads = 0;
    const getLot = ports.auction.getLot;
    ports.auction.getLot = async (request) => {
      reads += 1;
      if (reads > 1) throw new Error("budget spent");
      return getLot(request);
    };
    const result = await press(
      ports,
      encodeAuctionCallback({
        kind: "commit",
        command: "bid",
        lotId: CONTRACT_LOT.lotId,
        opId: CONTRACT_OP_IDS[0],
        amount: 130000,
        page: 0,
      }),
    );
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toEqual({
      kind: "result",
      result: { command: "bid", kind: "unknown" },
      lotId: CONTRACT_LOT.lotId,
      auctionId: CONTRACT_LOT.auctionId,
      title: "Кружка с совой",
    });
    expect(reads).toBe(1);
  });

  // Ответ на вопрос принимается только от того, кому вопрос задан.
  it("does not take an answer from someone else", async () => {
    const calls: PortCall[] = [];
    const result = await handleAuctionUpdate(
      { kind: "auction", ports: spyPorts(calls, AUCTION) },
      {
        identity: contractIdentity("auction"),
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

// Пример пояснения автоставки (PER-517) не обещает того, чего Auction не
// сделает: не лидеру автоставка сразу ставит порог `nextPrice`, лидеру —
// ничего, и пример называет его цену.
describe("proxy explainer example", () => {
  const ask = (ports: ReturnType<typeof spyPorts>) =>
    press(
      ports,
      encodeAuctionCallback({
        kind: "ask",
        question: "proxy",
        lotId: CONTRACT_LOT.lotId,
        page: 0,
      }),
    );
  const exampleOf = (result: Awaited<ReturnType<typeof ask>>) => {
    if (result.kind !== "screen") throw new Error("no screen");
    const block = result.body.blocks[0];
    if (block?.kind !== "question") throw new Error("no question");
    return block.explainer?.example;
  };

  it("names the threshold as the first bid of someone who does not lead", async () => {
    const example = exampleOf(await ask(spyPorts([], AUCTION)));

    expect(example?.firstBid).toEqual(CONTRACT_LOT.nextPrice);
  });

  it("names no first bid for the leader", async () => {
    const { status } = CONTRACT_LOT;
    if (status.kind !== "trading") throw new Error("lot is not trading");
    const leading = {
      ...CONTRACT_LOT,
      status: {
        ...status,
        leaderId: contractIdentity("auction").viewer.identityId,
      },
    };
    const example = exampleOf(
      await ask(spyPorts([], { ...AUCTION, lots: [leading] })),
    );

    expect(example).toBeDefined();
    expect(example?.firstBid).toBeUndefined();
  });
});

// Ставка с карточки финала без выбранного имени (PER-713): «Поставить» ведёт к
// выбору имени, а выбранное имя ставит ту же цену, если она всё ещё
// следующая. Дерево одно у двух ботов, поэтому сценарий идёт по обеим
// поверхностям.

const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });

const liveAt = (current: number, next: number): LotView => ({
  ...CONTRACT_LOT,
  nextPrice: rub(next),
  status: { kind: "trading", currentPrice: rub(current), phase: "live" },
});

// С ником: экран выбора имени предлагает его одной кнопкой.
const user: TelegramUser = {
  telegramUserId: 424242,
  telegramUsername: "owl_fan",
};

const bids = (calls: readonly PortCall[]) =>
  calls.flatMap((call) =>
    call.method === "placeBid" ? [call.request.amount.minorUnits] : [],
  );

function lotBlock(body: AuctionScreenBody) {
  const block = body.blocks[0];
  if (block?.kind !== "lot") throw new Error(`no lot card: ${block?.kind}`);
  return block;
}

describe.each(AUCTION_SURFACES)(
  "final bid after choosing a name (%s)",
  (surface) => {
    const pressOn = (ports: ReturnType<typeof spyPorts>, data: string) =>
      handleAuctionUpdate(
        { kind: surface, ports },
        {
          identity: contractIdentity(surface),
          user,
          input: { kind: "callback", data },
        },
      );

    // «Поставить 1 300 ₽» без имени: Auction отказывает, и дерево ведёт к выбору
    // имени; кнопка ника несёт отложенную ставку.
    async function pressBidWithoutName(snapshot: ContractAuction) {
      const calls: PortCall[] = [];
      const ports = spyPorts(calls, snapshot, contractIdentity(surface));
      const choice = await pressOn(
        ports,
        encodeAuctionCallback({
          kind: "final-bid",
          lotId: CONTRACT_LOT.lotId,
          amount: rub(1300).minorUnits,
          page: 0,
        }),
      );
      if (choice.kind !== "screen") throw new Error("no name choice");
      expect(choice.body.blocks[0]?.kind).toBe("name-choice");
      const username = choice.body.keyboard
        .flat()
        .find((button) => button.action === "name.username");
      if (username === undefined) throw new Error("no username button");
      return { calls, ports, username: username.callbackData };
    }

    it("places the same bid right after the name is chosen, without a second press", async () => {
      const { calls, ports, username } = await pressBidWithoutName({
        ...AUCTION,
        lots: [liveAt(1200, 1300)],
        bids: [
          { kind: "refused", refusal: { kind: "display-name-not-chosen" } },
          { kind: "accepted", lotVersion: 0 },
        ],
        displayNames: [{ kind: "accepted", name: "@owl_fan" }],
      });

      const result = await pressOn(ports, username);

      expect(bids(calls)).toEqual([rub(1300).minorUnits, rub(1300).minorUnits]);
      if (result.kind !== "screen") throw new Error("no card");
      expect(lotBlock(result.body).finalBid).toEqual({
        kind: "accepted",
        amount: rub(1300),
      });
    });

    // Пока висел выбор имени, человек поставил из другого бота и лидирует: у
    // лидера кнопки ставки нет, и карточка говорит, что цена его.
    it("tells the leader the price is theirs instead of bidding again", async () => {
      const snapshot: ContractAuction = {
        ...AUCTION,
        lots: [liveAt(1200, 1300)],
        bids: [
          { kind: "refused", refusal: { kind: "display-name-not-chosen" } },
        ],
        displayNames: [{ kind: "refused", refusal: "name-frozen" }],
      };
      const { calls, ports, username } = await pressBidWithoutName(snapshot);
      const led: LotView = {
        ...liveAt(1300, 1350),
        status: {
          kind: "trading",
          currentPrice: rub(1300),
          leaderId: contractViewer(surface).identityId,
          phase: "live",
        },
      };
      // Шпион читает лоты из снимка на каждом чтении, а `ContractAuction`
      // держит их только для чтения, поэтому подмена — приведением.
      (snapshot as { lots: readonly LotView[] }).lots = [led];

      const result = await pressOn(ports, username);

      expect(bids(calls)).toEqual([rub(1300).minorUnits]);
      if (result.kind !== "screen") throw new Error("no card");
      expect(lotBlock(result.body).finalBid).toEqual({
        kind: "refused",
        refusal: { kind: "bidder-is-leader", currentPrice: rub(1300) },
      });
    });

    it("shows the new price instead of bidding when it moved while the name was chosen", async () => {
      const snapshot: ContractAuction = {
        ...AUCTION,
        lots: [liveAt(1200, 1300)],
        bids: [
          { kind: "refused", refusal: { kind: "display-name-not-chosen" } },
        ],
        displayNames: [{ kind: "accepted", name: "@owl_fan" }],
      };
      const { calls, ports, username } = await pressBidWithoutName(snapshot);
      // Пока человек выбирал имя, ведущий поднял цену.
      (snapshot as { lots: readonly LotView[] }).lots = [liveAt(1300, 1400)];

      const result = await pressOn(ports, username);

      expect(bids(calls)).toEqual([rub(1300).minorUnits]);
      if (result.kind !== "screen") throw new Error("no card");
      const block = lotBlock(result.body);
      expect(block.finalBid).toEqual({
        kind: "price-changed",
        next: rub(1400),
      });
      expect(block.nextPrice).toEqual(rub(1400));
    });
  },
);

// Повторное открытие после потери памяти процесса и отказы одинаковы у двух ботов.
describe.each(AUCTION_SURFACES)("final recovery (%s)", (surface) => {
  const call = (
    ports: ReturnType<typeof spyPorts>,
    kind: "lot" | "final-bid" = "final-bid",
  ) =>
    handleAuctionUpdate(
      { kind: surface, ports },
      {
        identity: contractIdentity(surface),
        user,
        input: {
          kind: "callback",
          data: encodeAuctionCallback(
            kind === "lot"
              ? { kind, lotId: CONTRACT_LOT.lotId, page: 0 }
              : { kind, lotId: CONTRACT_LOT.lotId, amount: 130000, page: 0 },
          ),
        },
      },
    );

  it("revives a sold card in the final and offers the current lot", async () => {
    const nextId = "01929b7e-5c1d-7a3f-8e4b-0000000000b2";
    const ports = spyPorts(
      [],
      {
        ...AUCTION,
        lots: [
          {
            ...CONTRACT_LOT,
            status: { kind: "sold", winnerId: "rival", price: rub(1400) },
          },
        ],
        summary: {
          auctionId: CONTRACT_LOT.auctionId,
          stage: "in-final",
          final: true,
          lineup: { order: [CONTRACT_LOT.lotId, nextId], activeLotId: nextId },
        },
      },
      contractIdentity(surface),
    );
    const result = await call(ports, "lot");
    if (result.kind !== "screen") throw new Error("no card");
    expect(lotBlock(result.body).live).toEqual({ page: 0 });
    expect(result.body.keyboard.flat()).toContainEqual({
      action: "lot.current",
      callbackData: encodeAuctionCallback({
        kind: "lot",
        lotId: nextId,
        page: 0,
      }),
    });
  });

  it("refuses explicitly if the initial read fails and sends no bid", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(calls, AUCTION, contractIdentity(surface));
    ports.auction.getLot = async () => {
      throw new Error("offline");
    };
    await expect(call(ports)).rejects.toThrow(
      "Аукцион недоступен, ставка не принята",
    );
    expect(commandCalls(calls)).toHaveLength(0);
  });

  it("keeps an unknown outcome if both bid replies and the following read are lost", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(
      calls,
      {
        ...AUCTION,
        lots: [liveAt(1200, 1300)],
        bids: [{ kind: "unanswered" }, { kind: "unanswered" }],
      },
      contractIdentity(surface),
    );
    let reads = 0;
    const initial = ports.auction.getLot;
    ports.auction.getLot = (request) =>
      ++reads === 1 ? initial(request) : Promise.reject(new Error("offline"));
    const result = await call(ports);
    if (result.kind !== "screen") throw new Error("no card");
    expect(lotBlock(result.body).finalBid).toEqual({ kind: "unknown" });
    expect(commandCalls(calls)).toHaveLength(2);
  });

  it("keeps the acknowledged acceptance when the following read fails", async () => {
    const calls: PortCall[] = [];
    const ports = spyPorts(
      calls,
      {
        ...AUCTION,
        lots: [liveAt(1200, 1300)],
        bids: [{ kind: "accepted", lotVersion: 5 }],
      },
      contractIdentity(surface),
    );
    let reads = 0;
    const initial = ports.auction.getLot;
    ports.auction.getLot = (request) =>
      ++reads === 1 ? initial(request) : Promise.reject(new Error("offline"));
    const result = await call(ports);
    if (result.kind !== "screen") throw new Error("no card");
    expect(lotBlock(result.body).finalBid).toEqual({
      kind: "accepted-unread",
      amount: rub(1300),
    });
    expect(commandCalls(calls)).toHaveLength(1);
  });
});

// Лот ждёт финала (PER-821, ADR-079): лимит автоставки принимается и сработает
// в финале по сетке цен, а ставка удержанного лота остаётся отказом.
describe("proxy limit of a lot waiting for the final", () => {
  const { nextPrice: _nextPrice, ...unpriced } = CONTRACT_LOT;
  const held = {
    ...unpriced,
    status: {
      kind: "held" as const,
      currentPrice: { minorUnits: 90_000, currency: "RUB" },
      leaderId: "01929b7e-5c1d-7a3f-8e4b-000000000002",
    },
  };
  const ports = (calls: PortCall[] = [], extra = {}) =>
    spyPorts(calls, { ...AUCTION, lots: [held], ...extra });

  it("refuses a limit below the price before the confirmation", async () => {
    const calls: PortCall[] = [];
    const result = await press(
      ports(calls),
      encodeAuctionCallback({
        kind: "confirm",
        command: "proxy",
        lotId: held.lotId,
        amount: 50_000,
        page: 0,
      }),
    );
    expect(commandCalls(calls)).toEqual([]);
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toMatchObject({
      kind: "result",
      result: {
        refusal: {
          kind: "proxy-below-current-price",
          minLimit: { minorUnits: 90_000, currency: "RUB" },
        },
      },
    });
  });

  it("confirms the limit and names the final", async () => {
    const result = await press(
      ports(),
      encodeAuctionCallback({
        kind: "confirm",
        command: "proxy",
        lotId: held.lotId,
        amount: 150_000,
        page: 0,
      }),
    );
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toMatchObject({
      kind: "confirm",
      command: "proxy",
      forFinal: true,
      currentPrice: { minorUnits: 90_000, currency: "RUB" },
    });
  });

  it("sends the limit and shows it accepted for the final", async () => {
    const calls: PortCall[] = [];
    const result = await press(
      ports(calls, { limits: [{ kind: "accepted", lotVersion: 0 }] }),
      encodeAuctionCallback({
        kind: "commit",
        command: "proxy",
        lotId: held.lotId,
        opId: CONTRACT_OP_IDS[0],
        amount: 150_000,
        page: 0,
      }),
    );
    expect(commandCalls(calls)).toHaveLength(1);
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toMatchObject({
      kind: "accepted",
      command: "proxy",
      forFinal: true,
    });
    expect(result.body.blocks[0]).not.toHaveProperty("favorites");
  });

  it("names a limit below the price as a refusal screen", async () => {
    const result = await press(
      ports([], {
        limits: [
          {
            kind: "refused",
            refusal: {
              kind: "proxy-below-current-price",
              minLimit: { minorUnits: 90_000, currency: "RUB" },
            },
          },
        ],
      }),
      encodeAuctionCallback({
        kind: "commit",
        command: "proxy",
        lotId: held.lotId,
        opId: CONTRACT_OP_IDS[0],
        amount: 50_000,
        page: 0,
      }),
    );
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toMatchObject({
      kind: "result",
      result: { refusal: { kind: "proxy-below-current-price" } },
    });
  });

  it("asks the limit without the online-week example", async () => {
    const result = await press(
      ports(),
      encodeAuctionCallback({
        kind: "ask",
        question: "proxy",
        lotId: held.lotId,
        page: 0,
      }),
    );
    if (result.kind !== "screen") throw new Error("no screen");
    const [block] = result.body.blocks;
    expect(block).toMatchObject({ kind: "question", forFinal: true });
    expect(block).not.toHaveProperty("explainer");
    expect(block).not.toHaveProperty("current");
    expect(result.body.keyboard.flat().map((button) => button.action)).toEqual([
      "question.cancel",
    ]);
  });

  it("still refuses a bid on the held lot without sending it", async () => {
    const calls: PortCall[] = [];
    const result = await press(
      ports(calls),
      encodeAuctionCallback({
        kind: "commit",
        command: "bid",
        lotId: held.lotId,
        opId: CONTRACT_OP_IDS[0],
        amount: 100_000,
        page: 0,
      }),
    );
    expect(commandCalls(calls)).toEqual([]);
    if (result.kind !== "screen") throw new Error("no screen");
    expect(result.body.blocks[0]).toMatchObject({
      kind: "result",
      result: { refusal: { kind: "lot-on-hold" } },
    });
  });
});
