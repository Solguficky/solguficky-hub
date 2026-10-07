import { Code, ConnectError } from "@connectrpc/connect";
import {
  encodeAuctionCallback,
  type LotView,
} from "@solguficky/auction-bot-ui";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";
import { describe, expect, it, vi } from "vitest";
import {
  createHarness,
  type HarnessOptions,
  type RecordedCall,
} from "../../testkit/harness.js";
import { createDispatcher } from "../application/dispatcher.js";
import type {
  AuctionScreenPorts,
  AuctionScreens,
  EnableAuctionResult,
  MeetupAuctionResult,
  MeetupAuctions,
} from "../auction/port.js";
import type { IdentityResolver } from "../identity/port.js";
import type { MeetupSnapshot, Meetups } from "../meetups/port.js";
import { createAuctionParents } from "./auction-parents.js";
import { isAuctionCallback } from "./auction-route.js";
import { createLotPhotos } from "./lot-photos.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Аукцион у сходки в боте хаба (PER-307): вход и включение на карточке,
// оболочка ленты и лота с возвратом к сходке и доставка фото лота. Общий
// пакет и Auction подменены: здесь проверяется оболочка хаба, а поведение
// тела держит contract suite (`auction-contract.test.ts`).

const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const meetupToken = uuidToToken(meetupId);
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";

const feedData = encodeAuctionCallback({ kind: "feed", auctionId, page: 0 });
const lotData = encodeAuctionCallback({ kind: "lot", lotId, page: 0 });

function meetup(materials = 0): MeetupSnapshot {
  return {
    id: meetupId,
    title: "Ярмарка",
    description: "",
    venue: "",
    lifecycle: "planned",
    visibility: "visible",
    author: "0192f0a0-0000-7000-8000-00000000a001",
    version: 1,
    materials: Array.from({ length: materials }, (_, index) => ({
      id: `0192f0a0-0000-7000-8000-0000000000b${index}`,
      title: `Материал ${index + 1}`,
      source: { kind: "message-link" as const, url: "https://t.me/c/1/2" },
    })),
  };
}

const lot: LotView = {
  lotId,
  auctionId,
  version: 3,
  card: {
    title: "Кружка с совой",
    description: "Ручная роспись.",
    image: { version: "img-1" },
  },
  proxyEnabled: false,
  status: {
    kind: "scheduled",
    startingPrice: { minorUnits: 50_000, currency: "RUB" },
  },
};

function identity(globalRoles: readonly string[], blocked = false) {
  return {
    resolve: async () => ({
      kind: "resolved" as const,
      identityId,
      globalRoles,
      blocked,
    }),
  } satisfies IdentityResolver;
}

function fakeMeetups(snapshot = meetup(), down = false): Meetups {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    listVisible: notUsed,
    listArchived: notUsed,
    createDraft: notUsed,
    get: async () =>
      down
        ? { kind: "timeout", cause: new Error("budget spent") }
        : { kind: "ok", meetup: snapshot },
    changeAttributes: notUsed,
    setSchedule: notUsed,
    publish: async () => ({
      kind: "ok",
      meetup: { ...snapshot, visibility: "visible" },
    }),
    unpublish: notUsed,
    cancel: notUsed,
    markHeld: notUsed,
    schedulePublication: notUsed,
    cancelPublication: notUsed,
    attachMaterial: notUsed,
    removeMaterial: notUsed,
  };
}

