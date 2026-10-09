import type { Update } from "grammy/types";
import { describe, expect, it } from "vitest";
import {
  createHarness,
  type RecordedCall,
} from "../../../../testkit/harness.js";
import {
  type AccessRight,
  encodeAuctionCallback,
  type LotView,
  type Money,
} from "../../../auction-ui/index.js";
import { createDispatcher } from "../application/dispatcher.js";
import type {
  AuctionConsoleView,
  ConsoleAuctionStatus,
  ConsoleLot,
} from "../application/types.js";
import type {
  AuctionConsoles,
  AuctionScreens,
  AuctionWeekConfig,
  ConsoleReadResult,
  FinalistResult,
  LotAdministration,
  MeetupAuctions,
} from "../auction/port.js";
import type { IdentityResolver } from "../identity/port.js";
import { uuidToToken } from "./meetup-deep-link.js";

// Пульт аукциона администратора в боте хаба (PER-320): вход из ленты, сроки
// недели и финал, открытие недели через подтверждение, отметка лотов для
// финала и просроченные лоты. Auction подменён одним состоянием на чтение
// пульта и его команды; бот пересоздаётся там, где проверяется рестарт.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const auctionToken = uuidToToken(auctionId);
const identityId = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd";
const vaseId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const mugId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
const timeZone = "Europe/Moscow";
const today = () => ({ year: 2026, month: 10, day: 6 });
// Часы бота в тестах: 6 октября 2026 года, 12:00 по Москве.
const now = new Date("2026-10-06T09:00:00Z");

const consoleData = `v1:ac:v:${auctionToken}`;
const feedData = encodeAuctionCallback({ kind: "feed", auctionId, page: 0 });

const rub = (minorUnits: number): Money => ({ minorUnits, currency: "RUB" });

const week = {
  opensAt: "2026-10-20T15:00:00Z",
  closesAt: "2026-10-26T21:00:00Z",
};

function trading(lotId: string, title: string, price: number): LotView {
  return {
    lotId,
    auctionId,
    version: 3,
    card: { title, description: "" },
    proxyEnabled: false,
    status: { kind: "trading", currentPrice: rub(price), phase: "online" },
  };
}

// Права, как их выводит Identity: круг `admin` несёт право администрировать
// аукцион, участник — только права хаба и аукциона. `rights` задаёт тест,
// которому нужен администратор без каталога — мейнтейнер с управлением.
function identity(
  globalRoles: readonly string[],
  rights: readonly AccessRight[] = globalRoles.includes("admin")
    ? [
        "hub",
        "auction",
        "manage-membership",
        "moderate-auction",
        "manage-auction",
      ]
    : ["hub", "auction"],
) {
  return {
    resolve: async () => ({
      kind: "resolved" as const,
      identityId,
      globalRoles,
      rights,
      blocked: false,
    }),
  } satisfies IdentityResolver;
}

type Command = { method: string; args: unknown };

