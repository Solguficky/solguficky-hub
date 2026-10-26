import { describe, expect, it } from "vitest";
import type { LotLayoutView } from "../../../auction-ui/index.js";
import type {
  AuctionConsoles,
  ConsoleReadResult,
  LotLayoutResult,
} from "../auction/port.js";
import { arrangedLayout, createLotLayout, newSectionId } from "./lot-layout.js";
import type {
  AuctionConsoleSnapshot,
  ConsoleAuctionStatus,
  ConsoleLotSnapshot,
  Person,
} from "./types.js";

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
// Идентификаторы UUIDv7 по возрастанию: так их завёл администратор.
const vaseId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const mugId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3d";
const lampId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3e";
const identity: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "run-auctions"],
};

function lot(lotId: string, title: string): ConsoleLotSnapshot {
  return {
    lot: {
      lotId,
      auctionId,
      version: 1,
      card: { title, description: "" },
      proxyEnabled: false,
      status: { kind: "draft" },
    },
    bidCount: 0,
    markedForFinal: false,
    overdue: false,
  };
}

function snapshot(
  layout?: LotLayoutView,
  status: ConsoleAuctionStatus = "prebidding",
): AuctionConsoleSnapshot {
  return {
    auctionId,
    status,
    hidden: false,
    launchedWindows: [],
    // Реестр Auction отдаёт без порядка.
    lots: [lot(lampId, "Лампа"), lot(vaseId, "Ваза"), lot(mugId, "Кружка")],
    lotSets: [],
    ...(layout === undefined ? {} : { layout }),
  };
}

function layoutOf(answers: {
  read?: ConsoleReadResult;
  save?: LotLayoutResult;
}) {
  const saved: LotLayoutView[] = [];
  const port = {
    getAuctionConsole: async () =>
      answers.read ?? { kind: "ok", console: snapshot() },
    setLotLayout: async (
      _person: Person,
      command: { layout: LotLayoutView },
    ) => {
      saved.push(command.layout);
      return answers.save ?? { kind: "ok" };
    },
  } as Partial<AuctionConsoles> as AuctionConsoles;
  return { run: createLotLayout(port), saved };
}

const call = { identity, auctionId, opId: "op" };
const books = { sectionId: 1, name: "Книги", lotIds: [lampId] };

