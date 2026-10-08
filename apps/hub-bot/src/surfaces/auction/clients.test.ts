import { Code } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { BidSource } from "../../../gen/auction/v1/auction_pb.js";
import { RoleRequestOutcome } from "../../../gen/identity/v1/identity_service_pb.js";
import { GlobalRole } from "../../../gen/identity/v1/roles_pb.js";
import {
  type AuctionRpc,
  callTimeoutMs,
  createPorts,
  type IdentityRpc,
  imageTimeoutMs,
  requestIdHeader,
} from "./clients.js";

function rpcs() {
  const identity = {
    resolveIdentity: vi.fn(async () => ({
      identityId: "id-1",
      globalRoles: [
        GlobalRole.GUEST,
        GlobalRole.UNSPECIFIED,
        GlobalRole.MEMBER,
      ],
      blocked: false,
    })),
    requestRole: vi.fn(async () => ({
      identityId: "id-1",
      globalRoles: [GlobalRole.GUEST, GlobalRole.UNSPECIFIED],
      outcome: RoleRequestOutcome.GRANTED_BY_ALLOWLIST,
    })),
  };
  const snapshot = {
    id: "lot-1",
    auctionId: "auc-1",
    version: 7n,
    status: { case: "unsold", value: 1 },
  };
  const auction = {
    getFaqAcknowledgement: vi.fn(async () => ({ acknowledged: false })),
    acknowledgeFaq: vi.fn(async () => ({ acknowledged: true })),
    getLot: vi.fn(async () => snapshot),
    listAuctionLots: vi.fn(async () => ({
      lots: [snapshot],
      nextPageToken: "next",
    })),
    // Запись вида, которого бот не знает, стоит между ставками: так её
    // присылает Auction, добавивший новый вид.
    listLotHistory: vi.fn(async () => ({
      entries: [
        {
          sequence: 4n,
          occurredAt: "2026-10-03T16:04:00Z",
          kind: {
            case: "bid",
            value: {
              bidId: "b-1",
              participantId: "p-1",
              amount: { minorUnits: 150_000n, currency: "RUB" },
              origin: { case: "manual", value: { source: BidSource.FLOOR } },
            },
          },
        },
        { sequence: 5n, occurredAt: "2026-10-03T16:05:00Z", kind: {} },
        {
          sequence: 6n,
          occurredAt: "2026-10-03T16:05:00Z",
          kind: {
            case: "bid",
            value: {
              bidId: "b-2",
              participantId: "p-2",
              amount: { minorUnits: 160_000n, currency: "RUB" },
              origin: { case: "proxy", value: {} },
            },
          },
        },
      ],
      nextPageToken: "",
    })),
    getDisplayNames: vi.fn(async () => ({
      names: { "p-1": { text: "@owl", kind: 1 } },
    })),
    getLotImage: vi.fn(async () => ({
      content: new Uint8Array([9]),
      mediaType: "image/jpeg",
      version: "v2",
    })),
  };
  const refused = vi.fn();
  return {
    identity,
    auction,
    refused,
    // Моки отвечают формой сгенерированных сообщений без их классов: это
    // единственное ослабление типа в тесте.
    ports: createPorts(
      identity as unknown as IdentityRpc,
      auction as unknown as AuctionRpc,
      { timeoutMs: 1_000, onNamesRefused: refused },
    )("req-1"),
  };
}

const viewer = { identityId: "id-1", globalRoles: ["public"] as const };
const wireViewer = { identityId: "id-1", globalRoles: [GlobalRole.GUEST] };
const callOptions = {
  timeoutMs: 1_000,
  headers: { [requestIdHeader]: "req-1" },
};

