import { describe, expect, it } from "vitest";
import type { LotView, Money } from "../../../auction-ui/index.js";
import type {
  AuctionConsoles,
  LotParticipantsResult,
  RemovalPreviewResult,
  RemoveParticipantResult,
} from "../auction/port.js";
import { createParticipantRemoval } from "./participant-removal.js";
import type { ParticipantRemovalRequest, Person } from "./types.js";

// Снятие участника с лота (PER-659, ADR-072): юзкейс над портом пульта.
// Лот, участники, предпросмотр и снятие подменены ответами; вызовы
// записываются, чтобы проверить, что ушло в Auction и чего не ушло.

const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const lotId = "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c";
const jay = "01926f3c-8b7a-7cde-8f00-00000000000b";
const owl = "01926f3c-8b7a-7cde-8f00-00000000000c";
const kim = "01926f3c-8b7a-7cde-8f00-00000000000d";
const person: Person = {
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights: ["access-hub", "place-bids", "run-auctions"],
} as Person;

const rub = (rubles: number): Money => ({
  minorUnits: rubles * 100,
  currency: "RUB",
});

function lot(status: LotView["status"], version = 7): LotView {
  return {
    lotId,
    auctionId,
    version,
    card: { title: "Кружка", description: "" },
    proxyEnabled: true,
    status,
  };
}

const online = lot({
  kind: "trading",
  currentPrice: rub(1_500),
  leaderId: jay,
  phase: "online",
});

function fake(answers: {
  lot?: LotView;
  // Лот после снятия: его отдаёт чтение с порогом версии.
  after?: LotView;
  participants?: LotParticipantsResult;
  preview?: RemovalPreviewResult;
  remove?: RemoveParticipantResult;
}) {
  const calls: { method: string; args: unknown }[] = [];
  const port = {
    floorLot: async (_person, read) => {
      calls.push({ method: "floorLot", args: read });
      const found =
        read.atLeastVersion !== undefined && answers.after !== undefined
          ? answers.after
          : (answers.lot ?? online);
      return { kind: "ok", lot: found };
    },
    lotParticipants: async (_person, read) => {
      calls.push({ method: "lotParticipants", args: read });
      return answers.participants ?? { kind: "ok", participants: [] };
    },
    previewParticipantRemoval: async (_person, target) => {
      calls.push({ method: "previewParticipantRemoval", args: target });
      return (
        answers.preview ?? {
          kind: "ok",
          preview: { price: rub(1_200), leaderId: owl, version: 7 },
        }
      );
    },
    removeParticipant: async (_person, removal) => {
      calls.push({ method: "removeParticipant", args: removal });
      return answers.remove ?? { kind: "ok", lotVersion: 8 };
    },
    displayNames: async (_person, read) => {
      calls.push({ method: "displayNames", args: read });
      const names: Record<string, string> = {
        [jay]: "@jay",
        [owl]: "@owl",
        [kim]: "Ким*",
      };
      return {
        kind: "ok",
        names: Object.fromEntries(
          read.participantIds.map((id) => [id, names[id] ?? ""]),
        ),
      };
    },
  } satisfies Partial<AuctionConsoles>;
  return {
    run: createParticipantRemoval(port as unknown as AuctionConsoles),
    calls,
    sent: (method: string) => calls.filter((call) => call.method === method),
  };
}

const call = { identity: person };
const target = { lotId, participantId: jay };

const view: ParticipantRemovalRequest = {
  ...call,
  intent: "view-lot-removal",
  lotId,
  page: 0,
};

