import { describe, expect, it, vi } from "vitest";
import { GlobalRole } from "../gen/identity/v1/roles_pb.js";
import {
  type AuctionRpc,
  createPorts,
  type IdentityRpc,
  requestIdHeader,
} from "./clients.js";

function rpcs() {
  const identity = {
    resolveIdentity: vi.fn(async () => ({
      identityId: "id-1",
      globalRoles: [
        GlobalRole.PUBLIC,
        GlobalRole.UNSPECIFIED,
        GlobalRole.MEMBER,
      ],
      blocked: false,
    })),
  };
  const auction = {
    getFaqAcknowledgement: vi.fn(async () => ({ acknowledged: false })),
    acknowledgeFaq: vi.fn(async () => ({ acknowledged: true })),
    getLot: vi.fn(async () => ({
      id: "lot-1",
      auctionId: "auc-1",
      version: 7n,
    })),
  };
  return {
    identity,
    auction,
    ports: createPorts(
      identity as unknown as IdentityRpc,
      auction as unknown as AuctionRpc,
      1_000,
    )("req-1"),
  };
}

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
        { viewer: { identityId: "id-1", globalRoles: [GlobalRole.PUBLIC] } },
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

  it("sends the viewer to Auction and maps the snapshot", async () => {
    const { auction, ports } = rpcs();
    const lot = await ports.auction.getLot({
      viewer: { identityId: "id-1", globalRoles: ["public"] },
      lotId: "lot-1",
    });
    expect(lot).toEqual({ lotId: "lot-1", auctionId: "auc-1", version: 7 });
    expect(auction.getLot).toHaveBeenCalledWith(
      {
        viewer: { identityId: "id-1", globalRoles: [GlobalRole.PUBLIC] },
        lotId: "lot-1",
      },
      { timeoutMs: 1_000, headers: { [requestIdHeader]: "req-1" } },
    );
  });
});