// Auction пульта: одно состояние на чтение и команды. Открытие недели
// принимает повтор того же ключа и отвечает «не запланирован» новому ключу на
// открытом аукционе — как сервис.
function fakeAuction(
  options: {
    status?: ConsoleAuctionStatus;
    week?: AuctionConsoleView["week"];
    lots?: readonly ConsoleLot[];
    // Отказ чтения пульта: Auction не признал администратора сходки.
    refuse?: true;
    // Лоты, у которых дедлайн прошёл: отметка финала им отказана.
    deadlinePassed?: readonly string[];
    // Отбирать некуда: у аукциона в сервисе нет финала.
    notApplicable?: true;
  } = {},
) {
  const state: {
    status: ConsoleAuctionStatus;
    week?: AuctionConsoleView["week"];
    lots: ConsoleLot[];
    startedBy?: string;
    discarded?: true;
  } = {
    status: options.status ?? "draft",
    ...(options.week === undefined ? {} : { week: options.week }),
    lots: [...(options.lots ?? [])],
  };
  const commands: Command[] = [];
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  const mark =
    (selected: boolean) =>
    async (
      _person: unknown,
      marked: { auctionId: string; lotId: string; opId: string },
    ): Promise<FinalistResult> => {
      commands.push({
        method: selected ? "selectForFinal" : "deselectForFinal",
        args: marked,
      });
      if (selected && options.notApplicable === true) {
        return { kind: "refused", reason: "selection-not-applicable" };
      }
      if (options.deadlinePassed?.includes(marked.lotId)) {
        return { kind: "refused", reason: "deadline-passed" };
      }
      state.lots = state.lots.map((each) =>
        each.lot.lotId === marked.lotId
          ? { ...each, markedForFinal: selected }
          : each,
      );
      return { kind: "ok" };
    };
  const port: MeetupAuctions &
    AuctionScreens &
    LotAdministration &
    AuctionConsoles = {
    getMeetupAuction: notUsed,
    enableAuction: notUsed,
    createLotCard: notUsed,
    editLotCard: notUsed,
    addLot: notUsed,
    scheduleLot: notUsed,
    getLot: notUsed,
    async getAuctionConsole(): Promise<ConsoleReadResult> {
      commands.push({ method: "getAuctionConsole", args: auctionId });
      if (options.refuse === true) return { kind: "not-administrator" };
      return {
        kind: "ok",
        console: {
          auctionId,
          status: state.status,
          ...(state.week === undefined ? {} : { week: state.week }),
          lots: state.lots,
        },
      };
    },
    async getAuctionLotStatistics() {
      return {
        kind: "ok" as const,
        lots: state.lots.map((each) => ({
          lotId: each.lot.lotId,
          bidCount: each.bidCount,
          uniqueParticipantCount: each.uniqueParticipantCount,
        })),
      };
    },
    async scheduleAuction(_person, config: AuctionWeekConfig) {
      commands.push({ method: "scheduleAuction", args: config });
      if (state.status !== "draft" && state.status !== "scheduled") {
        return { kind: "already-started" };
      }
      state.status = "scheduled";
      state.week = {
        opensAt: config.opensAt,
        closesAt: config.closesAt,
        final: config.final,
      };
      return { kind: "ok" };
    },
    async startPrebidding(_person, start) {
      commands.push({ method: "startPrebidding", args: start });
      if (state.status === "scheduled") {
        state.status = "prebidding";
        state.startedBy = start.opId;
        return { kind: "ok" };
      }
      return state.startedBy === start.opId
        ? { kind: "ok" }
        : { kind: "not-scheduled" };
    },
    async discardAuction(_person, discard) {
      commands.push({ method: "discardAuction", args: discard });
      if (state.discarded === true) return { kind: "ok" };
      if (state.status !== "draft" && state.status !== "scheduled") {
        return { kind: "already-started" };
      }
      state.discarded = true;
      return { kind: "ok" };
    },
    selectForFinal: mark(true),
    deselectForFinal: mark(false),
    screenPorts() {
      return {
        auction: {
          getLot: notUsed,
          listAuctionLots: async () => ({
            lots: state.lots.map((each) => each.lot),
            nextPageToken: "",
          }),
          listLotHistory: notUsed,
          getDisplayNames: async () => ({}),
          placeBid: notUsed,
          setProxyLimit: notUsed,
          chooseDisplayName: notUsed,
        },
        operations: { newOperationId: () => "unused" },
        image: { getLotImage: notUsed },
      };
    },
  };
  return {
    port,
    state,
    commands,
    sent: (method: string) =>
      commands.filter((command) => command.method === method),
  };
}

// Новый бот над тем же Auction и той же историей чата: так выглядит рестарт.
function harness(
  roles: readonly string[],
  auction: ReturnType<typeof fakeAuction>,
  calls: RecordedCall[] = [],
  rights?: readonly AccessRight[],
) {
  return createHarness(
    identity(roles, rights),
    createDispatcher(undefined, undefined, today, auction.port, auction.port, {
      auctions: auction.port,
      timeZone,
      now: () => now,
    }),
    calls,
    undefined,
    "plain",
    today,
    { auction: auction.port, communityTimeZone: timeZone },
  );
}

function press(data: string): Update {
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
        text: "Пульт",
      },
    } as never,
  };
}

type Sent = {
  text?: string;
  reply_markup?: {
    force_reply?: boolean;
    inline_keyboard: {
      text: string;
      callback_data?: string;
      style?: string;
    }[][];
  };
};

function shown(calls: readonly RecordedCall[]): Sent[] {
  return calls
    .filter((call) => ["editMessageText", "sendMessage"].includes(call.method))
    .map((call) => call.payload as Sent);
}

function last(calls: readonly RecordedCall[]): Sent {
  const screen = shown(calls).at(-1);
  if (screen === undefined) throw new Error("nothing was shown");
  return screen;
}

// Сумму `Intl` пишет с неразрывными пробелами; тест сверяет слова.
function spaced(text: string): string {
  return text.replaceAll(/[  ]/g, " ");
}

function plain(screen: Sent): string {
  return spaced(screen.text ?? "").replaceAll(/<\/?b>/g, "");
}

