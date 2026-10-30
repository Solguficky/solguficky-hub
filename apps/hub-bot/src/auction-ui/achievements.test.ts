import { describe, expect, it, vi } from "vitest";
import { achievementScreen } from "../achievement-screen.js";
import type { AchievementsPort, AchievementView } from "./achievement-types.js";
import {
  encodeAuctionCallback,
  parseAuctionCallback,
  uuidToToken,
} from "./callback-data.js";
import {
  AUCTION,
  CONTRACT_AUCTION_ID,
  CONTRACT_USER,
  contractIdentity,
  spyPorts,
} from "./contract/check.js";
import { handleAuctionUpdate } from "./gateway.js";

const definition: AchievementView = {
  code: "first",
  title: "Первая ачивка",
  description: "За участие",
  imageVersion: "v1",
  recipients: "many",
  manual: false,
};
const grantId = "01929b7e-5c1d-7a3f-8e4b-0000000000b1";
function fixture(kind: "hub" | "auction") {
  const identity = contractIdentity(kind);
  const calls: Parameters<typeof spyPorts>[0] = [];
  const ports = spyPorts(
    calls,
    {
      ...AUCTION,
      summary: {
        auctionId: CONTRACT_AUCTION_ID,
        stage: "finished",
        final: true,
      },
    },
    identity,
  );
  const achievements: AchievementsPort = {
    listMine: vi.fn(async () => [
      {
        grantId,
        auctionId: CONTRACT_AUCTION_ID,
        grantedAt: "2026-10-28T12:00:00Z",
        achievement: definition,
      },
    ]),
    getEvent: vi.fn(async () => [
      { achievement: definition, holderIds: ["holder"], erasedHolders: 1 },
    ]),
    getImage: vi.fn(async () => ({
      content: new Uint8Array([1]),
      mediaType: "image/png",
      version: "v1",
    })),
  };
  ports.auction.getDisplayNames = vi.fn(async () => ({ holder: "Сова <3" }));
  const press = async (data: string) => {
    const result = await handleAuctionUpdate(
      { kind, ports: { ...ports, achievements } },
      { identity, user: CONTRACT_USER, input: { kind: "callback", data } },
    );
    if (result.kind !== "screen") throw new Error("screen expected");
    const block = result.body.blocks[0];
    if (block?.kind !== "achievements")
      throw new Error("achievements block expected");
    return block.screen;
  };
  return { ports, achievements, press, identity };
}

describe.each(["hub", "auction"] as const)("achievements: %s", (kind) => {
  it("opens the same set, card, names and image reference through both surfaces", async () => {
    const f = fixture(kind);
    const list = await f.press(
      encodeAuctionCallback({
        kind: "achievements",
        auctionId: CONTRACT_AUCTION_ID,
        page: 0,
      }),
    );
    const card = await f.press(list.items[0]?.callbackData ?? "");
    expect(card).toMatchObject({
      view: "card",
      holderNames: ["Сова <3"],
      erasedHolders: 1,
      achievement: definition,
    });
    const shown = achievementScreen(card);
    expect(shown.text).toContain("Сова &lt;3");
    expect(shown.photos).toEqual([
      { lotId: "achievement:first", achievementCode: "first", version: "v1" },
    ]);
    expect(f.achievements.getImage).not.toHaveBeenCalled();
    expect(f.ports.auction.getDisplayNames).toHaveBeenCalledWith({
      viewer: f.identity.viewer,
      auctionId: CONTRACT_AUCTION_ID,
      participantIds: ["holder"],
    });
  });
  it("does not read a set whose auction is invisible", async () => {
    const f = fixture(kind);
    f.ports.auction.getAuction = vi.fn(async () => undefined);
    expect(
      await f.press(
        encodeAuctionCallback({
          kind: "achievements",
          auctionId: CONTRACT_AUCTION_ID,
          page: 0,
        }),
      ),
    ).toMatchObject({ view: "list", items: [] });
    expect(f.achievements.getEvent).not.toHaveBeenCalled();
  });
  it("offers retry on data or names failure without claiming an empty set", async () => {
    const f = fixture(kind);
    const list = await f.press(
      encodeAuctionCallback({
        kind: "achievements",
        auctionId: CONTRACT_AUCTION_ID,
        page: 0,
      }),
    );
    f.ports.auction.getDisplayNames = vi.fn(async () => {
      throw new Error("offline");
    });
    const data = list.items[0]?.callbackData ?? "";
    expect(await f.press(data)).toMatchObject({
      view: "unavailable",
      retry: data,
    });
    expect(
      achievementScreen(await f.press(data)).keyboard.at(-1)?.[0]?.text,
    ).toBe("‹ Ачивки");
    f.achievements.getEvent = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(
      await f.press(
        encodeAuctionCallback({
          kind: "achievements",
          auctionId: CONTRACT_AUCTION_ID,
          page: 0,
        }),
      ),
    ).toMatchObject({ view: "unavailable" });
  });
});