describe("participant removal", () => {
  it("lists the participants of the lot not yet removed in the order of their first bid", async () => {
    const auction = fake({
      participants: {
        kind: "ok",
        participants: [
          { participantId: kim, name: "Ким*", removed: true },
          { participantId: owl, name: "@owl", removed: false },
          { participantId: jay, name: "@jay", removed: false },
        ],
      },
    });
    expect(await auction.run(view)).toEqual({
      kind: "removal-people",
      lot: { lotId, auctionId, title: "Кружка" },
      people: [
        { participantId: owl, name: "@owl" },
        { participantId: jay, name: "@jay" },
      ],
      page: 0,
    });
    expect(auction.sent("lotParticipants")).toEqual([
      { method: "lotParticipants", args: { auctionId, lotId } },
    ]);
  });

  it.each([
    [
      "the live final",
      lot({ kind: "trading", currentPrice: rub(1), phase: "live" }),
      "not-in-online-phase",
    ],
    [
      "a sold lot",
      lot({ kind: "sold", winnerId: jay, price: rub(1) }),
      "lot-not-open",
    ],
    [
      "a scheduled lot",
      lot({ kind: "scheduled", startingPrice: rub(1) }),
      "not-in-prebidding",
    ],
  ] as const)(
    "refuses %s by the lot without asking Auction",
    async (_, found, reason) => {
      const auction = fake({ lot: found });
      expect(await auction.run(view)).toEqual({
        kind: "removal-outcome",
        lot: { lotId, auctionId, title: "Кружка" },
        note: { kind: "refused", reason },
      });
      expect(auction.sent("lotParticipants")).toEqual([]);
    },
  );

  it("lets the administrator remove from a held lot", async () => {
    const auction = fake({
      lot: lot({ kind: "held", currentPrice: rub(900), leaderId: owl }),
      participants: {
        kind: "ok",
        participants: [{ participantId: owl, name: "@owl", removed: false }],
      },
    });
    expect((await auction.run(view)).kind).toBe("removal-people");
  });

  it("says there is nobody to remove when every participant is removed", async () => {
    const auction = fake({
      participants: {
        kind: "ok",
        participants: [{ participantId: jay, name: "@jay", removed: true }],
      },
    });
    expect(await auction.run(view)).toEqual({
      kind: "removal-outcome",
      lot: { lotId, auctionId, title: "Кружка" },
      note: { kind: "no-participants" },
    });
  });

  it("confirms with the lot after the removal as the preview decided it", async () => {
    const auction = fake({
      preview: {
        kind: "ok",
        preview: {
          price: rub(1_200),
          leaderId: owl,
          extendedDeadline: "2026-10-21T16:10:00Z",
          version: 7,
        },
      },
    });
    expect(
      await auction.run({
        ...call,
        intent: "prepare-participant-removal",
        target,
      }),
    ).toEqual({
      kind: "removal-confirm",
      lot: { lotId, auctionId, title: "Кружка" },
      person: { participantId: jay, name: "@jay" },
      forecast: {
        price: rub(1_200),
        leader: { name: "@owl" },
        extendedDeadline: "2026-10-21T16:10:00Z",
      },
      version: 7,
    });
    expect(auction.sent("removeParticipant")).toEqual([]);
  });

  it("names no leader when nobody is left to lead", async () => {
    const auction = fake({
      preview: { kind: "ok", preview: { price: rub(1_000), version: 7 } },
    });
    const result = await auction.run({
      ...call,
      intent: "prepare-participant-removal",
      target,
    });
    expect(result).toMatchObject({
      kind: "removal-confirm",
      forecast: { price: rub(1_000), leader: "none" },
    });
  });

  it("removes at the confirmed version and reads the lot not older than the answer", async () => {
    const auction = fake({
      after: lot(
        {
          kind: "trading",
          currentPrice: rub(1_200),
          leaderId: owl,
          phase: "online",
        },
        8,
      ),
    });
    const result = await auction.run({
      ...call,
      intent: "remove-participant",
      target,
      version: 7,
      opId: "op-1",
    });
    expect(auction.sent("removeParticipant")).toEqual([
      {
        method: "removeParticipant",
        args: {
          auctionId,
          lotId,
          participantId: jay,
          expectedVersion: 7,
          opId: "op-1",
        },
      },
    ]);
    expect(auction.sent("floorLot").at(-1)).toEqual({
      method: "floorLot",
      args: { lotId, atLeastVersion: 8 },
    });
    expect(result).toEqual({
      kind: "removal-outcome",
      lot: { lotId, auctionId, title: "Кружка" },
      note: {
        kind: "removed",
        name: "@jay",
        after: { price: rub(1_200), leader: { name: "@owl" } },
      },
      lotVersion: 8,
    });
  });

  it("previews again when the lot moved past the confirmed version", async () => {
    const auction = fake({
      remove: { kind: "lot-changed" },
      preview: {
        kind: "ok",
        preview: { price: rub(1_300), leaderId: owl, version: 9 },
      },
    });
    const result = await auction.run({
      ...call,
      intent: "remove-participant",
      target,
      version: 7,
      opId: "op-1",
    });
    expect(result).toMatchObject({
      kind: "removal-confirm",
      version: 9,
      changed: true,
      forecast: { price: rub(1_300), leader: { name: "@owl" } },
    });
    expect(auction.sent("removeParticipant")).toHaveLength(1);
  });

  it("answers a repeated removal with the participant already removed", async () => {
    const auction = fake({
      remove: { kind: "refused", reason: "already-removed" },
    });
    expect(
      await auction.run({
        ...call,
        intent: "remove-participant",
        target,
        version: 7,
        opId: "op-2",
      }),
    ).toEqual({
      kind: "removal-outcome",
      lot: { lotId, auctionId, title: "Кружка" },
      note: { kind: "refused", reason: "already-removed" },
    });
  });

  it.each([
    [{ kind: "not-administrator" } as const, "not-administrator"],
    [{ kind: "meetup-not-found" } as const, "not-administrator"],
    [{ kind: "meetup-cancelled" } as const, "meetup-cancelled"],
  ])("refuses the console when Auction answers %o", async (answer, reason) => {
    const auction = fake({ preview: answer });
    expect(
      await auction.run({
        ...call,
        intent: "prepare-participant-removal",
        target,
      }),
    ).toEqual({ kind: "auction-console-refused", reason });
  });

  it("does not repeat a removal whose answer was lost", async () => {
    const auction = fake({
      remove: { kind: "timeout", cause: new Error("deadline") },
    });
    const result = await auction.run({
      ...call,
      intent: "remove-participant",
      target,
      version: 7,
      opId: "op-1",
    });
    expect(result).toEqual({
      kind: "dependency-rejected",
      reason: "timeout",
    });
    expect(auction.sent("removeParticipant")).toHaveLength(1);
  });
});
