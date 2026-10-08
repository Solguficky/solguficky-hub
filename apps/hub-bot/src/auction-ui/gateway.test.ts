import { describe, expect, it } from "vitest";
import { encodeAuctionCallback } from "./callback-data.js";
import {
  type AuctionDenial,
  type AuctionSurface,
  admission,
  applicationQueue,
  decideEntry,
  handleAuctionUpdate,
} from "./gateway.js";
import type {
  AccessRight,
  LotView,
  ResolvedIdentity,
  RoleRequestOutcome,
  Viewer,
} from "./ports.js";

const LOT: LotView = {
  lotId: "01929b7e-5c1d-7a3f-8e4b-2d6c9f0a1b3c",
  auctionId: "01929b7e-5c1d-7a3f-8e4b-0000000000a1",
  version: 1,
  proxyEnabled: false,
  status: { kind: "withdrawn" },
};
// Роли едут транзитом в Auction: шлюз их не читает, поэтому у всех строк ниже
// они одни и те же, а различаются права.
const VIEWER: Viewer = {
  identityId: "01929b7e-0000-7000-8000-000000000001",
  globalRoles: ["member", "public"],
};
const MEMBER: AccessRight[] = ["hub", "auction"];
const ADMIN: AccessRight[] = [
  "hub",
  "auction",
  "manage-membership",
  "moderate-auction",
  "manage-auction",
];
const LOT_BUTTON = encodeAuctionCallback({
  kind: "lot",
  lotId: LOT.lotId,
  page: 0,
});

function surfaceFor(
  kind: AuctionSurface["kind"],
  access: Omit<ResolvedIdentity, "viewer">,
) {
  const identity: ResolvedIdentity = { viewer: VIEWER, ...access };
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
        async placeBid() {
          calls.auction += 1;
          return { kind: "accepted" };
        },
        async setProxyLimit() {
          calls.auction += 1;
          return { kind: "accepted" };
        },
        async chooseDisplayName() {
          calls.auction += 1;
          return { kind: "accepted", name: "@owl" };
        },
      },
      operations: {
        newOperationId() {
          return "01929b7e-5c1d-7a3f-8e4b-00000000c001";
        },
      },
    },
  };
  const press = (data: string) =>
    handleAuctionUpdate(surface, {
      identity,
      user: { telegramUserId: 424242 },
      input: { kind: "callback", data },
    });
  return { press, calls, surface, identity };
}

