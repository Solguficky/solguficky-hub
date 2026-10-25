import { describe, expect, it } from "vitest";
import { type BodyRules, inspectBody } from "../../testkit/lint/index.js";
import {
  encodeAuctionCallback,
  MAX_COMMAND_AMOUNT,
  MAX_FEED_PAGE,
} from "./callback-data.js";
import { type AuctionSurface, handleAuctionUpdate } from "./gateway.js";
import type { LotView, ResolvedIdentity } from "./ports.js";

// Правила тела экрана (дизайн-код, «Аукцион: тело, шлюз, оболочка»): тело,
// которое шлюз отдаёт обоим ботам, держит предел `callback_data`, по кнопке в
// ряду — пара только у листания, у подтверждения `[Да, …] [Нет]` (решение
// владельца 10 октября 2026 года) и у групп карточки лота (PER-594), три —
// только у листания лотов с «Обновить» посередине (PER-669), — и место под ряд
// навигации оболочки.
// Подписи, заголовок и навигацию проверяет линтер экрана бота, который тело
// показал.

const rules: BodyRules = {
  pair: (row) =>
    (row.length === 2 &&
      row.every(({ action }) =>
        ["feed.prev", "feed.next", "history.prev", "history.next"].includes(
          action,
        ),
      )) ||
    [
      "confirm.yes|confirm.no",
      // Пары карточки лота складываются по смыслу (PER-594, PER-644,
      // PER-669), листание лотов — с «Обновить» посередине.
      "lot.bid-custom|lot.proxy",
      "lot.history|lot.follow",
      "lot.history|lot.unfollow",
      "lot.prev|lot.refresh|lot.next",
      "lot.prev|lot.refresh",
      "lot.refresh|lot.next",
      "lot.prev|lot.next",
    ].includes(row.map(({ action }) => action).join("|")),
  // Общий потолок двенадцать рядов. Оболочка бота аукциона сегодня ставит
  // под телом два ряда — FAQ и меню, — и пока исключение `rows` ленты в её
  // каталоге снимает и потолок экрана, место под оба держит этот тест.
  maxRows: 10,
};

// Идентификаторы в полную длину UUID: предел байтов проверяется на худшем
// случае, а не на коротком тестовом ключе.
const auctionId = "01929b7e-5c1d-7a3f-8e4b-0000000000a1";
const lots: LotView[] = Array.from({ length: 20 }, (_, n) => ({
  lotId: `01929b7e-5c1d-7a3f-8e4b-${String(n).padStart(12, "0")}`,
  auctionId,
  version: 1,
  card: { title: `Лот ${n}`, description: "" },
  // Порог у потолка кнопки: сумма в `callback_data` — самая длинная.
  nextPrice: { minorUnits: MAX_COMMAND_AMOUNT, currency: "RUB" },
  proxyEnabled: true,
  status: {
    kind: "trading",
    currentPrice: { minorUnits: 1000 + n, currency: "RUB" },
    phase: "online",
  },
}));

// Лот сета (PER-510): сет назван, и в нём второй лот.
const SET_LOT_ID = "01929b7e-5c1d-7a3f-8e4b-00000000f001";
lots.push({
  lotId: SET_LOT_ID,
  auctionId,
  version: 1,
  card: { title: "Лот сета", description: "" },
  proxyEnabled: true,
  status: {
    kind: "trading",
    currentPrice: { minorUnits: 1000, currency: "RUB" },
    phase: "online",
  },
  lotSet: {
    name: "Лесные дары",
    lotIds: [SET_LOT_ID, "01929b7e-5c1d-7a3f-8e4b-00000000f002"],
  },
});

// Самый длинный Telegram id: адресат вопроса едет в его «Отмене».
const user = {
  telegramUserId: Number.MAX_SAFE_INTEGER,
  telegramUsername: "owl_fan",
};

const identity: ResolvedIdentity = {
  viewer: {
    identityId: "01929b7e-0000-7000-8000-000000000001",
    rights: ["place-bids"],
  },
  blocked: false,
};

