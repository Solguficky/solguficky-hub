import { describe, expect, it } from "vitest";
import type {
  AuctionConsoles,
  ConsoleReadResult,
  DeleteLotSetResult,
  SaveLotSetResult,
} from "../auction/port.js";
import { lotSetPrint } from "./auction-console.js";
import { createLotSets } from "./lot-sets.js";
import type {
  AuctionConsoleSnapshot,
  ConsoleLotSnapshot,
  LotSet,
  Person,
} from "./types.js";

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const vaseId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const mugsId = "0199a000-0000-7000-8000-000000000001";
const othersId = "0199a000-0000-7000-8000-000000000002";
const identity: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "run-auctions"],
};
const vase: ConsoleLotSnapshot = {
  lot: {
    lotId: vaseId,
    auctionId,
    version: 1,
    card: { title: "Ваза", description: "" },
    proxyEnabled: false,
    status: { kind: "draft" },
  },
  bidCount: 0,
  markedForFinal: false,
  overdue: false,
};

function snapshot(lotSets: LotSet[]): AuctionConsoleSnapshot {
  return {
    auctionId,
    status: "draft",
    hidden: false,
    launchedWindows: [],
    lots: [vase],
    lotSets,
  };
}

function sets(answers: {
  read?: ConsoleReadResult;
  save?: SaveLotSetResult;
  remove?: DeleteLotSetResult;
}) {
  const port = {
    getAuctionConsole: async () =>
      answers.read ?? {
        kind: "ok",
        console: snapshot([
          { lotSetId: mugsId, name: "Кружки", lotIds: [] },
          { lotSetId: othersId, name: "Вазы", lotIds: [] },
        ]),
      },
    saveLotSet: async () => answers.save ?? { kind: "ok" },
    deleteLotSet: async () => answers.remove ?? { kind: "ok" },
  } as Partial<AuctionConsoles> as AuctionConsoles;
  return createLotSets(port);
}

const mugs = { index: 0, print: lotSetPrint(mugsId) };
const call = { identity, auctionId };

describe("lot sets use cases", () => {
  it("turns every refusal of a lot of the set into a note of the sets", async () => {
    const add = (save: SaveLotSetResult) =>
      sets({ save })({
        ...call,
        intent: "set-lot-set-lot",
        set: mugs,
        lotId: vaseId,
        selected: true,
        opId: "op",
      });
    await expect(add({ kind: "lots-frozen" })).resolves.toMatchObject({
      kind: "lot-sets",
      note: { kind: "frozen" },
    });
    await expect(
      add({ kind: "lot-not-in-auction", lotId: vaseId }),
    ).resolves.toMatchObject({ note: { kind: "lot-not-in-auction" } });
    // Чужой сет, который пульт уже прочитал, называется по имени.
    await expect(
      add({ kind: "lot-in-another-set", lotId: vaseId, lotSetId: othersId }),
    ).resolves.toMatchObject({
      note: { kind: "lot-in-another-set", name: "Вазы" },
    });
    await expect(
      add({ kind: "lot-in-another-set", lotId: vaseId, lotSetId: "unknown" }),
    ).resolves.toMatchObject({ note: { kind: "lot-in-another-set" } });
    await expect(add({ kind: "not-administrator" })).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "not-administrator",
    });
    await expect(add({ kind: "meetup-cancelled" })).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "meetup-cancelled",
    });
    await expect(add({ kind: "name-empty" })).resolves.toMatchObject({
      kind: "dependency-rejected",
      reason: "invalid",
    });
    await expect(add({ kind: "unavailable", cause: "down" })).resolves.toEqual({
      kind: "dependency-rejected",
      reason: "unavailable",
    });
  });

  it("refuses a delete confirmed after the online week opened before Auction", async () => {
    let deleted = 0;
    const frozen = createLotSets({
      getAuctionConsole: async () => ({
        kind: "ok",
        console: {
          ...snapshot([{ lotSetId: mugsId, name: "Кружки", lotIds: [] }]),
          status: "prebidding",
        },
      }),
      deleteLotSet: async () => {
        deleted += 1;
        return { kind: "ok" };
      },
    } as Partial<AuctionConsoles> as AuctionConsoles);
    await expect(
      frozen({ ...call, intent: "delete-lot-set", set: mugs, opId: "op" }),
    ).resolves.toMatchObject({ kind: "lot-sets", note: { kind: "frozen" } });
    expect(deleted).toBe(0);
  });

  it("refuses a new set beyond the limit before the question", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      lotSetId: `0199a000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      name: `Сет ${index}`,
      lotIds: [],
    }));
    await expect(
      sets({ read: { kind: "ok", console: snapshot(many) } })({
        ...call,
        intent: "ask-lot-set",
      }),
    ).resolves.toMatchObject({ kind: "lot-sets", note: { kind: "limit" } });
  });

  it("answers a delete of a set Auction no longer has as already deleted", async () => {
    await expect(
      sets({ remove: { kind: "lot-set-not-found" } })({
        ...call,
        intent: "delete-lot-set",
        set: mugs,
        opId: "op",
      }),
    ).resolves.toMatchObject({ note: { kind: "already-deleted" } });
  });

  it("shows the refusal of the console read instead of the sets", async () => {
    await expect(
      sets({ read: { kind: "meetup-not-found" } })({
        ...call,
        intent: "view-lot-sets",
      }),
    ).resolves.toEqual({
      kind: "auction-console-refused",
      reason: "not-administrator",
    });
  });
});
