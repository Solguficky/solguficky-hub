import { describe, expect, it, vi } from "vitest";
import type { AccessRight } from "../../../auction-ui/index.js";
import type { MeetupAuctions } from "../auction/port.js";
import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import { createDispatcher } from "./dispatcher.js";

// Аукцион у сходки в прикладном слое (PER-307, PER-605). Политика хаба уже не
// пускает человека без права хаба к меню «Расширения», а этот слой второй раз
// не зовёт Auction за него: прикладной юзкейс не полагается на то, что край
// проверил.

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
    publish: async () => ({ kind: "ok", meetup }),
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

// Роли ничего не решают: край зовёт Auction по праву хаба.
const person = (rights: readonly AccessRight[]) => ({
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  rights,
});
const MEMBER: readonly AccessRight[] = ["access-hub", "place-bids"];
const ADMIN: readonly AccessRight[] = [
  "access-hub",
  "place-bids",
  "manage-members",
  "admit-bidders",
  "manage-meetups",
];

describe("meetup auction", () => {
  it("names the auction of the meetup in its extensions menu", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(MEMBER),
        intent: "view-meetup-extensions",
        meetupId,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-card",
      auction: { kind: "open", auctionId },
    });
  });

  // Вход в аукцион — кнопка «Расширения» без состояния (PER-605): карточка в
  // Auction не ходит, и его сбой её не трогает.
  it("reads the card without Auction", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    const card = await dispatcher.execute({
      identity: person(MEMBER),
      intent: "view-meetup",
      meetupId,
    });

    expect(card).toMatchObject({ kind: "meetup-card", meetup });
    expect(card).not.toHaveProperty("auction");
    expect(port.getMeetupAuction).not.toHaveBeenCalled();
  });

  it("marks the auction unavailable in the menu when Auction does not answer", async () => {
    const port = auctions();
    port.getMeetupAuction.mockResolvedValue({
      kind: "unavailable",
      cause: new Error("down"),
    });
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(ADMIN),
        intent: "view-meetup-extensions",
        meetupId,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-card",
      meetup,
      auction: { kind: "unavailable" },
    });
  });

  it("does not ask Auction for a person without the hub right", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    const menu = await dispatcher.execute({
      identity: person(["place-bids"]),
      intent: "view-meetup-extensions",
      meetupId,
    });
    const enabled = await dispatcher.execute({
      identity: person(["place-bids"]),
      intent: "enable-auction",
      meetupId,
      opId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa",
    });

    expect(menu).not.toHaveProperty("auction");
    expect(enabled).toEqual({
      kind: "dependency-rejected",
      reason: "forbidden",
    });
    expect(port.getMeetupAuction).not.toHaveBeenCalled();
    expect(port.enableAuction).not.toHaveBeenCalled();
  });

  it("takes the enabled auction from the command, not from a second read", async () => {
    const port = auctions();
    // Read model Auction ещё не увидела рождения: чтение отвечает «нет».
    port.getMeetupAuction.mockResolvedValue({ kind: "ok" });
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(ADMIN),
        intent: "enable-auction",
        meetupId,
        opId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34aa",
      }),
    ).resolves.toEqual({
      kind: "auction-enabled",
      alreadyExisted: false,
      meetupId,
      auctionId,
    });
    expect(port.getMeetupAuction).not.toHaveBeenCalled();
  });

  // Ответы формы и подписки показываются карточкой, а карточка в Auction не
  // ходит (PER-605): ни публикация, ни подписка его не спрашивают.
  it("publishes and subscribes without asking Auction", async () => {
    const port = auctions();
    const notifications = {
      setSubscription: async () => ({
        kind: "ok" as const,
        preferences: { meetupId, subscribed: true, categories: [] },
      }),
    } as unknown as Notifications;
    const dispatcher = createDispatcher(
      meetups(),
      notifications,
      undefined,
      port,
    );

    await expect(
      dispatcher.execute({
        identity: person(ADMIN),
        intent: "publish-meetup",
        meetupId,
      }),
    ).resolves.toEqual({ kind: "published", meetup, repeated: true });
    await expect(
      dispatcher.execute({
        identity: person(MEMBER),
        intent: "set-meetup-subscription",
        meetupId,
        subscribed: true,
      }),
    ).resolves.toMatchObject({ kind: "meetup-card", subscribed: true });
    expect(port.getMeetupAuction).not.toHaveBeenCalled();
  });
});