const surface: AuctionSurface = {
  kind: "auction",
  ports: {
    identity: {
      async resolveIdentity() {
        return identity;
      },
    },
    auction: {
      findLot: async () => undefined,
      async getLot({ lotId }) {
        const lot = lots.find((candidate) => candidate.lotId === lotId);
        if (lot === undefined) throw new Error(`no lot ${lotId}`);
        return lot;
      },
      async listAuctionLots() {
        return { lots, nextPageToken: "" };
      },
      async listLotHistory() {
        return {
          entries: Array.from({ length: 20 }, (_, n) => ({
            kind: "bid" as const,
            sequence: n + 4,
            occurredAt: "2026-10-04T12:00:00Z",
            bidId: `01929b7e-5c1d-7a3f-8e4b-1${String(n).padStart(11, "0")}`,
            participantId: identity.viewer.identityId,
            amount: { minorUnits: 1000 + n, currency: "RUB" },
            origin: { kind: "proxy" as const },
          })),
          nextPageToken: "",
        };
      },
      getOwnDisplayName: async () => ({ text: "@fake", frozen: false }),
      async getDisplayNames() {
        return {};
      },
      async placeBid() {
        return {
          kind: "refused",
          refusal: { kind: "display-name-not-chosen" },
        };
      },
      async setProxyLimit() {
        return { kind: "accepted", lotVersion: 0 };
      },
      async chooseDisplayName() {
        return { kind: "accepted", name: "@owl_fan" };
      },
      // Розыгрыш открыт: его ряд в ленте считается в пределе рядов тела.
      async getAuction() {
        return undefined;
      },
      async getRaffle() {
        return {
          auctionId,
          status: "open" as const,
          closesAt: "2026-10-29T18:00:00Z",
          registered: false,
          tickets: [],
        };
      },
      async registerForRaffle() {
        throw new Error("not used");
      },
      async cancelRaffleRegistration() {
        throw new Error("not used");
      },
      async listMyInvoices() {
        return { invoices: [] };
      },
      async chooseFulfillment() {
        throw new Error("not used");
      },
      async getMyPredictions() {
        return [];
      },
      async getPredictionResults() {
        throw new Error("not used");
      },
      getDayChronicle: async () => {
        throw new Error("not used");
      },
      async submitPrediction() {
        throw new Error("not used");
      },
    },
    operations: {
      newOperationId() {
        return "01929b7e-5c1d-7a3f-8e4b-ffffffffffff";
      },
    },
  },
};

async function bodyOf(data: string) {
  const result = await handleAuctionUpdate(surface, {
    identity,
    user,
    input: { kind: "callback", data },
  });
  if (result.kind !== "screen") throw new Error(`no screen: ${result.kind}`);
  return result.body;
}

describe("auction screen body", () => {
  it.each([0, 1, 2])(
    "keeps feed page %i within the body rules",
    async (page) => {
      const body = await bodyOf(
        encodeAuctionCallback({ kind: "feed", auctionId, page }),
      );
      expect(inspectBody(body.keyboard, rules)).toEqual([]);
    },
  );

  it("keeps the lot card within the body rules", async () => {
    const lot = lots.at(-1);
    if (lot === undefined) throw new Error("no lots");
    const body = await bodyOf(
      encodeAuctionCallback({ kind: "lot", lotId: lot.lotId, page: 2 }),
    );
    expect(inspectBody(body.keyboard, rules)).toEqual([]);
  });

  // Экран сета (PER-510): ряд на каждый лот сета и возврат.
  it("keeps the set screen within the body rules", async () => {
    const body = await bodyOf(
      encodeAuctionCallback({ kind: "set", lotId: SET_LOT_ID, page: 2 }),
    );
    expect(inspectBody(body.keyboard, rules)).toEqual([]);
  });

  // Лист ставки на худшем случае: последняя страница ленты, сумма у потолка
  // и самый длинный адресат вопроса.
  const lotId = "01929b7e-5c1d-7a3f-8e4b-000000000013";
  const pending = { command: "bid" as const, amount: MAX_COMMAND_AMOUNT };
  it.each([
    [
      "confirm",
      encodeAuctionCallback({
        kind: "confirm",
        command: "bid",
        lotId,
        amount: MAX_COMMAND_AMOUNT,
        page: MAX_FEED_PAGE,
      }),
    ],
    [
      "name choice",
      encodeAuctionCallback({
        kind: "commit",
        command: "bid",
        lotId,
        opId: "01929b7e-5c1d-7a3f-8e4b-ffffffffffff",
        amount: MAX_COMMAND_AMOUNT,
        page: MAX_FEED_PAGE,
      }),
    ],
    [
      "alias question",
      encodeAuctionCallback({
        kind: "ask",
        question: "alias",
        lotId,
        page: MAX_FEED_PAGE,
        pending,
      }),
    ],
    [
      "limit result",
      encodeAuctionCallback({
        kind: "commit",
        command: "proxy",
        lotId,
        opId: "01929b7e-5c1d-7a3f-8e4b-ffffffffffff",
        amount: MAX_COMMAND_AMOUNT,
        page: MAX_FEED_PAGE,
      }),
    ],
  ])("keeps the %s body within the body rules", async (_, data) => {
    const body = await bodyOf(data);
    expect(inspectBody(body.keyboard, rules)).toEqual([]);
  });

  // Средняя страница — с обеими кнопками листания: худший ряд пары.
  it.each([0, 1, 2])(
    "keeps lot history page %i within the body rules",
    async (historyPage) => {
      const lot = lots.at(-1);
      if (lot === undefined) throw new Error("no lots");
      const body = await bodyOf(
        encodeAuctionCallback({
          kind: "history",
          lotId: lot.lotId,
          page: 999,
          historyPage,
        }),
      );
      expect(inspectBody(body.keyboard, rules)).toEqual([]);
    },
  );
});
