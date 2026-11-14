import { Code, ConnectError } from "@connectrpc/connect";
import type { Chat, Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  botInfo,
  createCapturingLogger,
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import type {
  AccessRight,
  AuctionSummaryView,
  LotView,
  Viewer,
} from "../../../auction-ui/index.js";
import type { Person } from "../application/types.js";
import type {
  AuctionScreenPorts,
  AuctionScreens,
  MeetupAuctionResult,
} from "../auction/port.js";
import { communityChatCommands } from "./commands.js";
import { createCommunityChat } from "./community-chat.js";
import {
  lotWhisper,
  lotWhisperFrame,
  noFinalText,
  readFinalLot,
} from "./community-whisper-lot.js";
import { uuidToToken } from "./meetup-deep-link.js";

// `/lot` в чате сообщества (PER-685; ADR-078, п. 3–4): в живом финале —
// название и цена лота на торгах шёпотом, без имени лидера, и ссылка в бот
// хаба на карточку лота; без финала — «финала нет».

const community = -4012345678;
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const leaderId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402";
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const person: Person = { identityId, rights: ["access-hub", "place-bids"] };
const telegramPerson = { id: 42, is_bot: false, first_name: "tester" };
const today = { year: 2026, month: 11, day: 14 } as const;
const rub = (rubles: number) => ({ minorUnits: rubles * 100, currency: "RUB" });
// Сумму `Intl` пишет с неразрывными пробелами.
const plain = (text: string) => text.replace(/[  ]/g, " ");

const tradingLot: LotView = {
  lotId,
  auctionId,
  version: 4,
  card: { title: "Кружка <с совой>", description: "Ручная роспись." },
  proxyEnabled: true,
  status: {
    kind: "trading",
    currentPrice: rub(1200),
    leaderId,
    phase: "live",
  },
};

function summary(over: Partial<AuctionSummaryView> = {}): AuctionSummaryView {
  return {
    auctionId,
    stage: "in-final",
    final: true,
    lineup: { order: [lotId], activeLotId: lotId },
    ...over,
  };
}

const inFinal: MeetupAuctionResult = {
  kind: "ok",
  auctionId,
  auction: summary(),
};

function fakeAuction(
  current: MeetupAuctionResult,
  lot: () => Promise<LotView> = async () => tradingLot,
) {
  const currentAuction = vi.fn(async () => current);
  const getLot = vi.fn(async (_request: { viewer: Viewer; lotId: string }) =>
    lot(),
  );
  const auction: AuctionScreens = {
    currentAuction,
    screenPorts: () =>
      ({ auction: { getLot } }) as unknown as AuctionScreenPorts,
  };
  return { auction, currentAuction, getLot };
}

const lotLink = `https://t.me/${botInfo.username}?start=l_${uuidToToken(lotId)}`;
const openBotLink = `https://t.me/${botInfo.username}?start=meetups`;

describe("readFinalLot", () => {
  it("reads the active lot of the live final with the person's own rights", async () => {
    const { auction, getLot } = fakeAuction(inFinal);
    expect(
      await readFinalLot({
        auctions: auction,
        lots: auction.screenPorts().auction,
        person,
      }),
    ).toEqual({
      kind: "lot",
      lot: { lotId, title: "Кружка <с совой>", status: tradingLot.status },
    });
    expect(getLot).toHaveBeenCalledWith({
      viewer: { identityId, rights: person.rights },
      lotId,
    });
  });

  it("answers no final without an auction, before the final and for a hidden auction", async () => {
    for (const current of [
      { kind: "ok" },
      { kind: "ok", auctionId, auction: summary({ stage: "prebidding" }) },
      { kind: "ok", auctionId, auction: summary({ stage: "lineup-frozen" }) },
      { kind: "ok", auctionId, auction: summary({ stage: "finished" }) },
      { kind: "ok", auctionId, auction: summary({ hidden: true }) },
    ] satisfies MeetupAuctionResult[]) {
      const { auction, getLot } = fakeAuction(current);
      expect(
        await readFinalLot({
          auctions: auction,
          lots: auction.screenPorts().auction,
          person,
        }),
      ).toEqual({ kind: "no-final" });
      expect(getLot).not.toHaveBeenCalled();
    }
  });

  it("tells the final is between lots when no lot is active", async () => {
    const { auction, getLot } = fakeAuction({
      kind: "ok",
      auctionId,
      auction: summary({ lineup: { order: [lotId] } }),
    });
    expect(
      await readFinalLot({
        auctions: auction,
        lots: auction.screenPorts().auction,
        person,
      }),
    ).toEqual({ kind: "between-lots" });
    expect(getLot).not.toHaveBeenCalled();
  });

  it("names the failure of Auction for the boundary record", async () => {
    const down = fakeAuction({ kind: "timeout", cause: new Error("late") });
    expect(
      await readFinalLot({
        auctions: down.auction,
        lots: down.auction.screenPorts().auction,
        person,
      }),
    ).toEqual({
      kind: "unavailable",
      category: "timeout",
      error: "current auction timeout",
    });
    const refused = fakeAuction(inFinal, async () => {
      throw new ConnectError("lot is gone", Code.Unavailable);
    });
    expect(
      await readFinalLot({
        auctions: refused.auction,
        lots: refused.auction.screenPorts().auction,
        person,
      }),
    ).toEqual({
      kind: "unavailable",
      category: "dependency_unavailable",
      error: "[unavailable] lot is gone",
      grpcCode: "Unavailable",
    });
  });
});

describe("lotWhisperFrame", () => {
  it("names the lot, its price and the ask without the leader", () => {
    const frame = lotWhisperFrame(
      {
        kind: "lot",
        lot: {
          lotId,
          title: "Кружка <с совой>",
          status: { ...tradingLot.status, ask: rub(1500) } as LotView["status"],
        },
      },
      "hub_bot",
    );
    expect(frame.id).toBe("whisper-lot");
    expect(plain(frame.text)).toBe(
      "<b>Лот финала</b>\n\nИдёт финал: сейчас «Кружка &lt;с совой&gt;», цена 1 200 ₽, ведущий объявил 1 500 ₽.",
    );
    expect(frame.text).not.toContain(leaderId);
    expect(frame.links).toEqual([
      {
        label: "Открыть в боте",
        url: `https://t.me/hub_bot?start=l_${uuidToToken(lotId)}`,
      },
    ]);
  });
});

describe("lotWhisper", () => {
  it("hands a failure of Auction to the frame of unavailability", async () => {
    const { auction } = fakeAuction({ kind: "unavailable", cause: "down" });
    expect(
      await lotWhisper(auction).answer({
        person,
        meta: {},
        botUsername: "hub_bot",
        today,
      }),
    ).toEqual({
      kind: "failed",
      message: "final lot unavailable",
      category: "dependency_unavailable",
      error: "current auction unavailable",
    });
  });
});

// Сквозь каркас шёпота (PER-683): невидимая `/lot` в чате сообщества.
describe("whisper to an invisible /lot in the community chat", () => {
  function group(id: number): Chat.GroupChat {
    return { id, type: "group", title: "чат" };
  }

  function invisible(text: string): Update {
    return {
      update_id: 1,
      message: {
        message_id: 0,
        ephemeral_message_id: 7,
        date: Math.floor(Date.now() / 1_000),
        chat: group(community),
        from: telegramPerson,
        receiver_user: { id: 999, is_bot: true, first_name: "hub" },
        text,
      },
    } as Update;
  }

  function harness(options: {
    auction?: AuctionScreens;
    rights?: readonly AccessRight[];
  }) {
    const { logger } = createCapturingLogger();
    const communityChat = createCommunityChat({
      chatId: community,
      commands: communityChatCommands({
        auction: options.auction !== undefined,
      }),
      logger,
    });
    return createHarness(
      {
        resolve: async () => ({
          kind: "resolved",
          identityId,
          rights: options.rights ?? ["access-hub", "place-bids"],
          blocked: false,
        }),
        requestAccess: async () => {
          throw new Error("RequestAccess из чата не зовётся");
        },
      },
      {
        execute: async () => {
          throw new Error("диспетчер `/lot` не зовёт");
        },
      },
      [],
      undefined,
      undefined,
      () => today,
      {
        communityChat,
        ...(options.auction === undefined ? {} : { auction: options.auction }),
      },
    );
  }

  type Sent = {
    text: string;
    reply_parameters?: unknown;
    ephemeral_message_parameters?: unknown;
    reply_markup?: { inline_keyboard: { text: string; url?: string }[][] };
  };

  function onlyWhisper(calls: readonly RecordedCall[]): Sent {
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
    return calls[0]?.payload as unknown as Sent;
  }

  function buttons(sent: Sent) {
    return (sent.reply_markup?.inline_keyboard ?? []).flat();
  }

  it("whispers the active lot and its price with a link to its card and no leader", async () => {
    const fake = fakeAuction(inFinal);
    const { bot, calls, records } = harness({ auction: fake.auction });
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    const sent = onlyWhisper(calls);
    expect(sent).toMatchObject({
      reply_parameters: { ephemeral_message_id: 7 },
      ephemeral_message_parameters: { receiver_user_id: telegramPerson.id },
    });
    expect(plain(sent.text)).toBe(
      "<b>Лот финала</b>\n\nИдёт финал: сейчас «Кружка &lt;с совой&gt;», цена 1 200 ₽.",
    );
    expect(JSON.stringify(sent)).not.toContain(leaderId);
    expect(buttons(sent)).toEqual([{ text: "Открыть в боте ↗", url: lotLink }]);
    expect(records).toContainEqual(
      expect.objectContaining({
        message: "community whisper sent",
        fields: expect.objectContaining({
          use_case: "view_auction",
          screen: "whisper-lot",
        }),
      }),
    );
  });

  it("whispers that there is no final and leads into the bot", async () => {
    const fake = fakeAuction({
      kind: "ok",
      auctionId,
      auction: summary({ stage: "prebidding" }),
    });
    const { bot, calls } = harness({ auction: fake.auction });
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    const sent = onlyWhisper(calls);
    expect(sent.text).toBe(`<b>Лот финала</b>\n\n${noFinalText}`);
    expect(buttons(sent)).toEqual([
      { text: "Открыть бота ↗", url: openBotLink },
    ]);
    expect(fake.getLot).not.toHaveBeenCalled();
  });

  it("whispers that the auctioneer prepares the next lot between lots", async () => {
    const fake = fakeAuction({
      kind: "ok",
      auctionId,
      auction: summary({ lineup: { order: [lotId] } }),
    });
    const { bot, calls } = harness({ auction: fake.auction });
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    expect(onlyWhisper(calls).text).toBe(
      "<b>Лот финала</b>\n\nИдёт финал: ведущий готовит следующий лот.",
    );
  });

  it("does not show the lot to a person without the hub right", async () => {
    const fake = fakeAuction(inFinal);
    const { bot, calls } = harness({
      auction: fake.auction,
      rights: ["place-bids"],
    });
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    const sent = onlyWhisper(calls);
    expect(sent.text).toContain("только по приглашению");
    expect(sent.text).not.toContain("Кружка");
    expect(fake.currentAuction).not.toHaveBeenCalled();
    expect(fake.getLot).not.toHaveBeenCalled();
  });

  it("whispers unavailability when Auction fails", async () => {
    const fake = fakeAuction(inFinal, async () => {
      throw new ConnectError("down", Code.Unavailable);
    });
    const { bot, calls, records } = harness({ auction: fake.auction });
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    expect(onlyWhisper(calls).text).toContain("Не получилось загрузить данные");
    expect(records).toContainEqual(
      expect.objectContaining({
        message: "final lot unavailable",
        fields: expect.objectContaining({
          error_category: "dependency_unavailable",
          grpc_code: "Unavailable",
        }),
      }),
    );
  });

  it("stays silent on /lot without Auction in the configuration", async () => {
    const { bot, calls } = harness({});
    await bot.init();
    await bot.handleUpdate(invisible("/lot"));
    expect(calls.filter((call) => call.method === "sendMessage")).toEqual([]);
  });
});