describe("private collection", () => {
  it("reads only the current viewer and does not open another grant", async () => {
    const f = fixture("auction");
    const list = await f.press(
      encodeAuctionCallback({ kind: "achievements", page: 0 }),
    );
    const own = await f.press(list.items[0]?.callbackData ?? "");
    expect(own).toMatchObject({
      view: "card",
      scope: "mine",
      grantedAt: "2026-10-28T12:00:00Z",
    });
    const forged = encodeAuctionCallback({
      kind: "achievement",
      reference: uuidToToken("01929b7e-5c1d-7a3f-8e4b-0000000000ff"),
      page: 0,
      holdersPage: 0,
    });
    expect(await f.press(forged)).toMatchObject({ view: "list" });
    for (const [id] of vi.mocked(f.achievements.listMine).mock.calls)
      expect(id).toBe(f.identity.viewer.identityId);
  });
  it("renders an empty collection without reproach", async () => {
    const f = fixture("auction");
    f.achievements.listMine = vi.fn(async () => []);
    const shown = achievementScreen(
      await f.press(encodeAuctionCallback({ kind: "achievements", page: 0 })),
    );
    expect(shown.text).toContain("Здесь появятся твои ачивки аукционов.");
    expect(shown.keyboard.at(-1)).toEqual([
      { text: "‹ Меню", callback_data: "v1:entry:menu" },
    ]);
  });
  it("formats the grant date in the community time zone with a differing year", async () => {
    const f = fixture("auction");
    const list = await f.press(
      encodeAuctionCallback({ kind: "achievements", page: 0 }),
    );
    const card = await f.press(list.items[0]?.callbackData ?? "");
    if (card.view !== "card") throw new Error("card expected");
    const shown = achievementScreen(
      { ...card, grantedAt: "2026-12-31T22:05:00Z" },
      { timeZone: "Europe/Moscow", now: new Date("2026-12-31T20:00:00Z") },
    );
    expect(shown.text).toContain("Получена: 1 января 2027, пт, 01:05");
    expect(shown.text).not.toContain("01:05.");
  });
  it("paginates collections and clamps a stale page", async () => {
    const f = fixture("auction");
    f.achievements.listMine = vi.fn(async () =>
      Array.from({ length: 8 }, (_, i) => ({
        grantId: `01929b7e-5c1d-7a3f-8e4b-${String(i).padStart(12, "0")}`,
        auctionId: CONTRACT_AUCTION_ID,
        grantedAt: "2026-10-28T12:00:00Z",
        achievement: definition,
      })),
    );
    const first = await f.press(
      encodeAuctionCallback({ kind: "achievements", page: 0 }),
    );
    expect(first.items).toHaveLength(6);
    const last = await f.press(first.next ?? "");
    expect(last).toMatchObject({ page: 1, pages: 2 });
    expect(last.items).toHaveLength(2);
    expect(
      await f.press(encodeAuctionCallback({ kind: "achievements", page: 99 })),
    ).toMatchObject({ page: 1 });
  });
  it("rejects owner injection and keeps callbacks within 64 bytes", () => {
    expect(parseAuctionCallback("v1:auc:ach:_:0:foreign-owner").ok).toBe(false);
    for (const intent of [
      {
        kind: "achievements" as const,
        auctionId: CONTRACT_AUCTION_ID,
        page: 999,
      },
      {
        kind: "achievement" as const,
        auctionId: CONTRACT_AUCTION_ID,
        reference: "a7937b64b8ca",
        page: 999,
        holdersPage: 999,
      },
      {
        kind: "achievement" as const,
        reference: uuidToToken(grantId),
        page: 999,
        holdersPage: 999,
      },
    ]) {
      const encoded = encodeAuctionCallback(intent);
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
      expect(parseAuctionCallback(encoded)).toEqual({ ok: true, intent });
    }
  });
});
