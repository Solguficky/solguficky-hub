import { Code, ConnectError } from "@connectrpc/connect";
import {
  encodeAuctionCallback,
  type ResolvedIdentity,
} from "@solguficky/auction-bot-ui";
import { describe, expect, it, vi } from "vitest";
import type { EntryPorts } from "./entry-ports.js";
import { entryCallback } from "./faq.js";
import { routeAuctionCallback, routeAuctionStart } from "./route.js";

const lotId = "01926f3c-8b7a-7cde-8f00-0123456789ab";
const auctionId = "01926f3c-8b7a-7cde-8f00-0123456789ac";
const user = { telegramUserId: 42 };

function identity(overrides: Partial<ResolvedIdentity>): ResolvedIdentity {
  return {
    identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
    globalRoles: [],
    blocked: false,
    ...overrides,
  };
}

function ports(resolved: ResolvedIdentity | Error): EntryPorts {
  return {
    identity: {
      resolveIdentity: vi.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }),
    },
    auction: {
      getLot: vi.fn(async () => ({
        lotId,
        auctionId,
        version: 3,
        status: { kind: "unsold" as const },
      })),
      listAuctionLots: vi.fn(async () => ({ lots: [], nextPageToken: "" })),
      getDisplayNames: vi.fn(async () => ({})),
    },
    faq: {
      acknowledged: vi.fn(async () => true),
      acknowledge: vi.fn(async () => {}),
    },
  };
}

const lotButton = encodeAuctionCallback({ kind: "lot", lotId, page: 0 });
const feedButton = encodeAuctionCallback({
  kind: "feed",
  auctionId,
  page: 0,
});

describe("FAQ entry", () => {
  it("shows no FAQ before admission and opens it on the first admitted start", async () => {
    const p = ports(identity({ globalRoles: [] }));
    expect((await routeAuctionStart({ ports: p, user })).screen).toEqual({
      kind: "denied",
      reason: "not-admitted",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
    vi.mocked(p.identity.resolveIdentity).mockResolvedValue(
      identity({ globalRoles: ["public"] }),
    );
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect((await routeAuctionStart({ ports: p, user })).screen).toEqual({
      kind: "faq",
    });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
  });
  it.each(["faq", "menu", "auctions", "details", "question"] as const)(
    "refuses a blocked person even with a stale public role on %s",
    async (action) => {
      const p = ports(identity({ globalRoles: ["public"], blocked: true }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: "denied", reason: "blocked" });
      expect((await routeAuctionStart({ ports: p, user })).screen).toEqual({
        kind: "denied",
        reason: "blocked",
      });
      expect(p.faq.acknowledged).not.toHaveBeenCalled();
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
      expect(p.auction.getLot).not.toHaveBeenCalled();
    },
  );

  it.each(["auctions", "details", "question"] as const)(
    "opens the local %s destination and returns to FAQ",
    async (action) => {
      const p = ports(identity({ globalRoles: ["public"] }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: action });
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback("faq"),
          })
        ).screen,
      ).toEqual({ kind: "faq" });
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
    },
  );
  it("shows FAQ on the first admitted start and leaves completion untouched", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect((await routeAuctionStart({ ports: p, user })).screen).toEqual({
      kind: "faq",
    });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
    expect(p.auction.getLot).not.toHaveBeenCalled();
    expect(p.identity.resolveIdentity).toHaveBeenCalledTimes(1);
  });

  it("shows the menu to a returning participant without an auction id", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    expect((await routeAuctionStart({ ports: p, user })).screen).toEqual({
      kind: "menu",
    });
  });

  it("records completion on the explicit menu action and allows its repetition", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback("menu"),
          })
        ).screen,
      ).toEqual({ kind: "menu" });
    }
    expect(p.faq.acknowledge).toHaveBeenCalledTimes(2);
    expect(p.faq.acknowledge).toHaveBeenCalledWith({
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      globalRoles: ["public"],
    });
  });

  it("does not enter the menu when completion cannot be saved", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.faq.acknowledge).mockRejectedValue(
      new ConnectError("offline", Code.Unavailable),
    );
    expect(
      (
        await routeAuctionCallback({
          ports: p,
          user,
          data: entryCallback("menu"),
        })
      ).screen,
    ).toEqual({ kind: "unavailable" });
  });

  it("allows a manual return to FAQ without storage or Auction reads", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    expect(
      (
        await routeAuctionCallback({
          ports: p,
          user,
          data: entryCallback("faq"),
        })
      ).screen,
    ).toEqual({ kind: "faq" });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it.each([entryCallback("auctions"), lotButton])(
    "shows FAQ before an unacknowledged participant follows %s",
    async (data) => {
      const p = ports(identity({ globalRoles: ["public"] }));
      vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
      expect(
        (await routeAuctionCallback({ ports: p, user, data })).screen,
      ).toEqual({ kind: "faq" });
      expect(p.auction.getLot).not.toHaveBeenCalled();
    },
  );

  it.each(["faq", "menu", "auctions", "details", "question"] as const)(
    "rechecks access on the old %s button before reaching FAQ storage",
    async (action) => {
      const p = ports(identity({ globalRoles: [] }));
      expect(
        (
          await routeAuctionCallback({
            ports: p,
            user,
            data: entryCallback(action),
          })
        ).screen,
      ).toEqual({ kind: "denied", reason: "not-admitted" });
      expect(p.faq.acknowledged).not.toHaveBeenCalled();
      expect(p.faq.acknowledge).not.toHaveBeenCalled();
    },
  );

  it("fails closed if the completion read is unavailable", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.faq.acknowledged).mockRejectedValue(
      new ConnectError("offline", Code.Unavailable),
    );
    expect((await routeAuctionStart({ ports: p, user })).screen).toEqual({
      kind: "unavailable",
    });
  });
});

