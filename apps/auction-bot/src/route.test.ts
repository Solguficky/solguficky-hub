import { Code, ConnectError } from "@connectrpc/connect";
import {
  encodeAuctionCallback,
  type ResolvedIdentity,
  type RoleRequestAnswer,
} from "@solguficky/auction-bot-ui";
import { describe, expect, it, vi } from "vitest";
import type { EntryPorts } from "./entry-ports.js";
import { entryCallback } from "./faq.js";
import { routeAuctionCallback, routeAuctionStart } from "./route.js";

const lotId = "01926f3c-8b7a-7cde-8f00-0123456789ab";
const auctionId = "01926f3c-8b7a-7cde-8f00-0123456789ac";
const user = { telegramUserId: 42 };
const firstName = "Сова";

function identity(overrides: Partial<ResolvedIdentity>): ResolvedIdentity {
  return {
    identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
    globalRoles: [],
    blocked: false,
    ...overrides,
  };
}

// Что вход ответил бы человеку с такой личностью: заблокированному —
// `blocked`, с ролью `public` — что она уже есть, остальным — заявку.
function entered(resolved: ResolvedIdentity): RoleRequestAnswer {
  return {
    identityId: resolved.identityId,
    globalRoles: resolved.blocked ? [] : resolved.globalRoles,
    outcome: resolved.blocked
      ? "blocked"
      : resolved.globalRoles.includes("public")
        ? "already-held"
        : "pending",
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
    entry: {
      requestRole: vi.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return entered(resolved);
      }),
    },
    auction: {
      getLot: vi.fn(async () => ({
        lotId,
        auctionId,
        version: 3,
        proxyEnabled: false,
        status: { kind: "unsold" as const },
      })),
      listAuctionLots: vi.fn(async () => ({ lots: [], nextPageToken: "" })),
      listLotHistory: vi.fn(async () => ({ entries: [], nextPageToken: "" })),
      getDisplayNames: vi.fn(async () => ({})),
      placeBid: vi.fn(async () => ({ kind: "accepted" as const })),
      setProxyLimit: vi.fn(async () => ({ kind: "accepted" as const })),
      chooseDisplayName: vi.fn(async () => ({
        kind: "accepted" as const,
        name: "@owl",
      })),
    },
    operations: {
      newOperationId: vi.fn(() => "01929b7e-5c1d-7a3f-8e4b-00000000c001"),
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
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "denied",
      reason: "not-admitted",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
    vi.mocked(p.entry.requestRole).mockResolvedValue(
      entered(identity({ globalRoles: ["public"] })),
    );
    vi.mocked(p.faq.acknowledged).mockResolvedValue(false);
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
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
      expect(
        (await routeAuctionStart({ ports: p, user, firstName })).screen,
      ).toEqual({
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
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
      kind: "faq",
    });
    expect(p.faq.acknowledge).not.toHaveBeenCalled();
    expect(p.auction.getLot).not.toHaveBeenCalled();
    // Вход заменяет разрешение личности: Identity спрошен один раз.
    expect(p.entry.requestRole).toHaveBeenCalledTimes(1);
    expect(p.identity.resolveIdentity).not.toHaveBeenCalled();
  });

  it("shows the menu to a returning participant without an auction id", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
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
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({
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

describe("routeAuctionStart", () => {
  it("requests the public circle with the channel code and the first name", async () => {
    const p = ports(identity({ globalRoles: [] }));
    const outcome = await routeAuctionStart({
      ports: p,
      user: { telegramUserId: 42, telegramUsername: "owl" },
      firstName,
      sourceCode: "chat",
    });
    expect(p.entry.requestRole).toHaveBeenCalledExactlyOnceWith({
      user: { telegramUserId: 42, telegramUsername: "owl" },
      requestedRole: "public",
      sourceCode: "chat",
      firstName,
    });
    expect(outcome).toEqual({
      screen: { kind: "denied", reason: "not-admitted" },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  // Присутствие кода значимо: пустой код после `s_` едет пустой строкой, а
  // payload без префикса поля не несёт.
  it.each([
    ["", { sourceCode: "" }],
    [undefined, {}],
  ])("passes the channel code %j as received", async (sourceCode, expected) => {
    const p = ports(identity({ globalRoles: [] }));
    await routeAuctionStart({
      ports: p,
      user,
      firstName,
      ...(sourceCode === undefined ? {} : { sourceCode }),
    });
    expect(p.entry.requestRole).toHaveBeenCalledExactlyOnceWith({
      user,
      requestedRole: "public",
      firstName,
      ...expected,
    });
  });

  it("opens the entry for a person the allowlist has just admitted", async () => {
    const p = ports(identity({ globalRoles: [] }));
    vi.mocked(p.entry.requestRole).mockResolvedValue({
      ...entered(identity({ globalRoles: ["public"] })),
      outcome: "granted-by-allowlist",
    });
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({ kind: "menu" });
  });

  it("answers a declined application with a refusal of its own", async () => {
    const p = ports(identity({ globalRoles: [] }));
    vi.mocked(p.entry.requestRole).mockResolvedValue({
      ...entered(identity({ globalRoles: [] })),
      outcome: "declined",
    });
    expect(
      (await routeAuctionStart({ ports: p, user, firstName })).screen,
    ).toEqual({ kind: "denied", reason: "declined" });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it("fails closed on an outcome it does not know, whatever the roles", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.entry.requestRole).mockResolvedValue({
      ...entered(identity({ globalRoles: ["public"] })),
      outcome: "unspecified",
    });
    expect(await routeAuctionStart({ ports: p, user, firstName })).toEqual({
      screen: { kind: "unavailable" },
      identityId: "01926f3c-8b7a-7cde-8f00-00000000000a",
      failure: {
        category: "invariant",
        message: "identity answered an unknown role request outcome",
      },
    });
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });

  it("fails closed when the entry is unavailable", async () => {
    const p = ports(new ConnectError("offline", Code.Unavailable));
    const outcome = await routeAuctionStart({ ports: p, user, firstName });
    expect(outcome.screen).toEqual({ kind: "unavailable" });
    expect(outcome.failure?.category).toBe("dependency_unavailable");
    expect(p.faq.acknowledged).not.toHaveBeenCalled();
  });
});
