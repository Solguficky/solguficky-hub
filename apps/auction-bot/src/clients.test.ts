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
