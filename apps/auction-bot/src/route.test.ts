import {
  type AuctionBotPorts,
  encodeAuctionCallback,
  type ResolvedIdentity,
} from "@solguficky/auction-bot-ui";
import { describe, expect, it, vi } from "vitest";
import { routeAuctionCallback } from "./route.js";

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

function ports(resolved: ResolvedIdentity | Error): AuctionBotPorts {
  return {
    identity: {
      resolveIdentity: vi.fn(async () => {
        if (resolved instanceof Error) throw resolved;
        return resolved;
      }),
    },
    auction: {
      getLot: vi.fn(async () => ({ lotId, auctionId, version: 3 })),
    },
  };
}

const lotButton = encodeAuctionCallback({ kind: "lot", lotId });

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
  ])("answers %s with the outdated screen", async (_name, data) => {
    const outcome = await routeAuctionCallback({
      ports: ports(identity({ globalRoles: ["public"] })),
      user,
      data,
    });
    expect(outcome.screen).toEqual({ kind: "outdated" });
  });

  it("fails closed when Identity is unavailable", async () => {
    const failure = new Error("connect ECONNREFUSED");
    const p = ports(failure);
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome).toEqual({ screen: { kind: "unavailable" }, failure });
    expect(p.auction.getLot).not.toHaveBeenCalled();
  });

  it("answers unavailable when Auction refuses the read", async () => {
    const p = ports(identity({ globalRoles: ["public"] }));
    vi.mocked(p.auction.getLot).mockRejectedValueOnce(
      new Error("UNIMPLEMENTED"),
    );
    const outcome = await routeAuctionCallback({
      ports: p,
      user,
      data: lotButton,
    });
    expect(outcome.screen).toEqual({ kind: "unavailable" });
    expect(outcome.identityId).toBeDefined();
  });
});