describe("createPorts", () => {
  it("does not treat an unconfirmed RPC response as saved completion", async () => {
    const { auction, ports } = rpcs();
    auction.acknowledgeFaq.mockResolvedValue({ acknowledged: false });
    await expect(
      ports.faq.acknowledge({ identityId: "id-1", globalRoles: ["public"] }),
    ).rejects.toThrow("did not acknowledge");
  });
  it("reads and records FAQ acknowledgement for the viewer with request metadata", async () => {
    const { auction, ports } = rpcs();
    const viewer = { identityId: "id-1", globalRoles: ["public"] as const };
    expect(await ports.faq.acknowledged(viewer)).toBe(false);
    await ports.faq.acknowledge(viewer);
    for (const rpc of [auction.getFaqAcknowledgement, auction.acknowledgeFaq]) {
      expect(rpc).toHaveBeenCalledWith(
        { viewer: { identityId: "id-1", globalRoles: [GlobalRole.GUEST] } },
        { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
      );
    }
  });
  it("maps the resolved identity and drops the unspecified role", async () => {
    const { identity, ports } = rpcs();
    const resolved = await ports.identity.resolveIdentity({
      telegramUserId: 42,
      telegramUsername: "nick",
    });
    expect(resolved).toEqual({
      identityId: "id-1",
      globalRoles: ["public", "member"],
      blocked: false,
    });
    expect(identity.resolveIdentity).toHaveBeenCalledWith(
      { telegramUserId: 42n, telegramUsername: "nick" },
      { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
    );
  });

  it("requests the circle on /start and maps the answer", async () => {
    const { identity, ports } = rpcs();
    const answer = await ports.entry.requestRole({
      user: { telegramUserId: 42, telegramUsername: "nick" },
      requestedRole: "public",
      sourceCode: "tg_ads",
      firstName: "Сова",
    });
    expect(answer).toEqual({
      identityId: "id-1",
      globalRoles: ["public"],
      outcome: "granted-by-allowlist",
    });
    expect(identity.requestRole).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: 42n,
        telegramUsername: "nick",
        requestedRole: GlobalRole.GUEST,
        sourceCode: "tg_ads",
        firstName: "Сова",
      },
      callOptions,
    );
  });

  // Присутствие кода значимо: пустой код едет пустой строкой, отсутствующий
  // поля в запросе не оставляет.
  it.each([
    ["", { sourceCode: "" }],
    [undefined, {}],
  ])("sends the channel code %j as received", async (sourceCode, expected) => {
    const { identity, ports } = rpcs();
    await ports.entry.requestRole({
      user: { telegramUserId: 42 },
      requestedRole: "public",
      ...(sourceCode === undefined ? {} : { sourceCode }),
      firstName: "Сова",
    });
    expect(identity.requestRole).toHaveBeenCalledExactlyOnceWith(
      {
        telegramUserId: 42n,
        requestedRole: GlobalRole.GUEST,
        firstName: "Сова",
        ...expected,
      },
      callOptions,
    );
  });

  it.each([
    [RoleRequestOutcome.ALREADY_HELD, "already-held"],
    [RoleRequestOutcome.GRANTED_BY_ALLOWLIST, "granted-by-allowlist"],
    [RoleRequestOutcome.PENDING, "pending"],
    [RoleRequestOutcome.DECLINED, "declined"],
    [RoleRequestOutcome.BLOCKED, "blocked"],
    [RoleRequestOutcome.UNSPECIFIED, "unspecified"],
    // Число, которого словарь ещё не знает, — отказ, а не допуск.
    [99 as RoleRequestOutcome, "unspecified"],
  ])("reads the outcome %s as %s", async (wire, outcome) => {
    const { identity, ports } = rpcs();
    identity.requestRole.mockResolvedValue({
      identityId: "id-1",
      globalRoles: [],
      outcome: wire,
    });
    const answer = await ports.entry.requestRole({
      user: { telegramUserId: 42 },
      requestedRole: "public",
      firstName: "Сова",
    });
    expect(answer.outcome).toBe(outcome);
  });

  it("sends the viewer to Auction and maps the snapshot", async () => {
    const { auction, ports } = rpcs();
    const lot = await ports.auction.getLot({
      viewer: { identityId: "id-1", globalRoles: ["public"] },
      lotId: "lot-1",
    });
    expect(lot).toEqual({
      lotId: "lot-1",
      auctionId: "auc-1",
      version: 7,
      proxyEnabled: false,
      status: { kind: "unsold" },
    });
    expect(auction.getLot).toHaveBeenCalledWith(
      {
        viewer: { identityId: "id-1", globalRoles: [GlobalRole.GUEST] },
        lotId: "lot-1",
      },
      { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
    );
  });

  it("pages the lots of an auction through the same viewer", async () => {
    const { auction, ports } = rpcs();
    const page = await ports.auction.listAuctionLots({
      viewer,
      auctionId: "auc-1",
      pageToken: "t",
    });
    expect(page.nextPageToken).toBe("next");
    expect(page.lots.map((lot) => lot.lotId)).toEqual(["lot-1"]);
    expect(auction.listAuctionLots).toHaveBeenCalledWith(
      { viewer: wireViewer, auctionId: "auc-1", pageToken: "t" },
      callOptions,
    );
  });

  it("reads the history of a lot and skips an entry of a kind it does not know", async () => {
    const { auction, ports } = rpcs();
    const page = await ports.auction.listLotHistory({
      viewer,
      lotId: "lot-1",
      pageToken: "",
    });
    expect(page).toEqual({
      entries: [
        {
          kind: "bid",
          sequence: 4,
          occurredAt: "2026-10-03T16:04:00Z",
          bidId: "b-1",
          participantId: "p-1",
          amount: { minorUnits: 150_000, currency: "RUB" },
          origin: { kind: "manual", source: "floor" },
        },
        {
          kind: "bid",
          sequence: 6,
          occurredAt: "2026-10-03T16:05:00Z",
          bidId: "b-2",
          participantId: "p-2",
          amount: { minorUnits: 160_000, currency: "RUB" },
          origin: { kind: "proxy" },
        },
      ],
      nextPageToken: "",
    });
    expect(auction.listLotHistory).toHaveBeenCalledWith(
      { viewer: wireViewer, lotId: "lot-1", pageToken: "" },
      callOptions,
    );
  });

  it("returns display names as ready text", async () => {
    const { ports } = rpcs();
    expect(
      await ports.auction.getDisplayNames({
        viewer,
        auctionId: "auc-1",
        participantIds: ["p-1"],
      }),
    ).toEqual({ "p-1": "@owl" });
  });

  // Пакет гасит отказ имён; без сообщения порта деградация была бы немой.
  it("reports a refused display name with the request id before throwing", async () => {
    const { auction, ports, refused } = rpcs();
    const cause = new Error("UNIMPLEMENTED");
    auction.getDisplayNames.mockRejectedValueOnce(cause);
    await expect(
      ports.auction.getDisplayNames({
        viewer,
        auctionId: "auc-1",
        participantIds: ["p-1"],
      }),
    ).rejects.toBe(cause);
    expect(refused).toHaveBeenCalledWith(cause, "req-1");
  });

  it("loads image bytes with the longer image timeout", async () => {
    const { auction, ports } = rpcs();
    const image = await ports.image.getLotImage({ viewer, lotId: "lot-1" });
    expect(image).toEqual({
      content: new Uint8Array([9]),
      mediaType: "image/jpeg",
      version: "v2",
    });
    expect(auction.getLotImage).toHaveBeenCalledWith(
      { viewer: wireViewer, lotId: "lot-1" },
      { timeoutMs: imageTimeoutMs, headers: { [requestIdHeader]: "req-1" } },
    );
  });
});

describe("action budget", () => {
  const now = 1_000_000;

  it("keeps the own deadline of a call without a budget", () => {
    expect(callTimeoutMs(undefined, 3_000, now)).toBe(3_000);
  });

  it("cuts the call deadline down to what is left of the budget", () => {
    expect(callTimeoutMs(now + 1_200, 3_000, now)).toBe(1_200);
    expect(callTimeoutMs(now + 4_000, 3_000, now)).toBe(3_000);
  });

  it("refuses the call as an expired deadline once the budget is spent", () => {
    expect(() => callTimeoutMs(now, 3_000, now)).toThrow(
      expect.objectContaining({ code: Code.DeadlineExceeded }),
    );
  });

  it("does not call a service after the budget is spent and cuts the image read", async () => {
    vi.useFakeTimers({ now });
    try {
      const { auction } = rpcs();
      const ports = createPorts(
        {} as IdentityRpc,
        auction as unknown as AuctionRpc,
      )("req-1", now + 800);
      await ports.image.getLotImage({ viewer, lotId: "lot-1" });
      expect(auction.getLotImage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeoutMs: 800 }),
      );
      vi.setSystemTime(now + 800);
      await expect(
        ports.auction.getLot({ viewer, lotId: "lot-1" }),
      ).rejects.toMatchObject({ code: Code.DeadlineExceeded });
      expect(auction.getLot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
