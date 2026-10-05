import { describe, expect, it } from "vitest";
import { type BodyRules, inspectBody } from "../../screen-lint/src/index.js";
import { encodeAuctionCallback } from "./callback-data.js";
import { type AuctionSurface, handleAuctionUpdate } from "./gateway.js";
import type { LotView, ResolvedIdentity } from "./ports.js";

// Правила тела экрана (дизайн-код, «Аукцион: тело, шлюз, оболочка»): тело,
// которое шлюз отдаёт обоим ботам, держит предел `callback_data`, по кнопке в
// ряду — пара только у листания — и место под ряд навигации оболочки. Подписи,
// заголовок и навигацию проверяет линтер экрана бота, который тело показал.

const rules: BodyRules = {
  pair: (row) =>
    row.every(({ action }) =>
      ["feed.prev", "feed.next", "history.prev", "history.next"].includes(
        action,
      ),
    ),
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
  status: {
    kind: "trading",
    currentPrice: { minorUnits: 1000 + n, currency: "RUB" },
  },
}));

const identity: ResolvedIdentity = {
  identityId: "01929b7e-0000-7000-8000-000000000001",
  globalRoles: ["member", "public"],
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
            participantId: identity.identityId,
            amount: { minorUnits: 1000 + n, currency: "RUB" },
            origin: { kind: "proxy" as const },
          })),
          nextPageToken: "",
        };
      },
      async getDisplayNames() {
        return {};
      },
    },
  },
};

async function bodyOf(data: string) {
  const result = await handleAuctionUpdate(surface, {
    identity,
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