function labels(screen: Sent): string[][] {
  return (screen.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => button.text),
  );
}

function dataOf(screen: Sent, text: string): string {
  const found = screen.reply_markup?.inline_keyboard
    .flat()
    .find((button) => button.text === text)?.callback_data;
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

function toasts(calls: readonly RecordedCall[]): unknown[] {
  return calls
    .filter((call) => call.method === "answerCallbackQuery")
    .map((call) => (call.payload as { text?: string }).text)
    .filter((text) => text !== undefined);
}

// Последний вопрос в чате: его текст, клавиатура и номер сообщения, которым
// ответил бы Telegram, — как их вернёт клиент в `reply_to_message`.
function question(calls: readonly RecordedCall[]) {
  const index = calls.findLastIndex(
    (call) =>
      call.method === "sendMessage" &&
      (call.payload as Sent).reply_markup?.force_reply === true,
  );
  if (index === -1) throw new Error("no question was asked");
  const payload = calls[index]?.payload as Sent;
  return { payload, messageId: 100 + index + 1 };
}

function answer(
  calls: readonly RecordedCall[],
  content: Record<string, unknown>,
  from = 42,
): Update {
  const asked = question(calls);
  return {
    update_id: 4,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 42, type: "private", first_name: "tester" },
      from: { id: from, is_bot: false, first_name: "tester" },
      ...(content as { text?: string }),
      reply_to_message: {
        message_id: asked.messageId,
        date: 0,
        chat: { id: 42, type: "private", first_name: "tester" },
        from: { id: 1, is_bot: true, first_name: "stub" },
        text: asked.payload.text,
        reply_markup: asked.payload.reply_markup,
        // grammY's ReplyMessage intersects Message with a required `undefined`
        // property, which is uninhabitable under exactOptionalPropertyTypes.
      } as never,
    },
  };
}

const vase: ConsoleLot = {
  lot: trading(vaseId, "Ваза", 120_000),
  bidCount: 3,
  uniqueParticipantCount: 2,
  markedForFinal: false,
  overdue: false,
};
const mug: ConsoleLot = {
  lot: trading(mugId, "Кружка", 50_000),
  bidCount: 1,
  uniqueParticipantCount: 1,
  markedForFinal: true,
  overdue: true,
};
// Лот с ценой и шагом откроется вместе с неделей; лот без них — нет.
const priced: ConsoleLot = {
  lot: {
    ...trading(vaseId, "Ваза", 0),
    status: { kind: "scheduled", startingPrice: rub(50_000) },
  },
  bidCount: 0,
  uniqueParticipantCount: 0,
  markedForFinal: false,
  overdue: false,
};
const unpriced: ConsoleLot = {
  lot: { ...trading(mugId, "Кружка", 0), status: { kind: "draft" } },
  bidCount: 0,
  uniqueParticipantCount: 0,
  markedForFinal: false,
  overdue: false,
};