// Auction с аукционом на сходку: ключ выводит сервер из сходки, поэтому второй
// аукцион не рождается ни от какого числа нажатий.
function fakeAuction(
  options: {
    existing?: boolean;
    lookup?: () => MeetupAuctionResult;
    enable?: () => EnableAuctionResult;
    image?: () => Promise<{ content: Uint8Array; version: string }>;
    // Лот ленты и карточки; по умолчанию — запланированный.
    lot?: LotView;
  } = {},
) {
  const shownLot = options.lot ?? lot;
  const auctions = new Map<string, string>(
    options.existing === true ? [[meetupId, auctionId]] : [],
  );
  const opIds: string[] = [];
  const lookups: string[] = [];
  const image =
    options.image ??
    (async () => ({ content: new Uint8Array([1, 2, 3]), version: "img-1" }));
  const getLotImage = vi.fn((_request: { lotId: string }) => image());
  const listAuctionLots = vi.fn(async () => ({
    lots: [shownLot],
    nextPageToken: "",
  }));
  const getLot = vi.fn(async () => shownLot);
  const port: MeetupAuctions & AuctionScreens = {
    async getMeetupAuction(_person, id) {
      lookups.push(id);
      if (options.lookup !== undefined) return options.lookup();
      const found = auctions.get(id);
      return found === undefined
        ? { kind: "ok" }
        : { kind: "ok", auctionId: found };
    },
    async enableAuction(_person, id, opId) {
      opIds.push(opId);
      if (options.enable !== undefined) return options.enable();
      const alreadyExisted = auctions.has(id);
      auctions.set(id, auctionId);
      return { kind: "enabled", auctionId, alreadyExisted };
    },
    screenPorts(): AuctionScreenPorts {
      return {
        auction: {
          getLot,
          listAuctionLots,
          // Ставка соперника и ответ прокси лидера одной командой: момент один.
          listLotHistory: async () => ({
            entries: [
              {
                kind: "bid" as const,
                sequence: 4,
                occurredAt: "2026-10-03T16:04:00Z",
                bidId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401",
                participantId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402",
                amount: { minorUnits: 150_000, currency: "RUB" },
                origin: { kind: "manual" as const, source: "bot" as const },
              },
              {
                kind: "bid" as const,
                sequence: 6,
                occurredAt: "2026-10-03T16:04:00Z",
                bidId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3403",
                participantId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3404",
                amount: { minorUnits: 160_000, currency: "RUB" },
                origin: { kind: "proxy" as const },
              },
            ],
            nextPageToken: "",
          }),
          getDisplayNames: async () => ({}),
          placeBid: async () => ({ kind: "accepted" }),
          setProxyLimit: async () => ({ kind: "accepted" }),
          chooseDisplayName: async () => ({ kind: "accepted", name: "@owl" }),
        },
        operations: {
          newOperationId: () => "0198f2a4-7c1e-7d3a-9b21-00000000c001",
        },
        image: {
          getLotImage: async (request) => ({
            ...(await getLotImage(request)),
            mediaType: "image/jpeg",
          }),
        },
      };
    },
  };
  return {
    port,
    auctions,
    opIds,
    lookups,
    getLotImage,
    listAuctionLots,
    getLot,
  };
}

function harness(
  roles: readonly string[],
  auction: ReturnType<typeof fakeAuction>,
  options: Omit<HarnessOptions, "auction"> & {
    blocked?: boolean;
    snapshot?: MeetupSnapshot;
    meetupsDown?: boolean;
    presentation?: "rich" | "plain";
  } = {},
) {
  const { blocked, snapshot, meetupsDown, presentation, ...rest } = options;
  return createHarness(
    identity(roles, blocked),
    createDispatcher(
      fakeMeetups(snapshot, meetupsDown),
      undefined,
      undefined,
      auction.port,
    ),
    [],
    undefined,
    presentation,
    undefined,
    { auction: auction.port, ...rest },
  );
}

function press(data: string, message: Record<string, unknown> = {}): Update {
  return {
    update_id: 3,
    callback_query: {
      id: "callback-1",
      chat_instance: "chat-1",
      from: { id: 42, is_bot: false, first_name: "tester" },
      data,
      message: {
        message_id: 9,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        text: "Лоты",
        ...message,
      },
    } as never,
  };
}

type Shown = {
  text?: string;
  rich_message?: {
    html?: string;
    media?: { id: string; media: { type: string; media: unknown } }[];
  };
  reply_markup?: {
    inline_keyboard: { text: string; callback_data?: string }[][];
  };
};

function screens(calls: readonly RecordedCall[]): Shown[] {
  return calls
    .filter((call) =>
      ["editMessageText", "sendMessage", "sendRichMessage"].includes(
        call.method,
      ),
    )
    .map((call) => call.payload as Shown);
}

function lastScreen(calls: readonly RecordedCall[]): Shown {
  const shown = screens(calls).at(-1);
  if (shown === undefined) throw new Error("no screen was shown");
  return shown;
}

