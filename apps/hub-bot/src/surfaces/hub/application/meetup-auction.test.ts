import { describe, expect, it, vi } from "vitest";
import type { AccessRight } from "../../../auction-ui/index.js";
import type { MeetupAuctions } from "../auction/port.js";
import type { Meetups } from "../meetups/port.js";
import type { Notifications } from "../notifications/port.js";
import { createDispatcher } from "./dispatcher.js";

// Аукцион у сходки в прикладном слое (PER-307). Политика хаба уже не пускает
// человека без права хаба к карточке, а этот слой второй раз не зовёт
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

// Роли едут транзитом и ничего не решают: край зовёт Auction по праву хаба.
const person = (rights: readonly AccessRight[]) => ({
  identityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd",
  globalRoles: [],
  rights,
});
const MEMBER: readonly AccessRight[] = ["hub", "auction"];
const ADMIN: readonly AccessRight[] = [
  "hub",
  "auction",
  "manage-membership",
  "moderate-auction",
  "manage-auction",
];

describe("meetup auction", () => {
  it("names the auction of the meetup on the card", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(MEMBER),
        intent: "view-meetup",
        meetupId,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-card",
      auction: { kind: "open", auctionId },
    });
  });

  it("does not ask Auction for a person without the hub right", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    const card = await dispatcher.execute({
      identity: person(["auction"]),
      intent: "view-meetup",
      meetupId,
    });
    const enabled = await dispatcher.execute({
      identity: person(["auction"]),
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
        identity: person(ADMIN),
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

  // Карточка сразу после «Опубликовать» — та же карточка, что из списка: ряд
  // аукциона на ней дописывает диспетчер, а не чтение `view-meetup`.
  it("adds the auction to the card a publication returns", async () => {
    const port = auctions();
    const dispatcher = createDispatcher(meetups(), undefined, undefined, port);

    await expect(
      dispatcher.execute({
        identity: person(ADMIN),
        intent: "publish-meetup",
        meetupId,
      }),
    ).resolves.toMatchObject({
      kind: "published",
      auction: { kind: "open", auctionId },
    });
    expect(port.getMeetupAuction).toHaveBeenCalledTimes(1);
  });

  it("publishes without an auction row when Auction is not configured or refuses", async () => {
    const without = createDispatcher(meetups());
    await expect(
      without.execute({
        identity: person(ADMIN),
        intent: "publish-meetup",
        meetupId,
      }),
    ).resolves.toEqual({ kind: "published", meetup, repeated: true });

    const port = auctions();
    port.getMeetupAuction.mockResolvedValue({
      kind: "unavailable",
      cause: new Error("down"),
    });
    const refusing = createDispatcher(meetups(), undefined, undefined, port);
    await expect(
      refusing.execute({
        identity: person(ADMIN),
        intent: "publish-meetup",
        meetupId,
      }),
    ).resolves.toEqual({ kind: "published", meetup, repeated: true });
  });

  // Ответ на вопрос черновика пришёл после публикации: бот покажет сходку
  // карточкой, и ряд аукциона ей положен. Скрытый черновик показывается
  // формой, и Auction за него не спрашивают.
  it("adds the auction to a draft answer only once the meetup is visible", async () => {
    const changed = (visibility: "visible" | "hidden"): Meetups => ({
      ...meetups(),
      get: async () => ({ kind: "ok", meetup: { ...meetup, visibility } }),
      changeAttributes: async () => ({
        kind: "ok",
        meetup: { ...meetup, visibility, description: "Про всё" },
      }),
    });
    const answer = {
      identity: person(ADMIN),
      intent: "set-meetup-field" as const,
      field: "description" as const,
      value: "Про всё",
      meetupId,
    };

    const hidden = auctions();
    await expect(
      createDispatcher(changed("hidden"), undefined, undefined, hidden).execute(
        answer,
      ),
    ).resolves.toEqual({
      kind: "draft",
      meetup: { ...meetup, visibility: "hidden", description: "Про всё" },
    });
    expect(hidden.getMeetupAuction).not.toHaveBeenCalled();

    const visible = auctions();
    await expect(
      createDispatcher(
        changed("visible"),
        undefined,
        undefined,
        visible,
      ).execute(answer),
    ).resolves.toMatchObject({
      kind: "draft",
      auction: { kind: "open", auctionId },
    });
    expect(visible.getMeetupAuction).toHaveBeenCalledTimes(1);
  });

  it("keeps the auction row on the card a subscription returns", async () => {
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
        identity: person(MEMBER),
        intent: "set-meetup-subscription",
        meetupId,
        subscribed: true,
      }),
    ).resolves.toMatchObject({
      kind: "meetup-card",
      subscribed: true,
      auction: { kind: "open", auctionId },
    });
  });
});