describe("entry into the auction console", () => {
  it("shows the console under the lot entry to the administrator only", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const admin = harness(["admin", "public"], auction);
    await admin.bot.init();
    await admin.bot.handleUpdate(press(feedData));
    const feed = last(admin.calls);
    expect(labels(feed).slice(0, 2)).toEqual([
      ["Добавить лот"],
      ["Пульт", "Правила и FAQ"],
    ]);
    expect(dataOf(feed, "Пульт")).toBe(consoleData);

    const member = harness(["member", "public"], auction);
    await member.bot.init();
    await member.bot.handleUpdate(press(feedData));
    expect(JSON.stringify(shown(member.calls))).not.toContain("Пульт");
  });

  // «Добавить лот» — пока онлайн-неделя не открыта (PER-468): после старта
  // Auction отвечает `lots_frozen`, и кнопка вела бы в отказ после вопроса.
  it("shows the lot entry while the auction still accepts lots", async () => {
    for (const status of ["draft", "scheduled"] as const) {
      const auction = fakeAuction({ status, lots: [vase] });
      const { bot, calls } = harness(["admin", "public"], auction);
      await bot.init();
      await bot.handleUpdate(press(feedData));
      expect(labels(last(calls)).slice(0, 2)).toEqual([
        ["Добавить лот"],
        ["Пульт", "Правила и FAQ"],
      ]);
      expect(auction.sent("getAuctionConsole")).toHaveLength(1);
    }
  });

  it("hides the lot entry once the online week is open and keeps the console", async () => {
    const auction = fakeAuction({ status: "prebidding", lots: [vase] });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    const feed = last(calls);
    expect(labels(feed)[0]).toEqual(["Пульт", "Правила и FAQ"]);
    expect(JSON.stringify(feed)).not.toContain("Добавить лот");
  });

  it("keeps the lot entry when the console cannot be read", async () => {
    const auction = fakeAuction({ status: "prebidding", refuse: true });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    expect(labels(last(calls)).slice(0, 2)).toEqual([
      ["Добавить лот"],
      ["Пульт", "Правила и FAQ"],
    ]);
  });

  // Мейнтейнер с выданным управлением — администратор сходки для Meetups, но
  // каталог лотов Auction пускает только по праву администрировать аукцион
  // (ADR-064, дополнение 2026-10-08): входа в форму лота у него нет.
  it("keeps the console and hides the lot entries from an administrator without the catalog right", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const maintainer = [
      "hub",
      "auction",
      "manage-membership",
      "moderate-auction",
    ] as const;
    const { bot, calls } = harness(
      ["admin", "public"],
      auction,
      [],
      maintainer,
    );
    await bot.init();

    await bot.handleUpdate(press(feedData));
    expect(labels(last(calls))[0]).toEqual(["Пульт", "Правила и FAQ"]);
    expect(JSON.stringify(last(calls))).not.toContain("Добавить лот");
    expect(auction.sent("getAuctionConsole")).toEqual([]);

    await bot.handleUpdate(press(`v1:lot:new:${auctionToken}`));
    expect(last(calls).text).toContain("Это действие тебе недоступно.");
    expect(auction.commands).toEqual([]);
  });

  it("does not read the console for a member's feed", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot } = harness(["member", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(feedData));
    expect(auction.sent("getAuctionConsole")).toEqual([]);
  });

  it("refuses an old console button of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot, calls, records } = harness(["member", "public"], auction);
    await bot.init();

    for (const data of [
      consoleData,
      `v1:ac:w:${auctionToken}`,
      `v1:ac:o:${auctionToken}`,
      `v1:ac:s:${auctionToken}:${uuidToToken(vaseId)}:0`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(last(calls).text).toContain("Это действие тебе недоступно.");
    }
    expect(auction.commands).toEqual([]);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
      use_case: "manage_auction",
    });
  });

  it("shows the refusal of Auction to someone it does not take for the administrator of the meetup", async () => {
    const auction = fakeAuction({ refuse: true });
    const { bot, calls, records } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain("Это действие тебе недоступно.");
    expect(labels(last(calls))).toEqual([["Меню"]]);
    expect(records.at(-1)?.fields).toMatchObject({
      result: "error",
      error_category: "authorization",
      error: "not_administrator",
    });
  });
});