function labels(shown: Shown): string[][] {
  return (shown.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => button.text),
  );
}

function data(shown: Shown, text: string): string | undefined {
  return shown.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.text === text)?.callback_data;
}

describe("meetup card auction row", () => {
  it("lets a member open the auction of the meetup next to its materials", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["member"], auction, {
      snapshot: meetup(2),
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const card = lastScreen(calls);
    expect(labels(card)).toContainEqual(["Материалы (2)", "Лоты"]);
    expect(data(card, "Лоты")).toBe(feedData);
    expect(JSON.stringify(card)).not.toContain("Включить аукцион");
  });

  it("shows no auction entry at a meetup without an auction", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["member"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const card = lastScreen(calls);
    expect(JSON.stringify(card)).not.toContain("Лоты");
    expect(JSON.stringify(card)).not.toContain("Включить аукцион");
  });

  // На «Опубликовать» бот отвечает экраном исхода; карточка за «‹ Сходка» —
  // та же, что из списка: ряд аукциона на ней есть (PER-468, PER-472).
  it("keeps the auction row on the card opened from the publishing outcome", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["admin"], auction, {
      snapshot: { ...meetup(), visibility: "hidden" },
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:publish:${meetupToken}`));

    const outcome = lastScreen(calls);
    expect(outcome.text).toContain("<b>Сходка опубликована</b>");
    expect(labels(outcome)).toEqual([["‹ Сходка", "Меню"]]);
    expect(JSON.stringify(outcome)).not.toContain("Включить аукцион");

    await bot.handleUpdate(press(data(outcome, "‹ Сходка") ?? ""));

    const card = lastScreen(calls);
    expect(labels(card)).toContainEqual(["Материалы (0)", "Включить аукцион"]);
  });

  it("shows the lots entry on the card opened from the publishing outcome of a meetup with an auction", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["admin"], auction, {
      snapshot: { ...meetup(), visibility: "hidden" },
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:publish:${meetupToken}`));

    const outcome = lastScreen(calls);
    expect(outcome.text).toContain("<b>Сходка опубликована</b>");
    expect(data(outcome, "Лоты")).toBeUndefined();

    await bot.handleUpdate(press(data(outcome, "‹ Сходка") ?? ""));

    const card = lastScreen(calls);
    expect(data(card, "Лоты")).toBe(feedData);
  });

  it("offers enabling to the administrator in the materials row", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["admin"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const card = lastScreen(calls);
    expect(labels(card)).toContainEqual(["Материалы (0)", "Включить аукцион"]);
    expect(data(card, "Включить аукцион")).toBe(
      `v1:manage:auction:${meetupToken}`,
    );
    // Пять рядов организатора не превышены: аукцион встал в ряд материалов.
    expect(card.reply_markup?.inline_keyboard.length).toBeLessThanOrEqual(5);
  });

  it("keeps the card without an auction row when Auction does not answer", async () => {
    const auction = fakeAuction({
      lookup: () => ({ kind: "unavailable", cause: new Error("down") }),
    });
    const { bot, calls } = harness(["admin"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));

    const card = lastScreen(calls);
    expect(card.rich_message?.html ?? card.text).toContain("Ярмарка");
    expect(JSON.stringify(card)).not.toContain("Включить аукцион");
    expect(JSON.stringify(card)).not.toContain("Лоты");
  });

  it("does not call Auction for a person outside the member circle", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["public"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));
    await bot.handleUpdate(press(feedData));

    expect(auction.lookups).toEqual([]);
    expect(auction.listAuctionLots).not.toHaveBeenCalled();
    // Кадр ожидания допуска P-14, а не экран аукциона.
    expect(lastScreen(calls).text).toContain("Заявка на доступ ждёт проверки");
  });

  it("does not call Auction for a blocked person", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot } = harness(["member"], auction, { blocked: true });
    await bot.init();
    await bot.handleUpdate(press(feedData));

    expect(auction.listAuctionLots).not.toHaveBeenCalled();
  });
});

