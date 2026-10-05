import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "./callback-data.js";
import {
  type AuctionDenial,
  type AuctionSurface,
  decideEntry,
  handleAuctionUpdate,
  requestedRole,
} from "./gateway.js";
import type {
  GlobalRole,
  LotView,
  ResolvedIdentity,
  RoleRequestOutcome,
} from "./ports.js";

const LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
  auctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
  version: 1,
  status: { kind: "withdrawn" },
};
const LOT_BUTTON = encodeAuctionCallback({
  kind: "lot",
  lotId: LOT.lotId,
  page: 0,
});

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
        async listAuctionLots() {
          calls.auction += 1;
          return { lots: [LOT], nextPageToken: "" };
        },
        async listLotHistory() {
          calls.auction += 1;
          return { entries: [], nextPageToken: "" };
        },
        async getDisplayNames() {
          calls.auction += 1;
          return {};
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

  // Кнопка хаба не аукционное действие: её получает обратно приложение, даже
  // если аукцион этого человека не пускает или он заблокирован.
  it.each<[AuctionSurface["kind"], GlobalRole[], boolean]>([
    ["hub", ["public"], false],
    ["hub", [], true],
    ["auction", [], false],
  ])(
    "returns a foreign button on %s to the app before the policy (%j, blocked %s)",
    async (kind, roles, blocked) => {
      const { press, calls } = surfaceFor(kind, {
        globalRoles: roles,
        blocked,
      });
      const result = await press("v1:nav:hub");
      expect(result.kind).toBe("unreadable");
      if (result.kind !== "unreadable") return;
      expect(result.error.reason).toBe("foreign");
      expect(calls.auction).toBe(0);
    },
  );

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

describe("surface entry on /start", () => {
  const IDENTITY_ID = "01929b7e-0000-7000-8000-000000000001";

  it("requests the circle of the surface", () => {
    expect(requestedRole("hub")).toBe("member");
    expect(requestedRole("auction")).toBe("public");
  });

  it.each<[AuctionSurface["kind"], GlobalRole[], RoleRequestOutcome]>([
    ["hub", ["member", "public"], "already-held"],
    ["hub", ["admin"], "already-held"],
    ["hub", ["member", "public"], "granted-by-allowlist"],
    ["auction", ["public"], "already-held"],
    ["auction", ["public"], "granted-by-allowlist"],
  ])("enters %s with %j on %s", (kind, globalRoles, outcome) => {
    expect(
      decideEntry(kind, { identityId: IDENTITY_ID, globalRoles, outcome }),
    ).toEqual({
      kind: "entered",
      identity: { identityId: IDENTITY_ID, globalRoles, blocked: false },
    });
  });

  it.each<[RoleRequestOutcome, GlobalRole[], AuctionDenial]>([
    ["pending", [], "not-admitted"],
    // Заявка в хаб не отнимает аукцион: `public` при ней остаётся.
    ["pending", ["public"], "not-admitted"],
    ["declined", ["public"], "declined"],
    ["blocked", [], "blocked"],
  ])("denies on %s with %j as %s", (outcome, globalRoles, reason) => {
    expect(
      decideEntry("hub", { identityId: IDENTITY_ID, globalRoles, outcome }),
    ).toEqual({ kind: "denied", reason, identityId: IDENTITY_ID });
  });

  // Identity считает круг по вложенности, поверхность — по плоскому набору:
  // вход не пускает того, кому отказало бы следующее нажатие.
  it("denies a held circle the surface table does not admit", () => {
    expect(
      decideEntry("auction", {
        identityId: IDENTITY_ID,
        globalRoles: ["admin"],
        outcome: "already-held",
      }),
    ).toEqual({
      kind: "denied",
      reason: "not-admitted",
      identityId: IDENTITY_ID,
    });
  });

  it("does not enter on an outcome it does not know, whatever the roles", () => {
    expect(
      decideEntry("hub", {
        identityId: IDENTITY_ID,
        globalRoles: ["member", "public"],
        outcome: "unspecified",
      }),
    ).toEqual({ kind: "unknown-outcome", identityId: IDENTITY_ID });
  });
});