describe("routeAuctionCallback", () => {
  it("wraps the shared body into the entry screen for a public participant", async () => {
    const outcome = await routeAuctionCallback({
      ports: ports(identity({ globalRoles: ["public"] })),
      user,
      data: lotButton,
    });
    expect(outcome.screen).toMatchObject({
      kind: "auction",
      body: { blocks: [{ kind: "lot", lotId }] },
    });
    expect(outcome.identityId).toBe("01926f3c-8b7a-7cde-8f00-00000000000a");
    expect(outcome.viewer).toEqual({
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      globalRoles: ["public"],
    });
  });

  it("denies a person without the public role before calling Auction", async () => {
    const p = ports(identity({ globalRoles: [] }));
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "denied", reason: "not-admitted" });
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it("gives the blocked person a refusal of its own", async () => {
    const outcome = await routeAuctionCallback({
      ports: ports(identity({ blocked: true })),
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "denied", reason: "blocked" });
  });

  it.each([
    ["a foreign button", "v1:meetup:x"],
    ["an outdated version", "v9:auc:lot:x"],
    ["a malformed button", "v1:auc:lot:"],
    // Страница с ведущим нулём — не та строка, что пишет кодировщик.
    ["a page button in a foreign spelling", `${feedButton.slice(0, -1)}01`],
  ])(
    "answers %s with the outdated screen without calling neighbours",
    async (_name, data) => {
      const p = ports(new Error("Identity must not be called"));
      const outcome = await routeAuctionCallback({ ports: p, user, data });
      expect(outcome).toEqual({ screen: { kind: "outdated" } });
      expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Identity is unavailable", async () => {
    const failure = new Error("connect ECONNREFUSED");
    const p = ports(failure);
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome).toEqual({
      screen: { kind: "unavailable" },
      failure: { category: "unexpected", message: "connect ECONNREFUSED" },
    });
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it("answers unavailable when Auction refuses the read", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.auction.getLot).mockRejectedValueOnce(
      new ConnectError("not implemented", Code.Unimplemented),
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "unavailable" });
    expect(outcome.identityId).toBeDefined();
    expect(outcome.failure).toMatchObject({
      category: "dependency_unavailable",
      grpcCode: "Unimplemented",
    });
  });

  // Критерий PER-306: недоступный Auction — именованный экран, а не пустая
  // лента.
  it("answers unavailable, not an empty feed, when Auction refuses the list", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.auction.listAuctionLots).mockRejectedValueOnce(
      new ConnectError("not implemented", Code.Unimplemented),
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: feedButton,
    });
    expect(outcome.screen).toEqual({ kind: "unavailable" });
    expect(outcome.identityId).toBe("01926f3c-8b7a-7cde-8f00-00000000000a");
    expect(outcome.failure).toMatchObject({ grpcCode: "Unimplemented" });
  });

  it("classifies an expired deadline as a timeout", async () => {
    const outcome = await routeAuctionCallback({
      ports: ports(new ConnectError("deadline", Code.DeadlineExceeded)),
      user,
      data: lotButton,
    });
    expect(outcome.failure?.category).toBe("timeout");
  });
});