describe("enabling the auction", () => {
  it("enables the auction and shows the outcome, with the card and its entry behind the way back", async () => {
    const auction = fakeAuction();
    const { bot, calls, records } = harness(["admin"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const outcome = lastScreen(calls);
    expect(outcome.text).toContain("<b>Аукцион включён</b>");
    expect(labels(outcome)).toEqual([["‹ Сходка", "Меню"]]);
    expect(data(outcome, "Лоты")).toBeUndefined();
    expect(records.at(-1)?.fields).toMatchObject({
      result: "ok",
      use_case: "enable_auction",
    });
    await bot.handleUpdate(press(data(outcome, "‹ Сходка") ?? ""));
    expect(data(lastScreen(calls), "Лоты")).toBe(feedData);
  });

  it("does not birth a second auction on a repeated press", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["admin"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    expect(auction.auctions.size).toBe(1);
    // Ключ команды рождается на нажатие, а аукцион один.
    expect(new Set(auction.opIds).size).toBe(2);
    expect(lastScreen(calls).text).toContain(
      "<b>Аукцион у этой сходки уже включён</b>",
    );
  });

  it("answers a refusal of the meetup administrator right with a frame back to the card", async () => {
    const auction = fakeAuction({
      enable: () => ({ kind: "not-administrator" }),
    });
    const { bot, calls, records } = harness(["admin"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const frame = lastScreen(calls);
    expect(frame.text).toContain("Это действие тебе недоступно.");
    expect(data(frame, "‹ Сходка")).toBe(`v1:view:${meetupToken}`);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
    });
  });

  it("offers a retry when Auction is unavailable", async () => {
    const auction = fakeAuction({
      enable: () => ({ kind: "unavailable", cause: new Error("down") }),
    });
    const { bot, calls } = harness(["admin"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    expect(data(lastScreen(calls), "Повторить")).toBe(
      `v1:manage:auction:${meetupToken}`,
    );
  });
});

describe("auction feed shell", () => {
  it("returns from the feed to the meetup it was opened from", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["member"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));
    await bot.handleUpdate(press(feedData));

    const feed = lastScreen(calls);
    expect(feed.text).toMatch(/^<b>Лоты<\/b>/);
    expect(labels(feed).at(-1)).toEqual(["‹ Сходка", "Меню"]);
    expect(data(feed, "‹ Сходка")).toBe(`v1:view:${meetupToken}`);
  });

  it("keeps the way back to the meetup through a lot and back to the feed", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["member"], auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:view:${meetupToken}`));
    await bot.handleUpdate(press(lotData));
    const card = lastScreen(calls);
    expect(labels(card).at(-1)).toEqual(["‹ Лоты", "Меню"]);

    const back = data(card, "‹ Лоты");
    if (back === undefined) throw new Error("no way back from the lot");
    await bot.handleUpdate(press(back));
    expect(data(lastScreen(calls), "‹ Сходка")).toBe(`v1:view:${meetupToken}`);
  });

  it("shows the bids of a lot in journal order and returns to the lot", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["member"], auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({
          kind: "history",
          lotId,
          page: 0,
          historyPage: 999,
        }),
      ),
    );
    const history = lastScreen(calls);
    expect(history.text).toMatch(/^<b>Ставки<\/b>/);
    const lines = (history.text ?? "")
      .split("\n")
      .filter((line) => line.includes("₽"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/1\s500\s₽ · вручную$/);
    expect(lines[1]).toMatch(/1\s600\s₽ · авто$/);
    expect(labels(history).at(-1)).toEqual(["‹ Лот", "Меню"]);
    expect(data(history, "‹ Лот")).toBe(lotData);
  });

  it("returns to the upcoming list when the process no longer knows the meetup", async () => {
    const auction = fakeAuction({ existing: true });
    // Рестарт: память процесса пуста, а кнопка ленты осталась в чате.
    const { bot, calls } = harness(["member"], auction, {
      auctionParents: createAuctionParents(),
    });
    await bot.init();
    await bot.handleUpdate(press(feedData));

    const feed = lastScreen(calls);
    expect(labels(feed).at(-1)).toEqual(["‹ Ближайшие", "Меню"]);
    expect(data(feed, "‹ Ближайшие")).toBe("v1:nav:hub");
  });

  it("remembers the meetup from enabling, not only from the card", async () => {
    const auction = fakeAuction();
    const parents = createAuctionParents();
    const { bot } = harness(["admin"], auction, { auctionParents: parents });
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    expect(parents.meetupOf(auctionId)).toBe(meetupId);
  });

  it("offers a retry when Auction does not answer the feed", async () => {
    const auction = fakeAuction({ existing: true });
    auction.listAuctionLots.mockRejectedValue(
      new ConnectError("down", Code.Unavailable),
    );
    const { bot, calls, records } = harness(["member"], auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));

    expect(data(lastScreen(calls), "Повторить")).toBe(feedData);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      use_case: "view_auction",
      error_category: "dependency_unavailable",
    });
  });
});

describe("lot photo delivery", () => {
  const richLot = (fileId: string) => ({
    message_id: 9,
    date: 0,
    chat: { id: 42, type: "private", first_name: "tester" },
    rich_message: {
      blocks: [
        {
          type: "photo",
          photo: [
            { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
            { file_id: fileId, file_unique_id: "l", width: 800, height: 800 },
          ],
        },
      ],
    },
  });

  it("uploads the photo into the rich card and reuses its file_id", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    const { bot, calls } = harness(["member"], auction, {
      lotPhotos: photos,
      respond: (method) =>
        method === "editMessageText" ? richLot("big-file") : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.rich_message?.html).toContain('<img src="tg://photo?id=lot"/>');
    expect(card.rich_message?.media?.[0]?.media.media).toBeInstanceOf(
      InputFile,
    );
    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "file",
      fileId: "big-file",
    });

    await bot.handleUpdate(press(lotData));
    expect(auction.getLotImage).toHaveBeenCalledTimes(1);
    expect(lastScreen(calls).rich_message?.media?.[0]?.media.media).toBe(
      "big-file",
    );
  });

  it("sends the card without a photo when Auction does not give the image", async () => {
    const auction = fakeAuction({
      existing: true,
      image: () => Promise.reject(new ConnectError("no", Code.NotFound)),
    });
    const { bot, calls, records } = harness(["member"], auction);
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.rich_message?.html).toContain("<h1>Кружка с совой</h1>");
    expect(card.rich_message?.media).toBeUndefined();
    expect(
      records.some((record) => record.message === "lot image unavailable"),
    ).toBe(true);
  });

  it("edits the card without a photo when Telegram refuses the upload and skips it next time", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    const { bot, calls } = harness(["member"], auction, {
      lotPhotos: photos,
      respond: (method, payload) =>
        method === "editMessageText" &&
        (payload as Shown).rich_message?.media !== undefined
          ? {
              ok: false,
              error_code: 400,
              description: "Bad Request: IMAGE_PROCESS_FAILED",
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.rich_message?.html).toContain("<h1>Кружка с совой</h1>");
    expect(card.rich_message?.media).toBeUndefined();
    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "rejected",
    });

    await bot.handleUpdate(press(lotData));
    expect(auction.getLotImage).toHaveBeenCalledTimes(1);
  });

  it("shows the lot card as an HTML message without a photo in plain presentation", async () => {
    const auction = fakeAuction({ existing: true });
    const { bot, calls } = harness(["member"], auction, {
      presentation: "plain",
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    const card = lastScreen(calls);
    expect(card.text).toMatch(/^<b>Кружка с совой<\/b>/);
    expect(card.rich_message).toBeUndefined();
    expect(auction.getLotImage).not.toHaveBeenCalled();
  });
});

describe("review findings", () => {
  it("reports an enabled auction when the card cannot be read again", async () => {
    const auction = fakeAuction();
    const parents = createAuctionParents();
    const { bot, calls, records } = harness(["admin"], auction, {
      meetupsDown: true,
      auctionParents: parents,
    });
    await bot.init();
    await bot.handleUpdate(press(`v1:manage:auction:${meetupToken}`));

    const frame = lastScreen(calls);
    expect(frame.text).toContain("Аукцион включён.");
    expect(data(frame, "‹ Сходка")).toBe(`v1:view:${meetupToken}`);
    expect(JSON.stringify(frame)).not.toContain("Повторить");
    expect(parents.meetupOf(auctionId)).toBe(meetupId);
    expect(records.at(-1)?.fields).toMatchObject({ result: "ok" });
  });

  it("leaves a hub button without a version to the hub parser", () => {
    expect(isAuctionCallback("manage:menu")).toBe(false);
    expect(isAuctionCallback("v1:nav:hub")).toBe(false);
    expect(isAuctionCallback(feedData)).toBe(true);
    // Своя кнопка, даже нечитаемая, остаётся аукционной.
    expect(isAuctionCallback("v9:auc:feed:broken")).toBe(true);
  });

  it("shows the blocking frame, not an outage, when Auction is not configured", async () => {
    const { bot, calls } = createHarness(
      identity(["member"], true),
      createDispatcher(fakeMeetups()),
    );
    await bot.init();
    await bot.handleUpdate(press(feedData));

    expect(lastScreen(calls).text).toContain("Доступ к Solguficky Hub закрыт");
  });

  it("names a missing lot, but treats a failing feed as an outage", async () => {
    const auction = fakeAuction({ existing: true });
    auction.getLot.mockRejectedValue(new ConnectError("no", Code.NotFound));
    auction.listAuctionLots.mockRejectedValue(
      new ConnectError("no", Code.NotFound),
    );
    const { bot, calls } = harness(["member"], auction);
    await bot.init();

    await bot.handleUpdate(press(lotData));
    expect(lastScreen(calls).text).toContain("Лот не найден");
    await bot.handleUpdate(press(feedData));
    expect(lastScreen(calls).text).not.toContain("Лот не найден");
    expect(data(lastScreen(calls), "Повторить")).toBe(feedData);
  });

  it("does not mark the photo rejected on a transient Telegram failure", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    const { bot } = harness(["member"], auction, {
      lotPhotos: photos,
      respond: (method, payload) =>
        method === "editMessageText" &&
        (payload as Shown).rich_message?.media !== undefined
          ? {
              ok: false,
              error_code: 429,
              description: "Too Many Requests: retry after 1",
              parameters: { retry_after: 1 },
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(photos.get({ lotId, version: "img-1" })).toBeUndefined();
  });

  it("keeps a working file_id when only the message cannot be edited", async () => {
    const auction = fakeAuction({ existing: true });
    const photos = createLotPhotos();
    photos.set({ lotId, version: "img-1" }, { kind: "file", fileId: "big" });
    const { bot, calls } = harness(["member"], auction, {
      lotPhotos: photos,
      respond: (method) =>
        method === "editMessageText"
          ? {
              ok: false,
              error_code: 400,
              description: "Bad Request: message can't be edited",
            }
          : undefined,
    });
    await bot.init();
    await bot.handleUpdate(press(lotData));

    expect(photos.get({ lotId, version: "img-1" })).toEqual({
      kind: "file",
      fileId: "big",
    });
    expect(auction.getLotImage).not.toHaveBeenCalled();
    const sent = calls.filter((call) => call.method === "sendRichMessage");
    expect(
      (sent.at(-1)?.payload as Shown | undefined)?.rich_message?.media?.[0]
        ?.media.media,
    ).toBe("big");
  });
});

// Лист ставки (PER-317) в оболочке хаба: вопрос новым сообщением с режимом
// ответа, ответ reply-сообщением и «Отмена» по дизайн-коду, «Вопросы».
describe("bid leaf in the hub", () => {
  const trading: LotView = {
    ...lot,
    nextPrice: { minorUnits: 125_000, currency: "RUB" },
    proxyEnabled: true,
    status: {
      kind: "trading",
      currentPrice: { minorUnits: 120_000, currency: "RUB" },
      phase: "online",
    },
  };
  const step = encodeAuctionCallback({
    kind: "question",
    question: "bid",
    lotId,
    page: 0,
    addressee: 42,
  });
  const question = {
    message_id: 9,
    date: 0,
    chat: { id: 42, type: "private", first_name: "tester" },
    from: { id: 1, is_bot: true, first_name: "hub" },
    text: "Своя сумма",
    reply_markup: {
      inline_keyboard: [[{ text: "Отмена", callback_data: step }]],
    },
  };
  const answer = (extra: Record<string, unknown>): Update =>
    ({
      update_id: 5,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 42, is_bot: false, first_name: "tester" },
        reply_to_message: question,
        ...extra,
      },
    }) as Update;
  const setup = async () => {
    const auction = fakeAuction({ existing: true, lot: trading });
    const run = harness(["member", "public"], auction, {
      presentation: "plain",
    });
    await run.bot.init();
    return run;
  };

  it("puts the bid rows on the card of a lot in online trading", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(press(lotData));
    const card = lastScreen(calls);
    expect(labels(card).slice(0, 3)).toEqual([
      [expect.stringMatching(/^По шагу \(1\s250\s₽\)$/)],
      ["Своя сумма"],
      ["Автоставка"],
    ]);
  });

  it("asks the amount in a new message with the reply mode", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({ kind: "ask", question: "bid", lotId, page: 0 }),
      ),
    );
    expect(calls.map((call) => call.method)).toContain(
      "editMessageReplyMarkup",
    );
    const asked = calls.find((call) => call.method === "sendMessage");
    expect(asked?.payload).toMatchObject({
      text: expect.stringContaining("Своя сумма"),
      reply_markup: {
        force_reply: true,
        inline_keyboard: [[{ text: "Отмена", callback_data: step }]],
      },
    });
  });

  it("confirms the typed amount and takes the cancel off the question", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(answer({ text: "1 300" }));
    const confirm = calls.find((call) => call.method === "sendMessage");
    expect(confirm?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Поставить 1\s300\s₽\?<\/b>/),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: expect.stringMatching(/^Да, поставить 1\s300\s₽$/),
              style: "danger",
              callback_data: expect.stringMatching(/^v1:auc:b:/),
            },
          ],
          [{ text: "Нет", callback_data: expect.any(String) }],
        ],
      },
    });
    expect(calls.at(-1)).toMatchObject({
      method: "editMessageReplyMarkup",
      payload: { message_id: 9 },
    });
  });

  // PER-473: принятая ставка — свой экран с «К лоту» и «Меню», а не строка
  // над карточкой с прежней ценой.
  it("answers an accepted bid with its own screen and the lot button", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(
      press(
        encodeAuctionCallback({
          kind: "commit",
          command: "bid",
          lotId,
          opId: "0198f2a4-7c1e-7d3a-9b21-00000000c001",
          amount: 130_000,
          page: 0,
        }),
      ),
    );
    const shown = calls.find((call) => call.method === "editMessageText");
    expect(shown?.payload).toMatchObject({
      text: expect.stringMatching(/^<b>Ставка 1\s300\s₽ принята<\/b>/),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "К лоту",
              callback_data: encodeAuctionCallback({
                kind: "lot",
                lotId,
                page: 0,
              }),
            },
            { text: "Меню", callback_data: "v1:nav:start" },
          ],
        ],
      },
    });
  });

  // Непринятый ответ — свой экран новым сообщением (PER-472): причина в
  // заголовке, «Ввести заново» и «К лоту» вместо режима ответа.
  it.each([
    [{ text: "много" }, "Это не сумма"],
    [{ text: "$20" }, "Ставки принимаются только в рублях"],
    [{ sticker: { file_id: "s" } }, "Нужен ответ текстом"],
  ])(
    "answers a refused %j with its own screen and a retry",
    async (extra, reason) => {
      const { bot, calls } = await setup();
      await bot.handleUpdate(answer(extra));
      const sent = calls.find((call) => call.method === "sendMessage");
      const payload = sent?.payload as
        | {
            text?: string;
            reply_markup?: { inline_keyboard?: { text: string }[][] };
          }
        | undefined;
      expect(payload?.text?.startsWith(`<b>${reason}</b>`)).toBe(true);
      expect(
        payload?.reply_markup?.inline_keyboard?.map((row) =>
          row.map((button) => button.text),
        ),
      ).toEqual([["Ввести заново"], ["К лоту", "Меню"]]);
    },
  );

  it("deletes the question on cancel and sends the card anew", async () => {
    const { bot, calls } = await setup();
    await bot.handleUpdate(press(step, question));
    const methods = calls.map((call) => call.method);
    expect(methods.indexOf("deleteMessage")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("deleteMessage")).toBeLessThan(
      methods.indexOf("sendMessage"),
    );
    expect(methods).not.toContain("editMessageText");
  });
});