describe("handleAuctionUpdate gateway", () => {
  // Ответ на вопрос — такое же действие аукциона, как нажатие: человек, которого
  // поверхность не пускает, до Auction не доходит и с ответом.
  it("denies an answer to a question to a person the surface does not admit", async () => {
    const { surface, calls, identity } = surfaceFor("auction", {
      rights: [],
      blocked: false,
    });
    const result = await handleAuctionUpdate(surface, {
      identity,
      user: { telegramUserId: 424242 },
      input: {
        kind: "reply",
        data: encodeAuctionCallback({
          kind: "question",
          question: "bid",
          lotId: LOT.lotId,
          page: 0,
          addressee: 424242,
        }),
        text: "1300",
      },
    });
    expect(result).toEqual({ kind: "denied", reason: "not-admitted" });
    expect(calls.auction).toBe(0);
  });

  it.each<[AuctionSurface["kind"], AccessRight[]]>([
    ["hub", MEMBER],
    ["hub", ADMIN],
    ["hub", ["hub"]],
    ["auction", ["auction"]],
    // Право модерации не делает гостя участником: бот аукциона его пускает.
    ["auction", ["auction", "moderate-auction"]],
  ])("admits %s with %j without calling Identity", async (kind, rights) => {
    const { press, calls } = surfaceFor(kind, { rights, blocked: false });
    const result = await press(LOT_BUTTON);
    expect(result.kind).toBe("screen");
    // Личность пришла в update: шлюз её не перечитывает.
    expect(calls).toEqual({ identity: 0, auction: 1 });
  });

  it.each<[AuctionSurface["kind"], AccessRight[]]>([
    ["hub", ["auction"]],
    ["hub", ["auction", "moderate-auction"]],
    ["hub", []],
    ["auction", []],
    ["auction", ["moderate-auction"]],
  ])("denies %s with %j before any Auction call", async (kind, rights) => {
    const { press, calls } = surfaceFor(kind, { rights, blocked: false });
    expect(await press(LOT_BUTTON)).toEqual({
      kind: "denied",
      reason: "not-admitted",
    });
    expect(calls.auction).toBe(0);
  });

  // Участник и администратор в боте аукциона получают переход в бот хаба: и
  // подделанная кнопка `auc` до Auction не доходит (ADR-064, пункт 2).
  it.each<[string, AccessRight[]]>([
    ["a member", MEMBER],
    ["an admin", ADMIN],
    ["a hub right alone", ["hub"]],
  ])("sends %s from the auction bot to the hub bot", async (_name, rights) => {
    const { press, calls } = surfaceFor("auction", { rights, blocked: false });
    expect(await press(LOT_BUTTON)).toEqual({
      kind: "denied",
      reason: "in-community",
    });
    expect(await press("garbage")).toEqual({
      kind: "denied",
      reason: "in-community",
    });
    expect(calls.auction).toBe(0);
  });

  it.each<AuctionSurface["kind"]>(["hub", "auction"])(
    "gives the blocked on %s a refusal distinct from no rights",
    async (kind) => {
      const { press, calls } = surfaceFor(kind, {
        rights: [],
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
      rights: [],
      blocked: true,
    });
    expect(await press("garbage")).toEqual({
      kind: "denied",
      reason: "blocked",
    });
  });

  // Кнопка хаба не аукционное действие: её получает обратно приложение, даже
  // если аукцион этого человека не пускает или он заблокирован.
  it.each<[AuctionSurface["kind"], AccessRight[], boolean]>([
    ["hub", ["auction"], false],
    ["hub", [], true],
    ["auction", [], false],
    ["auction", MEMBER, false],
  ])(
    "returns a foreign button on %s to the app before the policy (%j, blocked %s)",
    async (kind, rights, blocked) => {
      const { press, calls } = surfaceFor(kind, { rights, blocked });
      const result = await press("v1:nav:hub");
      expect(result.kind).toBe("unreadable");
      if (result.kind !== "unreadable") return;
      expect(result.error.reason).toBe("foreign");
      expect(calls.auction).toBe(0);
    },
  );

  it("answers an unreadable button with the named error and no Auction call", async () => {
    const { press, calls } = surfaceFor("hub", {
      rights: MEMBER,
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

describe("admission", () => {
  // Ту же политику поверхность повторяет на своих экранах: отметка блокировки
  // выбирает отказ раньше прав.
  it("refuses the blocked before reading the rights", () => {
    expect(admission("auction", { rights: MEMBER, blocked: true })).toBe(
      "blocked",
    );
    expect(admission("hub", { rights: MEMBER, blocked: true })).toBe("blocked");
  });

  it("never sends a hub visitor elsewhere", () => {
    expect(admission("hub", { rights: [], blocked: false })).toBe(
      "not-admitted",
    );
    expect(admission("hub", { rights: MEMBER, blocked: false })).toBe(
      undefined,
    );
  });
});

describe("surface entry on /start", () => {
  const IDENTITY_ID = VIEWER.identityId;

  it("applies to the queue of the surface", () => {
    expect(applicationQueue("hub")).toBe("community");
    expect(applicationQueue("auction")).toBe("auction");
  });

  it.each<[AuctionSurface["kind"], AccessRight[], RoleRequestOutcome]>([
    ["hub", MEMBER, "already-held"],
    ["hub", ADMIN, "already-held"],
    ["hub", MEMBER, "granted-by-allowlist"],
    ["auction", ["auction"], "already-held"],
    ["auction", ["auction"], "granted-by-allowlist"],
  ])("enters %s with %j on %s", (kind, rights, outcome) => {
    expect(decideEntry(kind, { viewer: VIEWER, rights, outcome })).toEqual({
      kind: "entered",
      identity: { viewer: VIEWER, rights, blocked: false },
    });
  });

  it.each<[RoleRequestOutcome, AccessRight[], AuctionDenial]>([
    ["pending", [], "not-admitted"],
    // Заявка в хаб не отнимает аукцион: право аукциона при ней остаётся.
    ["pending", ["auction"], "not-admitted"],
    ["declined", ["auction"], "declined"],
    ["blocked", [], "blocked"],
  ])("denies the hub on %s with %j as %s", (outcome, rights, reason) => {
    expect(decideEntry("hub", { viewer: VIEWER, rights, outcome })).toEqual({
      kind: "denied",
      reason,
      identityId: IDENTITY_ID,
    });
  });

  // Участнику бот аукциона отвечает переходом при любом исходе очереди
  // аукциона, кроме блокировки и незнакомого исхода.
  it.each<[RoleRequestOutcome, AccessRight[]]>([
    ["already-held", MEMBER],
    ["already-held", ADMIN],
    ["granted-by-allowlist", MEMBER],
    ["pending", ["hub"]],
    ["declined", MEMBER],
  ])(
    "sends %s with %j from the auction bot to the hub bot",
    (outcome, rights) => {
      expect(
        decideEntry("auction", { viewer: VIEWER, rights, outcome }),
      ).toEqual({
        kind: "denied",
        reason: "in-community",
        identityId: IDENTITY_ID,
      });
    },
  );

  it("refuses the blocked on the auction bot whatever the rights say", () => {
    expect(
      decideEntry("auction", {
        viewer: VIEWER,
        rights: [],
        outcome: "blocked",
      }),
    ).toEqual({ kind: "denied", reason: "blocked", identityId: IDENTITY_ID });
  });

  // Исход говорит об очереди, а пускает право: вход не пускает того, кому
  // отказало бы следующее нажатие.
  it("denies a held outcome without the right the surface admits by", () => {
    expect(
      decideEntry("auction", {
        viewer: VIEWER,
        rights: [],
        outcome: "already-held",
      }),
    ).toEqual({
      kind: "denied",
      reason: "not-admitted",
      identityId: IDENTITY_ID,
    });
  });

  it("does not enter on an outcome it does not know, whatever the rights", () => {
    expect(
      decideEntry("hub", {
        viewer: VIEWER,
        rights: MEMBER,
        outcome: "unspecified",
      }),
    ).toEqual({ kind: "unknown-outcome", identityId: IDENTITY_ID });
  });
});