describe("lot layout use cases", () => {
  it("puts the lots the administrator has not arranged at the end of the general list in the order of creation", () => {
    expect(arrangedLayout(snapshot())).toEqual({
      lotIds: [vaseId, mugId, lampId],
      sections: [],
    });
    expect(
      arrangedLayout(snapshot({ lotIds: [mugId], sections: [books] })),
    ).toEqual({ lotIds: [mugId, vaseId], sections: [books] });
  });

  it("moves a lot up within its place and sends the whole layout, fixing the order participants saw", async () => {
    const { run, saved } = layoutOf({});
    await expect(
      run({
        ...call,
        intent: "move-lot-layout-lot",
        lotId: mugId,
        direction: "up",
      }),
    ).resolves.toMatchObject({ kind: "lot-layout-lot", moved: true });
    expect(saved).toEqual([{ lotIds: [mugId, vaseId, lampId], sections: [] }]);
  });

  it("leaves a lot at the edge where it is without a command", async () => {
    const { run, saved } = layoutOf({});
    await expect(
      run({
        ...call,
        intent: "move-lot-layout-lot",
        lotId: vaseId,
        direction: "up",
      }),
    ).resolves.toEqual({
      kind: "lot-layout-lot",
      console: snapshot(),
      lotId: vaseId,
    });
    expect(saved).toEqual([]);
  });

  it("moves a lot into a section at its end and back to the end of the general list", async () => {
    const arranged = { lotIds: [vaseId, mugId], sections: [books] };
    const { run, saved } = layoutOf({
      read: { kind: "ok", console: snapshot(arranged) },
    });
    await run({
      ...call,
      intent: "place-lot-layout-lot",
      lotId: vaseId,
      place: 1,
    });
    await run({
      ...call,
      intent: "place-lot-layout-lot",
      lotId: lampId,
      place: 0,
    });
    expect(saved).toEqual([
      { lotIds: [mugId], sections: [{ ...books, lotIds: [lampId, vaseId] }] },
      { lotIds: [vaseId, mugId, lampId], sections: [{ ...books, lotIds: [] }] },
    ]);
  });

  it("adds a section with the next number, opens an existing one on the same name and refuses a blank name", async () => {
    const { run, saved } = layoutOf({
      read: {
        kind: "ok",
        console: snapshot({ lotIds: [], sections: [books] }),
      },
    });
    await expect(
      run({ ...call, intent: "name-lot-section", value: " Посуда " }),
    ).resolves.toMatchObject({ kind: "lot-layout-list", place: 2 });
    expect(saved.at(-1)?.sections.map((section) => section.name)).toEqual([
      "Книги",
      "Посуда",
    ]);
    // Повтор ответа: раздел уже есть — открывается он, команды нет.
    await expect(
      run({ ...call, intent: "name-lot-section", value: "Книги" }),
    ).resolves.toMatchObject({ kind: "lot-layout-list", place: 1 });
    expect(saved).toHaveLength(1);
    await expect(
      run({ ...call, intent: "name-lot-section", value: "  " }),
    ).resolves.toEqual({
      kind: "lot-section-ask",
      auctionId,
      error: "name-empty",
    });
  });

  // Номер раздела — минута нажатия: номер удалённого раздела новому не
  // достаётся, и старая кнопка удалённого раздела нового не тронет.
  it("numbers a new section by the minute of the press and never below the next one", () => {
    // 2026-10-26T12:00:00Z — минута 36 720 от 1 октября 2026 года.
    const at = (Date.UTC(2026, 9, 26, 12) / 1).toString(16).padStart(12, "0");
    const opId = `${at.slice(0, 8)}-${at.slice(8)}-7000-8000-000000000000`;
    expect(newSectionId(opId, [3])).toBe(36_720);
    expect(newSectionId(opId, [36_720])).toBe(36_721);
    expect(newSectionId("op", [2, 5])).toBe(6);
  });

  it("renames a section and refuses the name of another section", async () => {
    const dishes = { sectionId: 2, name: "Посуда", lotIds: [] };
    const { run, saved } = layoutOf({
      read: {
        kind: "ok",
        console: snapshot({ lotIds: [], sections: [books, dishes] }),
      },
    });
    await expect(
      run({
        ...call,
        intent: "name-lot-section",
        sectionId: 2,
        value: "Книги",
      }),
    ).resolves.toEqual({
      kind: "lot-section-ask",
      auctionId,
      sectionId: 2,
      error: "name-taken",
    });
    expect(saved).toHaveLength(0);
    await expect(
      run({
        ...call,
        intent: "name-lot-section",
        sectionId: 2,
        value: "Кружки",
      }),
    ).resolves.toMatchObject({ kind: "lot-layout-list", place: 2 });
    expect(saved.at(-1)?.sections.map((section) => section.name)).toEqual([
      "Книги",
      "Кружки",
    ]);
  });

  it("moves the lots of a deleted section to the end of the general list", async () => {
    const { run, saved } = layoutOf({
      read: {
        kind: "ok",
        console: snapshot({ lotIds: [mugId], sections: [books] }),
      },
    });
    await expect(
      run({ ...call, intent: "delete-lot-section", sectionId: 1 }),
    ).resolves.toMatchObject({
      kind: "lot-layout",
      note: { kind: "deleted", name: "Книги" },
    });
    expect(saved).toEqual([{ lotIds: [mugId, vaseId, lampId], sections: [] }]);
  });

  it("refuses a change once the final started, before Auction and after it", async () => {
    const final = layoutOf({
      read: { kind: "ok", console: snapshot(undefined, "final") },
    });
    await expect(
      final.run({ ...call, intent: "ask-lot-section" }),
    ).resolves.toMatchObject({ kind: "lot-layout", note: { kind: "closed" } });
    expect(final.saved).toEqual([]);
    // Чтение пульта отстаёт от старта финала: отказ приходит от Auction.
    const late = layoutOf({ save: { kind: "final-already-started" } });
    await expect(
      late.run({
        ...call,
        intent: "move-lot-layout-lot",
        lotId: lampId,
        direction: "up",
      }),
    ).resolves.toMatchObject({ kind: "lot-layout", note: { kind: "closed" } });
    const stale = layoutOf({});
    await expect(
      stale.run({
        ...call,
        intent: "move-lot-section",
        sectionId: 3,
        direction: "up",
      }),
    ).resolves.toMatchObject({ note: { kind: "changed" } });
  });
});
