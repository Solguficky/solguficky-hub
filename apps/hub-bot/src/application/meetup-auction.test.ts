import { describe, expect, it, vi } from "vitest";
import type { MeetupAuctions } from "../auction/port.js";
import type { Meetups } from "../meetups/port.js";
import { createDispatcher } from "./dispatcher.js";

// Аукцион у сходки в прикладном слое (PER-307). Политика хаба уже не пускает
// человека вне круга `member` к карточке, а этот слой второй раз не зовёт
// Auction за него: прикладной юзкейс не полагается на то, что край проверил.

const meetupId = "0192f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f60";
const auctionId = "daef05c7-cd68-5048-b03d-cb4860e8dc73";
const meetup = {
  id: meetupId,
  title: "Ярмарка",
  description: "",
  venue: "",
  lifecycle: "planned" as const,
  visibility: "visible" as const,
  author: "0192f0a0-0000-7000-8000-00000000a001",
  version: 1,
  materials: [],
};

function meetups(): Meetups {
  const notUsed = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    listVisible: notUsed,
    listArchived: notUsed,
    createDraft: notUsed,
    get: async () => ({ kind: "ok", meetup }),
    changeAttributes: notUsed,
    setSchedule: notUsed,
    publish: notUsed,
    unpublish: notUsed,
    cancel: notUsed,
    markHeld: notUsed,
    schedulePublication: notUsed,
    cancelPublication: notUsed,
    attachMaterial: notUsed,
    removeMaterial: notUsed,
  };
}

function auctions() {
  const getMeetupAuction = vi.fn<MeetupAuctions["getMeetupAuction"]>(
    async () => ({ kind: "ok", auctionId }),
  );
  const enableAuction = vi.fn<MeetupAuctions["enableAuction"]>(async () => ({
    kind: "enabled",
    auctionId,
    alreadyExisted: false,
  }));
  return { getMeetupAuction, enableAuction };
}

const person = (globalRoles: readonly string[]) => ({
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles,
});

describe("meetup auction", () => {
  it("names the auction of the meetup on the card", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(["member"]),
        intent: "view-meetup",
        meetupId,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-card",
      auction: { kind: "open", auctionId },
    });
  });

  it("does not ask Auction for a person outside the member circle", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    const card = await dispatcher.execute({
      identity: person(["public"]),
      intent: "view-meetup",
      meetupId,
    });
    const enabled = await dispatcher.execute({
      identity: person(["public"]),
      intent: "enable-auction",
      meetupId,
      opId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa",
    });

    expect(card).not.toHaveProperty("auction");
    expect(enabled).toEqual({
      kind: "dependency-rejected",
      reason: "forbidden",
    });
    expect(port.getMeetupAuction).not.toHaveBeenCalled();
    expect(port.enableAuction).not.toHaveBeenCalled();
  });

  it("takes the auction of the card from the command, not from a second read", async () => {
    const port = auctions();
    // Read model Auction ещё не увидела рождения: чтение отвечает «нет».
    port.getMeetupAuction.mockResolvedValue({ kind: "ok" });
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(["admin"]),
        intent: "enable-auction",
        meetupId,
        opId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa",
      }),
    ).resolves.toMatchObject({
      kind: "auction-enabled",
      alreadyExisted: false,
      card: { auction: { kind: "open", auctionId } },
    });
    expect(port.getMeetupAuction).not.toHaveBeenCalled();
  });
});
