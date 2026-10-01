import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "./callback-data.js";
import { type AuctionSurface, handleAuctionUpdate } from "./gateway.js";
import type { GlobalRole, LotView, ResolvedIdentity } from "./ports.js";

const LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
  auctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
  version: 1,
};
const LOT_BUTTON = encodeAuctionCallback({ kind: "lot", lotId: LOT.lotId });

function surfaceFor(
  kind: AuctionSurface["kind"],
  roles: Omit<ResolvedIdentity, "identityId">,
) {
  const identity: ResolvedIdentity = {
    identityId: "01929b7e-0000-7000-8000-000000000001",
    ...roles,
  };
  const calls = { identity: 0, auction: 0 };
  const surface: AuctionSurface = {
    kind,
    ports: {
      identity: {
        async resolveIdentity() {
          calls.identity += 1;
          return identity;
        },
      },
      auction: {
        async getLot() {
          calls.auction += 1;
          return LOT;
        },
      },
    },
  };
  const press = (data: string) =>
    handleAuctionUpdate(surface, {
      identity,
      input: { kind: "callback", data },
    });
  return { press, calls };
}

describe("handleAuctionUpdate gateway", () => {
  it.each<[AuctionSurface["kind"], GlobalRole[]]>([
    ["hub", ["member", "public"]],
    ["hub", ["admin"]],
    ["hub", ["maintainer"]],
    ["auction", ["public"]],
    ["auction", ["member", "public"]],
  ])("admits %s with %j without calling Identity", async (kind, roles) => {
    const { press, calls } = surfaceFor(kind, {
      globalRoles: roles,
      blocked: false,
    });
    const result = await press(LOT_BUTTON);
    expect(result.kind).toBe("screen");
    // Личность пришла в update: шлюз её не перечитывает.
    expect(calls).toEqual({ identity: 0, auction: 1 });
  });

  it.each<[AuctionSurface["kind"], GlobalRole[]]>([
    ["hub", ["public"]],
    ["hub", []],
    ["auction", []],
  ])("denies %s with %j before any Auction call", async (kind, roles) => {
    const { press, calls } = surfaceFor(kind, {
      globalRoles: roles,
      blocked: false,
    });
    expect(await press(LOT_BUTTON)).toEqual({
      kind: "denied",
      reason: "not-admitted",
    });
    expect(calls.auction).toBe(0);
  });

  it.each<AuctionSurface["kind"]>(["hub", "auction"])(
    "gives the blocked on %s a refusal distinct from no roles",
    async (kind) => {
      const { press, calls } = surfaceFor(kind, {
        globalRoles: [],
        blocked: true,
      });
      expect(await press(LOT_BUTTON)).toEqual({
        kind: "denied",
        reason: "blocked",
      });
      expect(calls.auction).toBe(0);
    },
  );

  it("refuses the blocked even on an unreadable button", async () => {
    const { press } = surfaceFor("auction", {
      globalRoles: [],
      blocked: true,
    });
    expect(await press("garbage")).toEqual({
      kind: "denied",
      reason: "blocked",
    });
  });

  it("answers an unreadable button with the named error and no Auction call", async () => {
    const { press, calls } = surfaceFor("hub", {
      globalRoles: ["member"],
      blocked: false,
    });
    const result = await press("v1:nav:hub");
    expect(result.kind).toBe("unreadable");
    if (result.kind !== "unreadable") return;
    expect(result.error.name).toBe("AuctionCallbackError");
    expect(result.error.reason).toBe("foreign");
    expect(calls.auction).toBe(0);
  });
});