describe("auction console", () => {
  it("sorts all lots by the selected metric and toggles the active direction", async () => {
    const fewerParticipants: ConsoleLot = {
      ...vase,
      uniqueParticipantCount: 1,
      priceGrowth: rub(90_000),
    };
    const moreParticipants: ConsoleLot = {
      ...mug,
      uniqueParticipantCount: 4,
      priceGrowth: rub(20_000),
    };
    const noGrowthA: ConsoleLot = {
      ...mug,
      lot: {
        ...mug.lot,
        lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e",
        card: { title: "Без роста A", description: "" },
      },
      uniqueParticipantCount: 0,
    };
    const noGrowthB: ConsoleLot = {
      ...mug,
      lot: {
        ...mug.lot,
        lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3f",
        card: { title: "Без роста B", description: "" },
      },
      uniqueParticipantCount: 0,
    };
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [fewerParticipants, moreParticipants, noGrowthB, noGrowthA],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Люди")));
    const descending = plain(last(calls));
    expect(descending.indexOf("Кружка")).toBeLessThan(
      descending.indexOf("Ваза"),
    );
    expect(descending).toContain("Сортировка: по участникам ↓.");

    await bot.handleUpdate(press(dataOf(last(calls), "Люди")));
    const ascending = plain(last(calls));
    expect(ascending.indexOf("Ваза")).toBeLessThan(ascending.indexOf("Кружка"));
    expect(ascending).toContain("Сортировка: по участникам ↑.");

    await bot.handleUpdate(press(dataOf(last(calls), "Рост")));
    const growth = plain(last(calls));
    expect(growth.indexOf("Ваза")).toBeLessThan(growth.indexOf("Кружка"));
    expect(growth.indexOf("Кружка")).toBeLessThan(
      growth.indexOf("Без роста A"),
    );
    expect(growth.indexOf("Без роста A")).toBeLessThan(
      growth.indexOf("Без роста B"),
    );
    expect(growth).toContain("рост 900 ₽");
  });

  it("keeps the current page when changing the sort metric", async () => {
    const lots = Array.from({ length: 9 }, (_, index) => ({
      ...vase,
      lot: {
        ...vase.lot,
        lotId: `01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b${index.toString(16).padStart(2, "0")}`,
        card: { title: `Лот ${index}`, description: "" },
      },
      bidCount: index,
      uniqueParticipantCount: index,
    }));
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots,
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    await bot.handleUpdate(press(dataOf(last(calls), "→")));

    expect(last(calls).text).toContain("Пульт · 2 из 2");
    await bot.handleUpdate(press(dataOf(last(calls), "Люди")));

    expect(last(calls).text).toContain("Пульт · 2 из 2");
    expect(plain(last(calls))).toContain("Сортировка: по участникам ↓.");
  });

  it("shows the state, the lots with price and bids, the final mark and the overdue lots on their own line", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase, mug],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    const screen = last(calls);
    expect(spaced(screen.text ?? "")).toBe(
      [
        "<b>Пульт</b>",
        "Идут онлайн-торги до 27 октября, вт, 00:00.\nФинал: есть.",
        "Сортировка: по ставкам ↓.",
        [
          "• Ваза — 1 200 ₽ · 3 ставки · 2 уч.",
          "• Кружка — 500 ₽ · 1 ставка · 1 уч. · в финал",
        ].join("\n"),
        "Просрочены, не закрыты: Кружка.",
      ].join("\n\n"),
    );
    expect(labels(screen)).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["В финал · Ваза"],
      ["Снять из финала · Кружка"],
      ["‹ Лоты", "Меню"],
    ]);
    expect(dataOf(screen, "‹ Лоты")).toBe(feedData);
  });

  it("marks a lot for the final and takes the mark off", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "В финал · Ваза")));

    expect(auction.sent("selectForFinal")).toEqual([
      {
        method: "selectForFinal",
        args: { auctionId, lotId: vaseId, opId: expect.any(String) },
      },
    ]);
    // Исход — свой экран без строк пульта; пульт открывает «‹ Пульт».
    expect(last(calls).text).toBe("<b>Лот отмечен для финала</b>");
    expect(labels(last(calls))).toEqual([["‹ Пульт", "Меню"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain(
      "• Ваза — 1 200 ₽ · 3 ставки · 2 уч. · в финал",
    );

    await bot.handleUpdate(
      press(dataOf(last(calls), "Снять из финала · Ваза")),
    );

    expect(auction.sent("deselectForFinal")).toHaveLength(1);
    expect(last(calls).text).toBe("<b>Отметка финала снята</b>");
    expect(labels(last(calls))).toEqual([["‹ Пульт", "Меню"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(labels(last(calls))[0]).toEqual(["Ставки", "Люди", "Рост"]);
    expect(labels(last(calls))).toContainEqual(["В финал · Ваза"]);
  });

  it("shows the refusal of a passed deadline as an outcome screen instead of a success", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
      deadlinePassed: [vaseId],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "В финал · Ваза")));

    const screen = plain(last(calls));
    expect(last(calls).text).toBe(
      "<b>Дедлайн лота прошёл</b>\n\nОтметку финала уже не изменить.",
    );
    expect(screen).not.toContain("Лот отмечен для финала");
    // Строк пульта на экране исхода нет; пульт за «‹ Пульт» без отметки.
    expect(screen).not.toContain("• Ваза");
    expect(labels(last(calls))).toEqual([["‹ Пульт", "Меню"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("• Ваза — 1 200 ₽ · 3 ставки · 2 уч.");
    expect(plain(last(calls))).not.toContain("в финал");
  });
});

describe("week of the auction", () => {
  it("asks the dates, keeps the step over a restart and schedules the week closing the lots, with the final, without lot defaults", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const calls: RecordedCall[] = [];
    const next = async (update: (history: RecordedCall[]) => Update) => {
      const { bot } = harness(["admin", "public"], auction, calls);
      await bot.init();
      await bot.handleUpdate(update(calls));
    };

    await next(() => press(consoleData));
    expect(plain(last(calls))).toContain("Сроки недели не заданы.");
    expect(labels(last(calls))).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["Сроки недели"],
      ["Удалить аукцион"],
      ["‹ Лоты", "Меню"],
    ]);

    await next((history) => press(dataOf(last(history), "Сроки недели")));
    const asked = question(calls).payload;
    expect(dataOf(asked, "Отмена")).toBe(`v1:q:aw:${auctionToken}:42`);
    expect(asked.text).toContain(
      "Например: 20.10.2026 18:00 — 27.10.2026 00:00",
    );

    // Ответ, который не разобран, — экран исхода с причиной в заголовке и
    // «Ввести заново»; тот же вопрос задаёт только эта кнопка.
    await next((history) => answer(history, { text: "на следующей неделе" }));
    expect(last(calls).text).toBe(
      "<b>Не получилось разобрать сроки</b>\n\nНужны начало и конец: ДД.ММ.ГГГГ ЧЧ:ММ — ДД.ММ.ГГГГ ЧЧ:ММ.",
    );
    expect(last(calls).reply_markup?.force_reply).toBeUndefined();
    expect(labels(last(calls))).toEqual([
      ["Ввести заново"],
      ["‹ Пульт", "Меню"],
    ]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));
    expect(question(calls).payload.text).toContain(
      "Например: 20.10.2026 18:00 — 27.10.2026 00:00",
    );
    await next((history) =>
      answer(history, { text: "27.10.2026 00:00 — 20.10.2026 18:00" }),
    );
    expect(last(calls).text).toBe(
      "<b>Конец недели должен быть позже начала</b>",
    );
    expect(auction.sent("scheduleAuction")).toEqual([]);
    await next((history) => press(dataOf(last(history), "Ввести заново")));

    await next((history) =>
      answer(history, { text: "20.10.2026 18:00 — 27.10.2026 00:00" }),
    );

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: {
          auctionId,
          opId: expect.any(String),
          ...week,
          final: true,
        },
      },
    ]);
    // Исход сохранения — свой экран; сроки и кнопки пульта за «‹ Пульт».
    expect(last(calls).text).toBe("<b>Сроки недели сохранены</b>");
    expect(labels(last(calls))).toEqual([["‹ Пульт", "Меню"]]);
    await next((history) => press(dataOf(last(history), "‹ Пульт")));
    const screen = last(calls);
    expect(plain(screen)).toContain(
      "Онлайн-неделя: с 20 октября, вт, 18:00 до 27 октября, вт, 00:00.\nФинал: есть.",
    );
    expect(labels(screen)).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["Сроки недели"],
      ["Вкл · Финал"],
      ["Открыть онлайн-неделю"],
      ["Удалить аукцион"],
      ["‹ Лоты", "Меню"],
    ]);
  });

  it("shows an outcome screen with a retry when the answer is not text", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));

    await bot.handleUpdate(
      answer(calls, { sticker: { file_id: "s", file_unique_id: "s" } }),
    );

    expect(last(calls).text).toBe("<b>Нужен ответ текстом</b>");
    expect(last(calls).reply_markup?.force_reply).toBeUndefined();
    expect(labels(last(calls))).toEqual([
      ["Ввести заново"],
      ["‹ Пульт", "Меню"],
    ]);
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });

  it("names the current dates in the question in the form they are typed", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: false },
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));
    expect(question(calls).payload.text?.split("\n")[0]).toBe(
      "Сейчас: 20.10.2026 18:00 — 27.10.2026 00:00",
    );
    await bot.handleUpdate(
      answer(calls, { text: "21.10.2026 18:00 - 28.10.2026 00:00" }),
    );

    // Новые сроки не трогают выбранный финал.
    expect(auction.sent("scheduleAuction").at(-1)?.args).toMatchObject({
      opensAt: "2026-10-21T15:00:00Z",
      closesAt: "2026-10-27T21:00:00Z",
      final: false,
    });
  });

  it("switches the final with the same dates and confirms the switch with a toast", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    const toggle = dataOf(last(calls), "Вкл · Финал");
    // Кнопка несёт целевое состояние, а не переворот.
    expect(toggle).toBe(`v1:ac:f:${auctionToken}:0`);
    await bot.handleUpdate(press(toggle));

    expect(auction.sent("scheduleAuction")).toEqual([
      {
        method: "scheduleAuction",
        args: { auctionId, opId: expect.any(String), ...week, final: false },
      },
    ]);
    expect(toasts(calls)).toContain("Выключено: финал.");
    expect(plain(last(calls))).toContain("Финал: нет.");
    expect(labels(last(calls))).toContainEqual(["Выкл · Финал"]);

    // Повтор той же кнопки команды не шлёт: финал уже такой.
    await bot.handleUpdate(press(toggle));
    expect(auction.sent("scheduleAuction")).toHaveLength(1);
  });

  it("switches the final back on right after it was switched off", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Вкл · Финал")));
    // Новое чтение видит выключенный финал, и «Вкл» шлёт команду.
    await bot.handleUpdate(press(dataOf(last(calls), "Выкл · Финал")));

    expect(
      auction.sent("scheduleAuction").map((command) => command.args),
    ).toEqual([
      expect.objectContaining({ final: false }),
      expect.objectContaining({ final: true }),
    ]);
    expect(toasts(calls)).toContain("Включено: финал.");
    expect(labels(last(calls))).toContainEqual(["Вкл · Финал"]);
  });

  it("shows an outcome screen with a retry when the end of the week has already come", async () => {
    const auction = fakeAuction();
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:w:${auctionToken}`));

    await bot.handleUpdate(
      answer(calls, { text: "01.10.2026 18:00 — 06.10.2026 12:00" }),
    );

    expect(last(calls).text).toBe("<b>Конец недели уже прошёл</b>");
    expect(labels(last(calls))).toEqual([
      ["Ввести заново"],
      ["‹ Пульт", "Меню"],
    ]);
    expect(auction.sent("scheduleAuction")).toEqual([]);
  });
});

describe("opening the online week", () => {
  it("opens the week only after the confirmation and sends the same key on a repeated press", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced, unpriced],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Открыть онлайн-неделю")));
    const confirm = last(calls);
    expect(plain(confirm)).toContain("Онлайн-неделя");
    // Подтверждение называет, сколько лотов откроется и сколько останется
    // без торгов.
    expect(plain(confirm)).toContain(
      "К ставкам сразу откроются: 1 лот. Торги закроются 27 октября, вт, 00:00.",
    );
    expect(plain(confirm)).toContain(
      "Без цены и шага останутся без торгов: 1 лот.",
    );
    expect(labels(confirm)).toEqual([["Да, открыть неделю"], ["Нет"]]);
    expect(dataOf(confirm, "Нет")).toBe(consoleData);
    expect(auction.sent("startPrebidding")).toEqual([]);

    const yes = dataOf(confirm, "Да, открыть неделю");
    await bot.handleUpdate(press(yes));

    expect(auction.state.status).toBe("prebidding");
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя открыта</b>\n\nЛоты принимают ставки.",
    );
    expect(labels(last(calls))).toEqual([["‹ Пульт", "Меню"]]);
    await bot.handleUpdate(press(dataOf(last(calls), "‹ Пульт")));
    expect(plain(last(calls))).toContain("Идут онлайн-торги до");

    await bot.handleUpdate(press(yes));

    const [first, second] = auction.sent("startPrebidding");
    expect(second?.args).toEqual(first?.args);
    expect(auction.sent("startPrebidding")).toHaveLength(2);
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя открыта</b>\n\nЛоты принимают ставки.",
    );
  });

  it("shows a refusal of an already opened auction as an open week outcome, not as an error", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    const firstYes = dataOf(last(calls), "Да, открыть неделю");
    // Второе подтверждение, полученное до открытия, несёт свой ключ.
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    const secondYes = dataOf(last(calls), "Да, открыть неделю");
    expect(secondYes).not.toBe(firstYes);

    await bot.handleUpdate(press(firstYes));
    await bot.handleUpdate(press(secondYes));

    expect(auction.sent("startPrebidding")).toHaveLength(2);
    const screen = plain(last(calls));
    expect(last(calls).text).toBe("<b>Неделя уже открыта</b>");
    expect(screen).not.toContain("Не получилось");
    // Старая кнопка открытия на открытом аукционе подтверждения не даёт.
    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));
    expect(last(calls).text).toBe("<b>Неделя уже открыта</b>");
    expect(labels(last(calls))).not.toContainEqual(["Да, открыть неделю"]);
  });

  it("names an ended week on an outcome screen instead of a confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: {
        opensAt: "2026-09-28T15:00:00Z",
        closesAt: "2026-10-05T21:00:00Z",
        final: true,
      },
      lots: [priced],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Конец недели уже прошёл</b>\n\nЗадай новые сроки.",
    );
    expect(labels(last(calls))).not.toContainEqual(["Да, открыть неделю"]);
  });

  it("names a registry without priced lots on an outcome screen instead of a confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [unpriced],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(`v1:ac:o:${auctionToken}`));

    expect(last(calls).text).toBe(
      "<b>Нет лотов с ценой и шагом</b>\n\nОткрывать нечего.",
    );
    expect(labels(last(calls))).not.toContainEqual(["Да, открыть неделю"]);
    expect(auction.sent("startPrebidding")).toEqual([]);
  });
});

describe("final selection", () => {
  it("offers no selection for a week without a final but lets the old mark go", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: false },
      lots: [vase, mug],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(labels(last(calls))).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["Снять из финала · Кружка"],
      ["‹ Лоты", "Меню"],
    ]);
  });

  it("shows the refusal of a selection without a final as an outcome screen of the console", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
      notApplicable: true,
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(
      press(`v1:ac:s:${auctionToken}:${uuidToToken(vaseId)}:0`),
    );

    const screen = plain(last(calls));
    expect(last(calls).text).toBe(
      "<b>У недели нет финала</b>\n\nОтбирать лоты некуда.",
    );
    expect(screen).not.toContain("Лот отмечен для финала");
    expect(labels(last(calls))).toEqual([["‹ Пульт", "Меню"]]);
  });

  it("marks a held lot as a finalist without buttons", async () => {
    const held: ConsoleLot = {
      lot: {
        ...trading(vaseId, "Ваза", 120_000),
        status: { kind: "held", currentPrice: rub(120_000) },
      },
      bidCount: 4,
      uniqueParticipantCount: 3,
      markedForFinal: true,
      overdue: false,
    };
    const auction = fakeAuction({
      status: "settling",
      week: { ...week, final: true },
      lots: [held],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();

    await bot.handleUpdate(press(consoleData));

    expect(plain(last(calls))).toContain(
      "• Ваза — 1 200 ₽ · 4 ставки · 3 уч. · в финал",
    );
    expect(labels(last(calls))).toEqual([
      ["Ставки", "Люди", "Рост"],
      ["‹ Лоты", "Меню"],
    ]);
  });
});

describe("discarding the auction", () => {
  it("offers the discard while the week is not open and discards only after the confirmation", async () => {
    const auction = fakeAuction({
      status: "scheduled",
      week: { ...week, final: true },
      lots: [priced],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));

    await bot.handleUpdate(press(dataOf(last(calls), "Удалить аукцион")));
    const confirm = last(calls);
    expect(plain(confirm)).toContain("Удалить аукцион?");
    expect(plain(confirm)).toContain("Из аукциона уйдут: 1 лот.");
    expect(plain(confirm)).toContain(
      "Лоты и сроки пропадут. Включить аукцион у сходки можно заново.",
    );
    expect(labels(confirm)).toEqual([["Да, удалить"], ["Нет"]]);
    expect(dataOf(confirm, "Нет")).toBe(consoleData);
    expect(auction.sent("discardAuction")).toEqual([]);

    const yes = dataOf(confirm, "Да, удалить");
    await bot.handleUpdate(press(yes));
    expect(auction.state.discarded).toBe(true);
    expect(last(calls).text).toBe(
      "<b>Аукцион удалён</b>\n\nВключить его у сходки можно заново.",
    );
    expect(labels(last(calls))).toEqual([["‹ Ближайшие", "Меню"]]);

    // Повторное «Да» несёт тот же ключ: Auction примет его как повтор.
    await bot.handleUpdate(press(yes));
    const [first, second] = auction.sent("discardAuction");
    expect(second?.args).toEqual(first?.args);
  });

  it("offers no discard once the week is open and names it for an old button", async () => {
    const auction = fakeAuction({
      status: "prebidding",
      week: { ...week, final: true },
      lots: [vase],
    });
    const { bot, calls } = harness(["admin", "public"], auction);
    await bot.init();
    await bot.handleUpdate(press(consoleData));
    expect(JSON.stringify(last(calls))).not.toContain("Удалить аукцион");

    await bot.handleUpdate(press(`v1:ac:x:${auctionToken}`));
    expect(last(calls).text).toBe(
      "<b>Онлайн-неделя уже открыта</b>\n\nУдалить аукцион нельзя.",
    );
    expect(auction.sent("discardAuction")).toEqual([]);
  });

  it("refuses an old discard button of someone who is not an administrator before Auction is asked", async () => {
    const auction = fakeAuction({ lots: [vase] });
    const { bot, calls } = harness(["member", "public"], auction);
    await bot.init();

    for (const data of [
      `v1:ac:x:${auctionToken}`,
      `v1:ac:z:${auctionToken}:${uuidToToken(vaseId)}`,
    ]) {
      await bot.handleUpdate(press(data));
      expect(last(calls).text).toContain("Это действие тебе недоступно.");
    }
    expect(auction.commands).toEqual([]);
  });
});
